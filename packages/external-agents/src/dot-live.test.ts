import { expect, it, vi } from "vitest";
import { DotLive, type DotSocketFactory } from "./dot-live.js";
import { codexAuth, DotClient, type DotAuth, type DotRoom } from "./dot-client.js";
const room: DotRoom = { agentId: "dot", roomId: "room", rootId: "root", memberId: "dot-member", paused: false };
class Socket extends EventTarget {
  sent: any[] = [];
  constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
  send(line: string) {
    const frame = JSON.parse(line); this.sent.push(frame);
    if (frame.id) queueMicrotask(() => this.message({ id: frame.id, result: frame.method === "thread/resume" ? { thread: { status: { type: "idle" } } } : {} }));
  }
  message(frame: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) })); }
  close() { this.dispatchEvent(new Event("close")); }
}
const auth = (): DotAuth => ({ read: vi.fn(async () => ({ access_token: "fake-token", account_id: "fake-account" })), refresh: vi.fn(async () => {}) });
it("initializes then resumes without turns, filters other roots, and interrupts only an owned turn", async () => {
  let socket!: Socket;
  const notify = vi.fn(), disconnect = vi.fn();
  const live = new DotLive(auth(), room, notify, disconnect, () => socket = new Socket());
  expect(await live.connect()).toEqual({ status: { type: "idle" } });
  expect(socket.sent.map(frame => frame.method)).toEqual(["initialize", "initialized", "thread/resume"]);
  expect(socket.sent[2].params).toEqual({ threadId: "root", excludeTurns: true });
  socket.message({ method: "turn/started", params: { threadId: "another-root", turn: { id: "foreign" } } });
  expect(notify).not.toHaveBeenCalled();
  socket.message({ method: "turn/started", params: { threadId: "root", turn: { id: "owned" } } });
  expect(notify).toHaveBeenCalledOnce();
  await expect(live.interrupt("foreign")).rejects.toThrow("uncorrelated");
  live.own("owned"); await live.interrupt("owned");
  expect(socket.sent.at(-1)).toMatchObject({ method: "turn/interrupt", params: { threadId: "root", turnId: "owned" } });
  live.close(); expect(disconnect).not.toHaveBeenCalled();
});
it("reconnects via a fresh generation using reread credentials and a newly resolved root", async () => {
  const source = auth(); let token = "first";
  source.read = vi.fn(async () => ({ access_token: token, account_id: "account" }));
  const protocols: string[][] = []; const sockets: Socket[] = [];
  const factory: DotSocketFactory = (_, values) => { protocols.push(values); const socket = new Socket(); sockets.push(socket); return socket; };
  const disconnected = vi.fn();
  const first = new DotLive(source, room, vi.fn(), disconnected, factory);
  await first.connect(); sockets[0]!.close(); expect(disconnected).toHaveBeenCalledOnce();
  await expect(first.interrupt("old-turn")).rejects.toThrow();
  token = "rotated";
  const next = new DotLive(source, { ...room, rootId: "new-root" }, vi.fn(), vi.fn(), factory);
  await next.connect();
  expect(protocols[1]).toContain("openai-bearer.rotated");
  expect(sockets[1]!.sent[2].params.threadId).toBe("new-root");
  next.close();
});
it("refreshes an expired token before opening the socket", async () => {
  let token = `fake.${Buffer.from(JSON.stringify({ exp: 1 })).toString("base64url")}.fake`;
  const source = { read: vi.fn(async () => ({ access_token: token, account_id: "account" })), refresh: vi.fn(async () => { token = "fresh"; }) };
  const factory = vi.fn<DotSocketFactory>(() => new Socket());
  const live = new DotLive(source, room, vi.fn(), vi.fn(), factory);
  await live.connect(); expect(source.refresh).toHaveBeenCalledOnce();
  expect(factory.mock.calls[0]![1]).toContain("openai-bearer.fresh"); live.close();
});
it.runIf(process.env.BB_DOT_LIVE_READONLY === "1")("resumes the live Dot stream without sending a message", async () => {
  const source = codexAuth(); const discovered = await new DotClient(source).discover();
  const live = new DotLive(source, discovered, () => {}, () => {});
  try { expect((await live.connect()).status.type).toBeTruthy(); }
  finally { live.close(); }
}, 60_000);
