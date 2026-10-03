import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { ThreadDelta } from "@get-bb/plugin-sdk/provider-bridge";
import { DotClient, DotError, isDotReply, type DotMessage, type DotRoom } from "./dot-client.js";
import { DotLive, type DotNotification } from "./dot-live.js";
import { DotQueue } from "./dot-queue.js";

export function selectDotReplies(messages: DotMessage[], room: DotRoom, sent: DotMessage, requestId: string, windows: { start: number; end?: number }[], seen: Set<string>) {
  const sentAt = Date.parse(sent.created_at ?? "");
  const fresh = messages.filter(message => !seen.has(message.id) && message.id !== sent.id && !message.deleted_at && Date.parse(message.created_at ?? "") >= sentAt);
  const replies = fresh.filter(message => message.account_user_id === room.memberId && (
    isDotReply(message, room, requestId, sent.id) ||
    !message.reply_to && !message.request_id && Date.parse(message.created_at ?? "") > sentAt &&
      windows.some(window => Date.parse(message.created_at!) >= window.start && Date.parse(message.created_at!) <= (window.end ?? Infinity))
  ));
  return {
    uncertain: fresh.some(message => message.account_user_id !== room.memberId) ||
      replies.some(message => !isDotReply(message, room, requestId, sent.id)),
    replies,
  };
}
export type DotLiveFactory = (room: DotRoom, notify: (event: DotNotification) => void, disconnected: () => void) => Pick<DotLive, "connect" | "own" | "interrupt" | "close">;
export class DotRun {
  private cancelled = false;
  private queueAbort = new AbortController();
  constructor(private readonly client: DotClient, private readonly queue: DotQueue,
    private readonly emit: (deltas: ThreadDelta[]) => void,
    private readonly liveFactory: DotLiveFactory = (room, notify, disconnected) => new DotLive(client.auth, room, notify, disconnected),
    private readonly pollMs = 500, private readonly timeoutMs = 180_000) {}
  cancel() { this.cancelled = true; this.queueAbort.abort(); }
  async execute(text: string): Promise<void> {
    let room = await this.client.discover();
    const lease = await this.queue.acquire(room.roomId, this.queueAbort.signal);
    let submitted = false, settled = false, disconnected = false, uncertain = false;
    let sending = false, activeTurn: string | undefined, completed = false, interrupted = false, remoteError = "";
    let interruptedTurn: string | undefined;
    let serverOffset = 0;
    const windows: { start: number; end?: number }[] = [];
    let live: ReturnType<DotLiveFactory> | undefined;
    const now = () => Date.now() + serverOffset;
    const notify = ({ method, params }: DotNotification) => {
      if (!sending) return;
      const turnId = params.turn?.id ?? params.turnId;
      if (method === "turn/started" && typeof turnId === "string") {
        activeTurn = turnId; completed = false; windows.push({ start: now() });
      }
      if (method === "turn/completed" && turnId === activeTurn) {
        const window = windows.at(-1); if (window) window.end = now();
        activeTurn = undefined; completed = true;
        interrupted = params.turn?.status === "interrupted" && turnId === interruptedTurn;
        if (params.turn?.status === "failed") remoteError = params.turn.error?.message || "Dot's cloud turn failed.";
      }
      if (turnId && turnId !== activeTurn) return;
      if (method === "item/agentMessage/delta" && typeof params.delta === "string" && params.itemId) {
        this.emit([{ kind: "item.textDelta", key: { providerItemId: params.itemId }, channel: "agentMessage", text: params.delta }]);
      }
      const item = params.item;
      if (method === "item/completed" && item?.type === "agentMessage" && item.id && typeof item.text === "string") {
        this.emit([{ kind: "item.textClose", key: { providerItemId: item.id }, channel: "agentMessage", text: item.text }]);
      }
      if (item?.id && ["mcpToolCall", "dynamicToolCall", "commandExecution", "webSearch", "fileChange"].includes(item.type)) {
        const shape = { type: "tool" as const, tool: item.tool ?? item.type, args: item.arguments ?? {} };
        if (method === "item/started") this.emit([{ kind: "item.open", key: { providerItemId: item.id }, item: shape }]);
        if (method === "item/completed") this.emit([{ kind: "item.close", key: { providerItemId: item.id }, item: shape, status: item.status === "failed" ? "failed" : "completed" }]);
      }
    };
    try {
      // Refresh root/paused status after waiting for another BB thread.
      const fresh = await this.client.discover();
      if (fresh.roomId !== room.roomId) throw new DotError("The selected Dot changed while queued. Retry this turn.");
      room = fresh;
      live = this.liveFactory(room, notify, () => { disconnected = true; });
      let status = await live.connect();
      const deadline = Date.now() + this.timeoutMs;
      // Wait for an existing ChatGPT client's work; never interrupt it.
      while (status.status.type !== "idle") {
        if (this.cancelled) throw new DotError("Queued Dot request cancelled.");
        if (Date.now() > deadline) throw new DotError("Dot is busy in another client. Try again after it finishes.");
        live.close(); await delay(this.pollMs);
        live = this.liveFactory(room, notify, () => { disconnected = true; }); status = await live.connect();
      }
      const baseline = new Set((await this.client.messages(room)).map(message => message.id));
      if (this.cancelled) throw new DotError("Queued Dot request cancelled.");
      const requestId = randomUUID();
      sending = true; submitted = true; // A failed POST may still have reached the server.
      let sent: DotMessage;
      try { sent = await this.client.submit(room, text, requestId); }
      catch (error) { if (error instanceof DotError && [400,401,403,404,422].includes(error.status ?? 0)) submitted = false; throw error; }
      const sentAt = Date.parse(sent.created_at ?? "");
      if (!Number.isFinite(sentAt)) throw new DotError("Dot did not return a server timestamp; delivery is uncertain.");
      serverOffset = sentAt - Date.now();
      for (const window of windows) { window.start += serverOffset; if (window.end) window.end += serverOffset; }
      while (Date.now() < deadline) {
        if (disconnected) {
          disconnected = false; uncertain = true;
          live.close();
          const current = await this.client.discover();
          if (current.roomId !== room.roomId) throw new DotError("Dot changed rooms during the turn; outcome is uncertain.");
          room = current;
          live = this.liveFactory(room, notify, () => { disconnected = true; });
          status = await live.connect();
          if (status.status.type === "idle") { activeTurn = undefined; completed = true; }
        }
        const result = selectDotReplies(await this.client.messages(room), room, sent, requestId, windows, baseline);
        uncertain ||= result.uncertain;
        if (this.cancelled && activeTurn && interruptedTurn !== activeTurn) {
          if (uncertain) throw new DotError("Dot's turn correlation is uncertain. Stop it in ChatGPT.");
          live.own(activeTurn); interruptedTurn = activeTurn; await live.interrupt(activeTurn);
        }
        if (completed && !activeTurn && (result.replies.length || interrupted || remoteError)) {
          settled = true;
          const text = result.replies.sort((a, b) => Date.parse(a.created_at!) - Date.parse(b.created_at!)).map(message => message.content.text ?? "").filter(Boolean).join("\n\n");
          if (text) this.emit([{ kind: "item.textClose", key: { channel: "dot-answer" }, channel: "agentMessage", text: text + (uncertain ? "\n\n[Uncertain reply: matched by the active turn window without a reply link, or another client/stream gap was observed. This answer may belong to other Dot activity.]" : "") }]);
          if (remoteError) throw new DotError(remoteError);
          this.emit([{ kind: "turn.boundary", status: interrupted ? "interrupted" : "completed" }]);
          return;
        }
        await delay(this.pollMs);
      }
      throw new DotError("Dot did not confirm a correlated reply and cloud turn completion before the timeout. Check ChatGPT before retrying.");
    } finally {
      live?.close();
      if (!submitted || settled) await lease.release(); else await lease.uncertain();
    }
  }
}
