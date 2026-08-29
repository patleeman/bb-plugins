import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  OmpRpcChild,
  type OmpRpcChildExitInfo,
  type OmpRpcResponse,
} from "./omp-rpc-child.js";

export interface OmpSessionState {
  model?: {
    provider?: string;
    id?: string;
    contextWindow?: number;
  };
  isStreaming: boolean;
  isCompacting: boolean;
  sessionFile?: string;
  sessionId?: string;
  contextUsage?: {
    tokens?: number | null;
    contextWindow?: number;
  };
}

export interface OmpSessionOptions {
  command: string;
  baseArgs: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  sessionDir: string;
  tempDir: string;
  recordThreadId: string;
  providerThreadId?: string;
  /** A bridge-validated session file. Never infer a resume path from an id. */
  resumePath?: string;
  model?: string;
  thinkingLevel?: string;
  instructions?: string;
  instructionMode?: "append" | "replace";
  autoApprove: boolean;
  onEvent: (event: Record<string, unknown>) => void;
  onUnmatchedResponse: (response: OmpRpcResponse) => void;
  onExit: (info: OmpRpcChildExitInfo) => void;
}

export class OmpRpcSession {
  private child: OmpRpcChild | undefined;
  private startingChild: OmpRpcChild | undefined;
  private state: OmpSessionState = {
    isStreaming: false,
    isCompacting: false,
  };
  private closed = false;
  private active = false;
  private promptFiles: string[] = [];
  private compactionCompletion:
    | {
        promise: Promise<Record<string, unknown>>;
        resolve: (event: Record<string, unknown>) => void;
        settled: boolean;
      }
    | undefined;

  constructor(private readonly options: OmpSessionOptions) {}

  get providerThreadId(): string | undefined {
    return this.state.sessionFile ?? this.options.providerThreadId;
  }

  get sessionFile(): string | undefined {
    return this.state.sessionFile;
  }

  get modelContextWindow(): number | null {
    const value = this.state.model?.contextWindow;
    return typeof value === "number" && Number.isFinite(value) && value > 0
      ? value
      : null;
  }

  get contextUsage(): OmpSessionState["contextUsage"] {
    return this.state.contextUsage;
  }

  get isActive(): boolean {
    return this.active || this.state.isStreaming || this.state.isCompacting;
  }

  async start(): Promise<OmpSessionState> {
    mkdirSync(this.options.sessionDir, { recursive: true });
    const child = this.spawnChild();
    this.startingChild = child;
    try {
      await child.waitForReady();
      const response = await child.request({ type: "get_state" });
      if (!response.success) {
        throw new Error(response.error ?? "omp failed to initialize");
      }
      this.state = normalizeState(response.data);
      if (this.closed || child.exited) {
        child.kill();
        throw new Error(this.closed ? "OMP session closed during startup" : "OMP exited during startup");
      }
      this.child = child;
      this.startingChild = undefined;
      return this.state;
    } catch (error) {
      this.startingChild = undefined;
      child.kill();
      await child.waitForExit().catch(() => undefined);
      throw error;
    }
  }

  async getState(): Promise<OmpSessionState> {
    const child = this.requireChild();
    const response = await child.request({ type: "get_state" });
    if (!response.success) {
      throw new Error(response.error ?? "omp failed to return state");
    }
    this.state = normalizeState(response.data);
    return this.state;
  }

  async prompt(text: string, images: readonly unknown[] = []): Promise<void> {
    const child = this.requireChild();
    this.active = true;
    try {
      const response = await child.request(
        {
          type: "prompt",
          message: text,
          ...(images.length > 0 ? { images: [...images] } : {}),
          streamingBehavior: "followUp",
        },
        0,
      );
      if (!response.success) {
        this.active = false;
        throw new Error(response.error ?? "omp rejected the prompt");
      }
      const data = asRecord(response.data);
      if (data?.agentInvoked === false) {
        this.active = false;
        this.state.isStreaming = false;
        this.state.isCompacting = false;
        this.options.onEvent({
          type: "prompt_result",
          ...(response.id === undefined ? {} : { id: response.id }),
          agentInvoked: false,
        });
      }
    } catch (error) {
      this.active = false;
      throw error;
    }
  }

