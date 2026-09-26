import test from "node:test";
import assert from "node:assert/strict";
import type { MessageDispatchHookContext } from "@get-bb/plugin-sdk";
import type { Verdict } from "../classifier";
import {
  SmartQueue,
  decidingReason,
  followupReason,
  followupRecheckMs,
  maxDecideMs,
  type QueuedRow,
  type SmartQueueDeps,
  type ThreadInfo,
} from "../queue";

const thread = (overrides: Partial<ThreadInfo> = {}) =>
  ({
    id: "thr_1",
    status: "active",
    visibility: "visible",
    originPluginId: null,
    projectId: "proj_1",
    environmentId: "env_1",
    title: "Build storage",
    ...overrides,
  }) as ThreadInfo;
const row = (overrides: Partial<QueuedRow> = {}) =>
  ({
    id: "q_1",
    threadId: "thr_1",
    createdAt: 1,
    initiator: "user",
    senderThreadId: null,
    originPluginId: null,
    payload: { kind: "inline" },
    waitingOn: { kind: "plugin", pluginId: "smart-queue", reason: decidingReason },
    content: [{ type: "text", text: "Actually use SQLite", mentions: [] }],
    ...overrides,
  }) as QueuedRow;
const context = (overrides: Partial<MessageDispatchHookContext> = {}) =>
  ({
    thread: thread(),
    attempt: "join-turn",
    initiator: "user",
    senderThreadId: null,
    experimental_submission: null,
    queuedMessages: [],
    ...overrides,
  }) as MessageDispatchHookContext;
const steer: Verdict = { action: "steer", source: "jev", confidence: 0.9, note: null };
const followup: Verdict = { action: "followup", source: "jev", confidence: 0.8, note: null };

function harness(verdict: Verdict | Promise<Verdict> = followup, overrides: Partial<SmartQueueDeps> = {}) {
  const calls = { steered: [] as string[], rechecks: 0, records: [] as unknown[], classified: 0 };
  let now = 1_000;
  const queue = new SmartQueue({
    pluginId: "smart-queue",
    enabled: async () => true,
    thread: async () => thread(),
    classify: async () => {
      calls.classified++;
      return verdict;
    },
    steer: async (r) => {
      calls.steered.push(r.id);
    },
    recheck: async () => {
      calls.rechecks++;
    },
    record: async (r) => {
      calls.records.push(r);
    },
    warn: () => {},
    now: () => now,
    ...overrides,
  });
  return { queue, calls, advance: (ms: number) => (now += ms) };
}
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};

test("an owner message joining a busy turn is held while Smart Queue decides", async () => {
  const { queue } = harness();
  const decision = await queue.dispatch(context());
  assert.equal(decision.action, "wait");
  assert.equal(decision.action === "wait" && decision.reason, decidingReason);
});

test("idle threads, agent messages, and plugin submissions pass through", async () => {
  const { queue } = harness();
  for (const ctx of [
    context({ attempt: "start-turn", thread: thread({ status: "idle" }) }),
    context({ initiator: "agent" }),
    context({ senderThreadId: "thr_other" }),
    context({ experimental_submission: { pluginId: "bot-teams", data: null } }),
    context({ thread: thread({ originPluginId: "bot-teams" }) }),
    context({ thread: thread({ visibility: "hidden" }) }),
  ])
    assert.deepEqual(await queue.dispatch(ctx), { action: "proceed" });
});

test("a disabled plugin never holds messages", async () => {
  const { queue } = harness(followup, { enabled: async () => false });
  assert.deepEqual(await queue.dispatch(context()), { action: "proceed" });
});

test("a steer decision sends the held row into the running turn", async () => {
  const { queue, calls } = harness(steer);
  queue.queued(row());
  await settle();
  assert.deepEqual(calls.steered, ["q_1"]);
  assert.equal(calls.records.length, 1);
});

test("a follow-up decision keeps the row held until the thread is free", async () => {
  const { queue, calls } = harness(followup);
  queue.queued(row());
  await settle();
  assert.equal(calls.rechecks, 1, "the card reason refreshes");
  const busy = await queue.dispatch(context({ queuedMessages: [row()] }));
  assert.deepEqual(busy, { action: "wait", reason: followupReason(followup), sendAt: 1_000 + followupRecheckMs });
  await queue.settled("thr_1");
  assert.equal(calls.rechecks, 2);
  const idle = await queue.dispatch(context({ attempt: "start-turn", thread: thread({ status: "idle" }), queuedMessages: [row()] }));
  assert.deepEqual(idle, { action: "proceed" });
});

test("a pending decision re-holds the row, then times out to follow-up", async () => {
  const { queue, advance } = harness(new Promise<Verdict>(() => {}));
  queue.queued(row());
  await settle();
  const first = await queue.dispatch(context({ queuedMessages: [row()] }));
  assert.equal(first.action === "wait" && first.reason, decidingReason);
  advance(maxDecideMs);
  const second = await queue.dispatch(context({ queuedMessages: [row()] }));
  assert.equal(second.action === "wait" && second.reason.includes("follow-up"), true);
});

