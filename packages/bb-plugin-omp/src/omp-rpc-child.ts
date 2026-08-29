import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import {
  experimental_readBoundedLines,
  experimental_recordProviderChildIo,
  sanitizeInheritedChildProcessEnv,
  withoutBridgeRuntimeEnv,
} from "@get-bb/plugin-sdk/provider-bridge";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const STDERR_TAIL_BYTES = 4_096;
const SIGTERM_GRACE_MS = 2_000;
const SIGKILL_GRACE_MS = 2_000;

export const OMP_BRIDGE_COMMAND_ENV = "BB_OMP_BRIDGE_COMMAND";
export const OMP_BRIDGE_ARGS_ENV = "BB_OMP_BRIDGE_ARGS";

export interface OmpRpcResponse {
  id?: string | number;
  type: "response";
  command?: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface OmpRpcChildExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderrTail: string;
  beforeFirstResponse: boolean;
}

export interface OmpLaunch {
  command: string;
  args: string[];
}

export interface SpawnOmpRpcChildArgs {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  recordThreadId: string | null;
  onEvent: (event: Record<string, unknown>) => void;
  /** Responses that arrive after the request's first response. */
  onUnmatchedResponse: (response: OmpRpcResponse) => void;
  onExit: (info: OmpRpcChildExitInfo) => void;
}

export class OmpRpcChildExitedError extends Error {
  readonly info: OmpRpcChildExitInfo;

  constructor(info: OmpRpcChildExitInfo) {
    super(
      `omp exited (code ${info.code ?? "null"}, signal ${info.signal ?? "null"})${
        info.stderrTail ? `: ${info.stderrTail.trim()}` : ""
      }`,
    );
    this.name = "OmpRpcChildExitedError";
    this.info = info;
  }
}

