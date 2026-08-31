// Process manager for ds4-server: spawn/stop lifecycle, ring-buffered log
// lines with monotonic sequence numbers (for tailing from an offset), and a
// state machine that the supervisor service uses to apply policy.

import { spawn, type ChildProcess } from "node:child_process";

export type ProcessState =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "exited"
  | "crashed";

export type ProcessOwnership = "managed" | "external";

export interface Ds4LogLine {
  seq: number;
  ts: number; // epoch ms
  stream: "stdout" | "stderr";
  text: string;
}

export interface StartOptions {
  bin: string;
  args: string[];
  cwd: string;
  onLine?: (line: Ds4LogLine) => void;
  onExit?: (code: number | null, signal: string | null) => void;
}

export interface ExitInfo {
  code: number | null;
  signal: string | null;
  at: number;
}

export interface StopOptions {
  terminateExternal?: boolean;
  /** Optional identity guard for childless adopted processes. */
  verifyPid?: (pid: number) => boolean;
}

export class Ds4Process {
  private child: ChildProcess | null = null;
  private _state: ProcessState = "stopped";
  private _pid: number | null = null;
  private _startedAt: number | null = null;
  private _exitInfo: ExitInfo | null = null;
  private _cmdline: string[] | null = null;
  private _cwd: string | null = null;
  private _ownership: ProcessOwnership = "managed";
  private adopted = false;
  private ring: Ds4LogLine[] = [];
  private seq = 0;
  private bufs: Record<"stdout" | "stderr", string> = { stdout: "", stderr: "" };
  private stopTimer: NodeJS.Timeout | null = null;

  private logLimit: number;
  constructor(logLimit = 5000) {
    this.logLimit = logLimit;
  }

  get state(): ProcessState {
    return this._state;
  }
  get pid(): number | null {
    return this._pid;
  }
  get startedAt(): number | null {
    return this._startedAt;
  }
  get cmdline(): string[] | null {
    return this._cmdline;
  }
  get cwd(): string | null {
    return this._cwd;
  }
  get exitInfo(): ExitInfo | null {
    return this._exitInfo;
  }
  get isRunning(): boolean {
    return this._state === "starting" || this._state === "running";
  }
  get ownership(): ProcessOwnership {
    return this._ownership;
  }
  get isExternal(): boolean {
    return this._ownership === "external";
  }
  get isAdopted(): boolean {
    return this.adopted;
  }

