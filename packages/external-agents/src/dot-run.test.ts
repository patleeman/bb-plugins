import { expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DotRun, selectDotReplies, type DotLiveFactory } from "./dot-run.js";
import { DotQueue } from "./dot-queue.js";
import { type DotClient, type DotMessage, type DotRoom } from "./dot-client.js";
import type { DotNotification } from "./dot-live.js";
import type { ThreadDelta } from "@get-bb/plugin-sdk/provider-bridge";
const room: DotRoom = { agentId: "dot", roomId: "room", memberId: "dot-member", rootId: "root", paused: false };
it("bounds best-effort replies by sender, server timestamp and cloud window, flagging concurrent clients", () => {
  const sent = { id: "sent", content: { text: "hello" }, created_at: new Date(1000).toISOString() };
  const msg = (id: string, time: number, sender = "dot-member") => ({ id, content: { text: id }, created_at: new Date(time).toISOString(), account_user_id: sender });
  const selection = selectDotReplies([msg("old", 500), msg("inside", 1500), msg("late", 3000), msg("other", 1600, "human")], room, sent, "request", [{ start: 1100, end: 2000 }], new Set());
  expect(selection.replies.map(m => m.id)).toEqual(["inside"]); expect(selection.uncertain).toBe(true);
});
it("delivers a correlated reply after a cloud terminal event without treating an unsolicited cloud interruption as BB Stop", async () => {
  const root = await mkdtemp(join(tmpdir(), "bb-dot-run-"));
  try {
    let notify!: (event: DotNotification) => void; let messages: DotMessage[] = [];
    const deltas: ThreadDelta[] = [];
    const client = { discover: async () => room, messages: async () => messages, submit: async (_: unknown, text: string, request: string) => {
      const sent = { id: "sent", content: { text }, created_at: new Date().toISOString() };
      queueMicrotask(() => {
        notify({ method: "turn/started", params: { turn: { id: "turn" } } });
        notify({ method: "item/started", params: { turnId: "turn", item: { id: "tool", type: "mcpToolCall", tool: "reply" } } });
        messages = [{ id: "reply", account_user_id: room.memberId, content: { text: "ok" }, created_at: sent.created_at, request_id: request }];
        notify({ method: "item/completed", params: { turnId: "turn", item: { id: "tool", type: "mcpToolCall", tool: "reply" } } });
        notify({ method: "turn/completed", params: { turn: { id: "turn", status: "interrupted" } } });
      }); return sent;
    } } as unknown as DotClient;
    const factory: DotLiveFactory = (_, n) => { notify = n; return { connect: async () => ({ status: { type: "idle" } }), own() {}, interrupt: async () => {}, close() {} }; };
    await new DotRun(client, new DotQueue(root), d => deltas.push(...d), factory, 1, 1000).execute("hello");
    expect(deltas.map(d => d.kind)).toEqual(["item.open", "item.close", "item.textClose", "turn.boundary"]);
    expect(deltas.at(-1)).toMatchObject({ status: "completed" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("interrupts the active correlated turn and waits for its interrupted completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "bb-dot-cancel-"));
  try {
    let notify!: (event: DotNotification) => void; let run!: DotRun;
    const interrupt = vi.fn(async () => notify({ method: "turn/completed", params: { turn: { id: "owned", status: "interrupted" } } }));
    const client = { discover: async () => room, messages: async () => [], submit: async () => {
      queueMicrotask(() => { notify({ method: "turn/started", params: { turn: { id: "owned" } } }); run.cancel(); });
      return { id: "sent", content: { text: "hello" }, created_at: new Date().toISOString() };
    } } as unknown as DotClient;
    const deltas: ThreadDelta[] = [];
    const factory: DotLiveFactory = (_, n) => { notify = n; return { connect: async () => ({ status: { type: "idle" } }), own() {}, interrupt, close() {} }; };
    run = new DotRun(client, new DotQueue(root), d => deltas.push(...d), factory, 1, 1000);
    await run.execute("hello"); expect(interrupt).toHaveBeenCalledWith("owned");
    expect(deltas.at(-1)).toMatchObject({ kind: "turn.boundary", status: "interrupted" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("shows a candidate reply with an uncertainty note when another client intervenes", async () => {
  const root = await mkdtemp(join(tmpdir(), "bb-dot-uncertain-"));
  try {
    let notify!: (event: DotNotification) => void; let messages: DotMessage[] = [];
    const deltas: ThreadDelta[] = [];
    const client = { discover: async () => room, messages: async () => messages, submit: async (_: unknown, text: string, request: string) => {
      const sent = { id: "sent", content: { text }, created_at: new Date().toISOString() };
      queueMicrotask(() => {
        notify({ method: "turn/started", params: { turn: { id: "turn" } } });
        messages = [
          { id: "other", account_user_id: "other-client", content: { text: "another message" }, created_at: sent.created_at },
          { id: "reply", account_user_id: room.memberId, content: { text: "candidate" }, created_at: sent.created_at, request_id: request },
        ];
        notify({ method: "turn/completed", params: { turn: { id: "turn", status: "completed" } } });
      }); return sent;
    } } as unknown as DotClient;
    const factory: DotLiveFactory = (_, n) => { notify = n; return { connect: async () => ({ status: { type: "idle" } }), own() {}, interrupt: async () => {}, close() {} }; };
    await new DotRun(client, new DotQueue(root), d => deltas.push(...d), factory, 1, 1000).execute("hello");
    expect(deltas.at(-1)).toMatchObject({ kind: "turn.boundary", status: "completed" });
    expect(deltas.find(d => d.kind === "item.textClose")).toMatchObject({ text: expect.stringContaining("[Uncertain reply:") });
    const lease = await new DotQueue(root).acquire(room.roomId, new AbortController().signal); await lease.release();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("marks an unlinked first reply uncertain without other clients, and rejects foreign reply links", () => {
  const sent = { id: "sent", content: { text: "hello" }, created_at: new Date(1000).toISOString() };
  const first = { id: "reply", account_user_id: room.memberId, content: { text: "ok" }, created_at: new Date(1500).toISOString() };
  const windows = [{ start: 1100, end: 2000 }];
  expect(selectDotReplies([first], room, sent, "request", windows, new Set())).toMatchObject({ uncertain: true, replies: [first] });
  expect(selectDotReplies([{ ...first, reply_to: { message_id: "other" }, request_id: "request" }], room, sent, "request", windows, new Set()).replies).toEqual([]);
  expect(selectDotReplies([first], room, sent, "request", [{ start: 1600, end: 2000 }], new Set()).replies).toEqual([]);
  expect(selectDotReplies([{ ...first, reply_to: { message_id: "sent" } }], room, sent, "request", windows, new Set()).uncertain).toBe(false);
});