interface PendingRequest {
  resolve: (response: OmpRpcResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Parse the optional test/installation launch override without crashing import. */
export function parseOmpExtraArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env[OMP_BRIDGE_ARGS_ENV];
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${OMP_BRIDGE_ARGS_ENV} must be a JSON array of strings: ${String(error)}`);
  }
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
    throw new Error(`${OMP_BRIDGE_ARGS_ENV} must be a JSON array of strings`);
  }
  return [...parsed];
}

/** Candidates are ordered so an explicit override always wins. */
export function ompCommandCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = typeof env.HOME === "string" && env.HOME.length > 0
    ? `${env.HOME}/.local/bin/omp`
    : undefined;
  return [
    env[OMP_BRIDGE_COMMAND_ENV],
    "omp",
    home,
    "/opt/homebrew/bin/omp",
    "/usr/local/bin/omp",
  ].filter((value, index, values): value is string =>
    typeof value === "string" && value.length > 0 && values.indexOf(value) === index,
  );
}

export function resolveOmpLaunch(env: NodeJS.ProcessEnv = process.env): OmpLaunch {
  const candidates = ompCommandCandidates(env);
  const configured = env[OMP_BRIDGE_COMMAND_ENV];
  const command =
    configured ??
    candidates.find((candidate) => candidate === "omp" || existsSync(candidate)) ??
    candidates[0] ??
    "omp";
  return { command, args: parseOmpExtraArgs(env) };
}

/** Provider children may inherit user tools and API keys, but not BB runtime wiring. */
export function buildOmpChildEnv(
  overrides: Record<string, string> = {},
): NodeJS.ProcessEnv {
  return {
    ...withoutBridgeRuntimeEnv(
      sanitizeInheritedChildProcessEnv({ env: process.env }),
    ),
    ...overrides,
  };
}

export class OmpRpcChild {
  readonly child: ChildProcess;

  private readonly pending = new Map<string, PendingRequest>();
  private readonly readyPromise: Promise<void>;
  private resolveReady: (() => void) | undefined;
  private rejectReady: ((error: Error) => void) | undefined;
  private nextRequestId = 0;
  private stderrTail = "";
  private sawResponse = false;
  private exitInfo: OmpRpcChildExitInfo | null = null;
  private readonly exitedPromise: Promise<OmpRpcChildExitInfo>;
  private resolveExited: ((info: OmpRpcChildExitInfo) => void) | undefined;
  private observedExitCode: number | null | undefined;
  private observedExitSignal: NodeJS.Signals | null | undefined;
  private closeTimer: ReturnType<typeof setTimeout> | undefined;
  private killTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: SpawnOmpRpcChildArgs) {
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    void this.readyPromise.catch(() => undefined);
    this.exitedPromise = new Promise<OmpRpcChildExitInfo>((resolve) => {
      this.resolveExited = resolve;
    });

    this.child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    experimental_recordProviderChildIo(this.child, {
      threadId: options.recordThreadId,
    });
    this.child.stdin?.on("error", () => undefined);

    if (this.child.stdout) {
      experimental_readBoundedLines({
        input: this.child.stdout,
        onLine: (line) => this.queueStdoutLine(line),
        onOverflow: (bytes) => {
          process.stderr.write(`omp bridge: dropped a ${bytes}-byte stdout line\n`);
        },
      });
    }
    if (this.child.stderr) {
      this.child.stderr.on("data", (chunk: Buffer | string) => {
        const text = chunk.toString();
        this.stderrTail = `${this.stderrTail}${text}`.slice(-STDERR_TAIL_BYTES);
        process.stderr.write(`omp[${String(this.child.pid ?? "?")}]: ${text}`);
      });
    }

    const settleExit = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      if (this.exitInfo !== null) return;
      if (this.closeTimer) clearTimeout(this.closeTimer);
      if (this.killTimer) clearTimeout(this.killTimer);
      const info: OmpRpcChildExitInfo = {
        code,
        signal,
        stderrTail: this.stderrTail,
        beforeFirstResponse: !this.sawResponse,
      };
      this.exitInfo = info;
      this.rejectReady?.(new OmpRpcChildExitedError(info));
      this.resolveExited?.(info);
      for (const pending of this.pending.values()) {
        if (pending.timer) clearTimeout(pending.timer);
        pending.reject(new OmpRpcChildExitedError(info));
      }
      this.pending.clear();
      this.options.onExit(info);
    };

    this.child.on("error", (error) => {
      this.stderrTail = `${this.stderrTail}${error.message}`.slice(-STDERR_TAIL_BYTES);
      this.rejectReady?.(error);
    });
    this.child.on("exit", (code, signal) => {
      this.observedExitCode = code;
      this.observedExitSignal = signal;
    });
    // `exit` can precede the final stdout data event. Wait for `close`, which
    // follows stdio shutdown, before rejecting requests or invoking onExit so
    // the last complete RPC frames are delivered first.
    this.child.on("close", (code, signal) => settleExit(
      this.observedExitCode ?? code,
      this.observedExitSignal ?? signal,
    ));
  }

  get exited(): boolean {
    return this.exitInfo !== null;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  waitForExit(): Promise<OmpRpcChildExitInfo> {
    return this.exitedPromise;
  }

  async waitForReady(timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<void> {
    if (this.exitInfo) {
      throw new OmpRpcChildExitedError(this.exitInfo);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.readyPromise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("omp did not report ready in time")),
            timeoutMs,
          );
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  request(
    command: Record<string, unknown>,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<OmpRpcResponse> {
    if (this.exitInfo) {
      return Promise.reject(new OmpRpcChildExitedError(this.exitInfo));
    }
    this.nextRequestId += 1;
    const id = `bb-omp-${this.nextRequestId}`;
    return new Promise<OmpRpcResponse>((resolve, reject) => {
      const timer =
        timeoutMs === 0
          ? null
          : setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`omp did not answer ${String(command.type)} in time`));
            }, timeoutMs);
      timer?.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.writeStdin({ ...command, id });
    });
  }

  async requestOk(
    command: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    const response = await this.request(command, timeoutMs);
    if (!response.success) {
      throw new Error(response.error ?? `omp rejected ${String(command.type)}`);
    }
    return response.data;
  }

  closeGracefully(timeoutMs = 8_000): Promise<OmpRpcChildExitInfo> {
    if (this.exitInfo) return Promise.resolve(this.exitInfo);
    this.endStdin();
    this.closeTimer = setTimeout(() => {
      if (!this.exitInfo) this.kill();
    }, Math.max(1, Math.min(SIGTERM_GRACE_MS, timeoutMs)));
    this.closeTimer.unref?.();
    return this.waitForExit();
  }

  kill(): void {
    if (this.exitInfo) return;
    this.endStdin();
    try {
      this.child.kill("SIGTERM");
    } catch {
      // The child exited between the check and kill.
    }
    if (!this.killTimer) {
      this.killTimer = setTimeout(() => {
        if (!this.exitInfo) {
          try {
            this.child.kill("SIGKILL");
          } catch {
            // Already gone.
          }
        }
      }, SIGKILL_GRACE_MS);
      this.killTimer.unref?.();
    }
  }

  private endStdin(): void {
    try {
      this.child.stdin?.end();
    } catch {
      // Already closed.
    }
  }

  private writeStdin(message: Record<string, unknown>): void {
    const stdin = this.child.stdin;
    if (!stdin || stdin.destroyed || stdin.writableEnded) return;
    try {
      stdin.write(`${JSON.stringify(message)}\n`);
    } catch {
      // The exit handler will reject the pending request.
    }
  }

  private queueStdoutLine(line: string): void {
    // Deliver each complete frame synchronously. Node can emit a final stdout
    // chunk and `exit` in the same turn; deferring the queue with setImmediate
    // lets the exit handler settle and discard those frames first.
    this.handleStdoutLine(line);
  }

  private handleStdoutLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // RPC mode reserves stdout for JSON lines. Diagnostics go to stderr.
      return;
    }
    if (typeof parsed !== "object" || parsed === null) return;
    const message = parsed as Record<string, unknown>;
    if (message.type === "ready") {
      this.resolveReady?.();
      return;
    }
    if (message.type === "extension_ui_request") {
      // OMP's RPC UI is not the BB interaction channel. Headless full-mode
      // sessions auto-approve tools; any residual widget is cancelled.
      this.writeStdin({
        type: "extension_ui_response",
        id: message.id,
        cancelled: true,
      });
      return;
    }
    if (message.type === "response") {
      this.sawResponse = true;
      const id = typeof message.id === "string" || typeof message.id === "number"
        ? message.id
        : undefined;
      const pending = id === undefined ? undefined : this.pending.get(String(id));
      if (pending && id !== undefined) {
        this.pending.delete(String(id));
        if (pending.timer) clearTimeout(pending.timer);
        pending.resolve(message as unknown as OmpRpcResponse);
      } else {
        this.options.onUnmatchedResponse(message as unknown as OmpRpcResponse);
      }
      return;
    }
    if (typeof message.type === "string") {
      this.options.onEvent(message);
    }
  }
}