test("a row the plugin held before a restart waits as a follow-up", async () => {
  const { queue } = harness();
  const decision = await queue.dispatch(context({ queuedMessages: [row()] }));
  assert.equal(decision.action === "wait" && decision.reason.startsWith("Smart Queue: follow-up"), true);
});

test("core-queued owner rows are classified; only steer changes them", async () => {
  const coreRow = row({ waitingOn: { kind: "thread-busy" } });
  const steering = harness(steer);
  steering.queue.queued(coreRow);
  await settle();
  assert.deepEqual(steering.calls.steered, ["q_1"]);

  const waiting = harness(followup);
  waiting.queue.queued(coreRow);
  await settle();
  assert.deepEqual(waiting.calls.steered, []);
  assert.equal(waiting.calls.rechecks, 0, "core already owns the wait");
  const drained = await waiting.queue.dispatch(context({ queuedMessages: [coreRow] }));
  assert.deepEqual(drained, { action: "proceed" });
});

test("agent, plugin, retry, and timed rows are ignored", async () => {
  const { queue, calls } = harness(steer);
  for (const r of [
    row({ id: "a", initiator: "agent" }),
    row({ id: "b", originPluginId: "agent-checklists" }),
    row({ id: "c", payload: { kind: "retry", attempt: 2, reason: "x", retryOfTurnRequestId: "t" } }),
    row({ id: "d", waitingOn: { kind: "time" } }),
  ])
    queue.queued(r);
  await settle();
  assert.equal(calls.classified, 0);
});

test("a row sent or deleted mid-decision drops the decision", async () => {
  let release!: (verdict: Verdict) => void;
  const { queue, calls } = harness(new Promise<Verdict>((resolve) => (release = resolve)));
  queue.queued(row());
  await settle();
  queue.gone(row());
  release(steer);
  await settle();
  assert.deepEqual(calls.steered, []);
  assert.equal(queue.entries.size, 0);
});

test("a thread that went idle before classification releases the row without a model call", async () => {
  const { queue, calls } = harness(steer, { thread: async () => thread({ status: "idle" }) });
  queue.queued(row());
  await settle();
  assert.equal(calls.classified, 0);
  assert.equal(calls.rechecks, 1);
});

test("a failed steer falls back to follow-up", async () => {
  const { queue, calls } = harness(steer, {
    steer: async () => {
      throw new Error("HTTP 409 conflict");
    },
  });
  queue.queued(row());
  await settle();
  assert.equal(calls.rechecks, 1);
  const decision = await queue.dispatch(context({ queuedMessages: [row()] }));
  assert.equal(decision.action, "wait");
});

test("steers land in send order when a later classification finishes first", async () => {
  const releases = new Map<string, (verdict: Verdict) => void>();
  const { queue, calls } = harness(steer, {
    classify: (r) => new Promise<Verdict>((resolve) => releases.set(r.id, resolve)),
  });
  queue.queued(row({ id: "q_first", createdAt: 1 }));
  queue.queued(row({ id: "q_second", createdAt: 2 }));
  await settle();
  releases.get("q_second")!(steer);
  await settle();
  assert.deepEqual(calls.steered, [], "the later steer waits for the earlier decision");
  releases.get("q_first")!(steer);
  await settle();
  assert.deepEqual(calls.steered, ["q_first", "q_second"]);
});

test("an earlier follow-up does not block a later steer", async () => {
  const releases = new Map<string, (verdict: Verdict) => void>();
  const { queue, calls } = harness(steer, {
    classify: (r) => new Promise<Verdict>((resolve) => releases.set(r.id, resolve)),
  });
  queue.queued(row({ id: "q_first", createdAt: 1 }));
  queue.queued(row({ id: "q_second", createdAt: 2 }));
  await settle();
  releases.get("q_first")!(followup);
  releases.get("q_second")!(steer);
  await settle();
  assert.deepEqual(calls.steered, ["q_second"]);
});

test("the watcher picks up rows the app queued directly and forgets rows that left", async () => {
  const { queue, calls, advance } = harness(steer);
  const appRow = row({ id: "q_app", waitingOn: { kind: "thread-busy" } });
  queue.sync([appRow], 1_000);
  await settle();
  assert.deepEqual(calls.steered, ["q_app"]);
  advance(10);
  queue.sync([], 1_005);
  assert.equal(queue.entries.has("q_app"), false, "a row gone from the snapshot is forgotten");
});

test("a snapshot older than a row never prunes it", async () => {
  const { queue } = harness(new Promise<Verdict>(() => {}));
  queue.queued(row({ id: "q_new" }));
  queue.sync([], 999);
  assert.equal(queue.entries.has("q_new"), true);
});

test("rows in threads Smart Queue skips are read once", async () => {
  let reads = 0;
  const { queue, calls } = harness(steer, {
    thread: async () => {
      reads++;
      return thread({ originPluginId: "bot-teams" });
    },
  });
  const botRow = row({ id: "q_bot", waitingOn: { kind: "thread-busy" } });
  queue.sync([botRow], 1_000);
  await settle();
  queue.sync([botRow], 1_000);
  await settle();
  assert.equal(reads, 1);
  assert.equal(calls.classified, 0);
});