  async steer(text: string, images: readonly unknown[] = []): Promise<void> {
    const child = this.requireChild();
    if (!this.isActive) {
      throw new Error("No active OMP turn");
    }
    const response = await child.request({
      type: "prompt",
      message: text,
      ...(images.length > 0 ? { images: [...images] } : {}),
      streamingBehavior: "steer",
    });
    if (!response.success) {
      throw new Error(response.error ?? "omp rejected the steer");
    }
  }

  async compact(): Promise<void> {
    const child = this.requireChild();
    if (this.isActive) {
      throw new Error("Cannot compact context while OMP is processing a turn");
    }
    this.active = true;
    this.state.isCompacting = true;
    const completion = deferredCompaction();
    this.compactionCompletion = completion;
    try {
      const state = await this.getState();
      if (state.isStreaming || state.isCompacting) {
        throw new Error("Cannot compact context while OMP is processing a turn");
      }
      const response = await child.request({ type: "compact" }, 10 * 60_000);
      if (!response.success && !completion.settled) {
        throw new Error(response.error ?? "omp rejected context compaction");
      }
      const terminal = await waitForCompaction(completion.promise, 10 * 60_000);
      const terminalError = compactionTerminalError(terminal);
      if (terminalError) throw new Error(terminalError);
    } finally {
      if (this.compactionCompletion === completion) this.compactionCompletion = undefined;
      this.active = false;
      this.state.isCompacting = false;
    }
  }

  async close(timeoutMs = 8_000): Promise<void> {
    this.closed = true;
    const child = this.child ?? this.startingChild;
    this.active = false;
    if (!child || child.exited) {
      this.removePromptFiles();
      return;
    }
    await child
      .request({ type: "abort" }, Math.max(1, Math.floor(timeoutMs / 2)))
      .catch(() => undefined);
    await child.closeGracefully(timeoutMs).catch(() => undefined);
    this.removePromptFiles();
  }

  kill(): void {
    this.closed = true;
    this.child?.kill();
    this.startingChild?.kill();
    this.removePromptFiles();
  }

  private spawnChild(): OmpRpcChild {
    const args = this.buildArgs();
    let child: OmpRpcChild;
    child = new OmpRpcChild({
      command: this.options.command,
      args,
      cwd: this.options.cwd,
      env: this.options.env,
      recordThreadId: this.options.recordThreadId,
      onEvent: (event) => {
        if (this.child === child || this.startingChild === child) {
          this.handleEvent(event);
        }
      },
      onUnmatchedResponse: (response) => {
        if (this.child === child || this.startingChild === child) {
          this.options.onUnmatchedResponse(response);
        }
      },
      onExit: (info) => {
        if (this.child === child || this.startingChild === child) {
          if (this.child === child) this.child = undefined;
          if (this.startingChild === child) this.startingChild = undefined;
          this.active = false;
          this.state.isStreaming = false;
          this.state.isCompacting = false;
          this.removePromptFiles();
          if (!this.closed && this.child === undefined) this.options.onExit(info);
        }
      },
    });
    return child;
  }

  private buildArgs(): string[] {
    const args = [
      ...this.options.baseArgs,
      "--mode",
      "rpc",
      "--cwd",
      this.options.cwd,
      "--session-dir",
      this.options.sessionDir,
    ];
    if (this.options.resumePath) {
      args.push("--resume", this.options.resumePath);
    }
    if (this.options.model) {
      args.push("--model", this.options.model);
    }
    if (this.options.thinkingLevel) {
      args.push("--thinking", this.options.thinkingLevel);
    }
    if (this.options.autoApprove) {
      args.push("--auto-approve", "--approval-mode", "yolo");
    }
    if (this.options.instructions !== undefined) {
      const fileName = `omp-instructions-${randomUUID()}.md`;
      const filePath = join(this.options.tempDir, fileName);
      mkdirSync(this.options.tempDir, { recursive: true });
      writeFileSync(filePath, this.options.instructions, "utf8");
      this.promptFiles.push(filePath);
      args.push(
        this.options.instructionMode === "replace"
          ? "--system-prompt"
          : "--append-system-prompt",
        filePath,
      );
    }
    return args;
  }