  start(opts: StartOptions): void {
    if (this.isRunning) return;
    this._state = "starting";
    this._ownership = "managed";
    this.adopted = false;
    this._cmdline = [opts.bin, ...opts.args];
    this._cwd = opts.cwd;
    this._exitInfo = null;

    let child: ChildProcess;
    try {
      child = spawn(opts.bin, opts.args, {
        cwd: opts.cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      this.appendLog("stderr", `spawn failed: ${String(err)}`);
      this._state = "crashed";
      this._exitInfo = { code: null, signal: null, at: Date.now() };
      this._pid = null;
      this._startedAt = null;
      opts.onExit?.(null, null);
      return;
    }
    this.child = child;
    this._pid = child.pid ?? null;
    this._startedAt = Date.now();
    this.bufs = { stdout: "", stderr: "" };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) =>
      this.handleData("stdout", chunk, opts.onLine),
    );
    child.stderr?.on("data", (chunk: string) =>
      this.handleData("stderr", chunk, opts.onLine),
    );
    child.on("spawn", () => {
      if (this._state === "starting") this._state = "running";
    });
    child.on("error", (err) => {
      this.appendLog("stderr", `process error: ${err.message}`);
      if (this.child === child) {
        this._state = "crashed";
        this._exitInfo = { code: null, signal: null, at: Date.now() };
        this.child = null;
        this.adopted = false;
        this._pid = null;
        this._startedAt = null;
        opts.onExit?.(null, null);
      }
    });
    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      this._state = code === 0 ? "exited" : "crashed";
      this._exitInfo = { code, signal, at: Date.now() };
      this.child = null;
      this.adopted = false;
      this._pid = null;
      this._startedAt = null;
      opts.onExit?.(code, signal);
    });
  }

  /** Track an already-running server without attaching a child-process handle. */
  adopt(
    pid: number,
    options: {
      ownership: ProcessOwnership;
      cmdline?: string[];
      cwd?: string;
      startedAt?: number;
    },
  ): void {
    if (this.isRunning || !Number.isInteger(pid) || pid <= 0) return;
    this.child = null;
    this._state = "running";
    this._ownership = options.ownership;
    this.adopted = true;
    this._pid = pid;
    this._startedAt = options.startedAt ?? Date.now();
    this._exitInfo = null;
    this._cmdline = options.cmdline ?? null;
    this._cwd = options.cwd ?? null;
  }

  /** Drop a childless adopted process after it is no longer reachable. */
  detachAdopted(
    state: Exclude<ProcessState, "starting" | "running" | "stopping"> = "exited",
  ): void {
    if (!this.adopted) return;
    this.child = null;
    this.adopted = false;
    this._ownership = "managed";
    this._state = state;
    this._exitInfo = { code: null, signal: null, at: Date.now() };
    this._pid = null;
    this._startedAt = null;
    this._cmdline = null;
    this._cwd = null;
  }

  /** Drop an external process after it is no longer reachable. */
  detachExternal(
    state: Exclude<ProcessState, "starting" | "running" | "stopping"> = "exited",
  ): void {
    if (!this.isExternal) return;
    this.detachAdopted(state);
  }

  /** SIGTERM, escalate to SIGKILL after timeoutMs. Resolves when the process is gone. */
  async stop(
    timeoutMs = 12_000,
    options: StopOptions = {},
  ): Promise<void> {
    if (this.isExternal) {
      if (!options.terminateExternal || !this._pid) return;
      const pid = this._pid;
      this._state = "stopping";
      await this.stopPid(pid, timeoutMs, options.verifyPid);
      this.adopted = false;
      this._ownership = "managed";
      this._state = "stopped";
      this._pid = null;
      this._startedAt = null;
      return;
    }
    const child = this.child;
    if (!child) {
      if (this._state === "stopping") this._state = "stopped";
      if (this.adopted && this._pid) {
        const pid = this._pid;
        this._state = "stopping";
        await this.stopPid(pid, timeoutMs, options.verifyPid);
      }
      this.adopted = false;
      this._state = "stopped";
      this._pid = null;
      this._startedAt = null;
      return;
    }
    this._state = "stopping";
    const exited = new Promise<void>((resolve) => {
      const cleanup = () => {
        child.removeListener("exit", onExit);
        child.removeListener("error", onError);
        if (this.stopTimer) {
          clearTimeout(this.stopTimer);
          this.stopTimer = null;
        }
      };
      const onExit = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        resolve();
      };
      child.once("exit", onExit);
      child.once("error", onError);
      this.stopTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }, timeoutMs);
    });
    try {
      child.kill("SIGTERM");
    } catch {
      // already gone
    }
    await exited;
    this._state = "stopped";
    this._pid = null;
    this._startedAt = null;
  }

  private async stopPid(
    pid: number,
    timeoutMs: number,
    verifyPid?: (pid: number) => boolean,
  ): Promise<void> {
    if (verifyPid && !verifyPid(pid)) return;
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    if (verifyPid && !verifyPid(pid)) return;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }

  private handleData(
    stream: "stdout" | "stderr",
    chunk: string,
    onLine?: (line: Ds4LogLine) => void,
  ): void {
    const buf = (this.bufs[stream] += chunk);
    let idx: number;
    let consumed = 0;
    while ((idx = buf.indexOf("\n", consumed)) !== -1) {
      let line = buf.slice(consumed, idx);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      consumed = idx + 1;
      const entry = this.appendLog(stream, line);
      if (entry) onLine?.(entry);
    }
    this.bufs[stream] = buf.slice(consumed);
    if (this.bufs[stream].length > 64 * 1024) {
      // Unbounded line (no newline yet): flush as its own entry to keep memory bounded.
      const entry = this.appendLog(stream, this.bufs[stream]);
      if (entry) onLine?.(entry);
      this.bufs[stream] = "";
    }
  }

  private appendLog(stream: "stdout" | "stderr", text: string): Ds4LogLine | null {
    if (!text) return null;
    const entry: Ds4LogLine = { seq: this.seq++, ts: Date.now(), stream, text };
    this.ring.push(entry);
    if (this.ring.length > this.logLimit) {
      this.ring.splice(0, this.ring.length - this.logLimit);
    }
    return entry;
  }

  /** Return lines with seq >= offset (default: newest `limit` lines). */
  logs(offset = 0, limit = 200): {
    lines: Ds4LogLine[];
    nextOffset: number;
    total: number;
    firstSeq: number;
  } {
    const first = this.ring.length ? this.ring[0].seq : 0;
    const clamped = Math.max(0, Math.min(limit, 5000));
    const start = Math.max(0, offset - first);
    const slice = this.ring.slice(start, start + clamped);
    const nextOffset = this.ring.length
      ? this.ring[this.ring.length - 1].seq + 1
      : 0;
    return { lines: slice, nextOffset, total: this.ring.length, firstSeq: first };
  }

  clearLogs(): void {
    this.ring = [];
  }
}
