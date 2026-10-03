import { DotError, type DotAuth, type DotRoom } from "./dot-client.js";

type Frame = { id?: number; method?: string; params?: Record<string, any>; result?: any; error?: unknown };
export type DotNotification = { method: string; params: Record<string, any> };
export type DotSocket = Pick<WebSocket, "addEventListener" | "send" | "close">;
export type DotSocketFactory = (url: string, protocols: string[]) => DotSocket;

/** One connection generation. Reconnect uses a fresh instance and rereads auth. */
export class DotLive {
  private socket?: DotSocket;
  private nextId = 0;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private closed = false;
  private ownedTurn?: string;
  constructor(private readonly auth: DotAuth, private readonly room: DotRoom,
    private readonly notify: (event: DotNotification) => void,
    private readonly disconnected: () => void,
    private readonly factory: DotSocketFactory = (url, protocols) => new WebSocket(url, protocols),
    private readonly deadlineMs = 15_000) {}
  async connect(): Promise<{ status: { type: string } }> {
    if (this.socket || this.closed) throw new DotError("Dot stream connection cannot be reused.");
    let tokens = await this.auth.read();
    let expires: number | undefined;
    try { expires = JSON.parse(Buffer.from(tokens.access_token.split(".")[1]!, "base64url").toString()).exp; } catch { /* Opaque tokens are allowed. */ }
    if (typeof expires === "number" && expires * 1000 < Date.now() + 30_000) { await this.auth.refresh(); tokens = await this.auth.read(); }
    // Never include protocols or the socket's underlying errors in diagnostics.
    const socket = this.socket = this.factory("wss://codex-cloud-backend.chatgpt.com/", ["codex-app-server", "codex-client.desktop", `openai-bearer.${tokens.access_token}`]);
    socket.addEventListener("message", event => {
      let frame: Frame; try { frame = JSON.parse(String(event.data)); } catch { return; }
      const pending = frame.id === undefined ? undefined : this.pending.get(frame.id);
      if (pending) {
        this.pending.delete(frame.id!); clearTimeout(pending.timer);
        frame.error ? pending.reject(new DotError("Dot stream request was rejected.")) : pending.resolve(frame.result);
        return;
      }
      if (frame.method && frame.params?.threadId === this.room.rootId) this.notify({ method: frame.method, params: frame.params });
    });
    socket.addEventListener("close", () => {
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new DotError("Dot stream disconnected.")); }
      this.pending.clear();
      if (!this.closed) { this.closed = true; this.disconnected(); }
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new DotError("Dot stream connection timed out.")), this.deadlineMs);
        socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
        socket.addEventListener("error", () => { clearTimeout(timer); reject(new DotError("Dot stream connection failed.")); }, { once: true });
        socket.addEventListener("close", () => { clearTimeout(timer); reject(new DotError("Dot stream closed before initialization.")); }, { once: true });
      });
      await this.rpc("initialize", { clientInfo: { name: "bb_external_agents_dot", version: "0.1.0" }, capabilities: { experimentalApi: true } });
      socket.send(JSON.stringify({ method: "initialized" }));
      const result = await this.rpc("thread/resume", { threadId: this.room.rootId, excludeTurns: true });
      if (!result?.thread?.status?.type) throw new DotError("Dot returned an unsupported thread status.");
      return result.thread;
    } catch (error) { this.close(); throw error instanceof DotError ? error : new DotError("Dot stream initialization failed."); }
  }
  /** Set only after the request/message ID is observed in this exact turn. */
  own(turnId: string) { this.ownedTurn = turnId; }
  async interrupt(turnId: string) {
    if (!turnId || turnId !== this.ownedTurn) throw new DotError("Cannot interrupt an uncorrelated Dot turn.");
    await this.rpc("turn/interrupt", { threadId: this.room.rootId, turnId });
  }
  private rpc(method: string, params: unknown): Promise<any> {
    if (this.closed || !this.socket) return Promise.reject(new DotError("Dot stream is not connected."));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new DotError("Dot stream request timed out.")); }, this.deadlineMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket!.send(JSON.stringify({ id, method, params })); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new DotError("Dot stream request failed.")); }
    });
  }
  close() {
    if (!this.closed) { this.closed = true; this.socket?.close(); }
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new DotError("Dot stream closed.")); }
    this.pending.clear();
  }
}