  private handleEvent(event: Record<string, unknown>): void {
    switch (event.type) {
      case "agent_start":
      case "compaction_start":
      case "auto_compaction_start":
        this.active = true;
        if (event.type !== "agent_start") this.state.isCompacting = true;
        break;
      case "agent_end":
      case "compaction_end":
      case "auto_compaction_end":
        this.active = false;
        if (event.type === "agent_end") {
          this.state.isStreaming = false;
        } else {
          this.state.isCompacting = false;
          const completion = this.compactionCompletion;
          if (completion && !completion.settled) {
            completion.settled = true;
            completion.resolve(event);
          }
        }
        break;
      case "prompt_result":
        if (event.agentInvoked === false) {
          this.active = false;
          this.state.isStreaming = false;
          this.state.isCompacting = false;
        }
        break;
      default:
        break;
    }
    this.options.onEvent(event);
  }

  private requireChild(): OmpRpcChild {
    if (!this.child || this.child.exited) {
      throw new Error("No active OMP session");
    }
    return this.child;
  }

  private removePromptFiles(): void {
    for (const file of this.promptFiles.splice(0)) {
      rmSync(file, { force: true });
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function deferredCompaction(): {
  promise: Promise<Record<string, unknown>>;
  resolve: (event: Record<string, unknown>) => void;
  settled: boolean;
} {
  let resolve: (event: Record<string, unknown>) => void = () => undefined;
  const promise = new Promise<Record<string, unknown>>((settle) => {
    resolve = settle;
  });
  return { promise, resolve, settled: false };
}

function compactionTerminalError(event: Record<string, unknown>): string | undefined {
  if (event.aborted === true || event.status === "aborted" || event.status === "interrupted") {
    return "OMP context compaction was interrupted";
  }
  const errorMessage = typeof event.errorMessage === "string"
    ? event.errorMessage.trim()
    : typeof event.error === "string" ? event.error.trim() : undefined;
  if (errorMessage && !isCompactionNoop(errorMessage)) return errorMessage;
  if (event.success === false || event.status === "failed" || event.status === "error") {
    return errorMessage || "OMP context compaction failed";
  }
  return undefined;
}

function isCompactionNoop(errorMessage: string): boolean {
  return new Set([
    "Compaction failed: Nothing to compact (session too small)",
    "Compaction failed: Already compacted",
  ]).has(errorMessage.trim());
}

async function waitForCompaction(
  promise: Promise<Record<string, unknown>>,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("OMP did not report context compaction completion")),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function normalizeState(value: unknown): OmpSessionState {
  const state = typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
  const model = typeof state.model === "object" && state.model !== null
    ? (state.model as Record<string, unknown>)
    : undefined;
  const contextUsage = typeof state.contextUsage === "object" && state.contextUsage !== null
    ? (state.contextUsage as Record<string, unknown>)
    : undefined;
  return {
    model: model
      ? {
          ...(typeof model.provider === "string" ? { provider: model.provider } : {}),
          ...(typeof model.id === "string" ? { id: model.id } : {}),
          ...(typeof model.contextWindow === "number"
            ? { contextWindow: model.contextWindow }
            : {}),
        }
      : undefined,
    isStreaming: state.isStreaming === true,
    isCompacting: state.isCompacting === true,
    ...(typeof state.sessionFile === "string" ? { sessionFile: state.sessionFile } : {}),
    ...(typeof state.sessionId === "string" ? { sessionId: state.sessionId } : {}),
    contextUsage: contextUsage
      ? {
          ...(typeof contextUsage.tokens === "number" || contextUsage.tokens === null
            ? { tokens: contextUsage.tokens }
            : {}),
          ...(typeof contextUsage.contextWindow === "number"
            ? { contextWindow: contextUsage.contextWindow }
            : {}),
        }
      : undefined,
  };
}
