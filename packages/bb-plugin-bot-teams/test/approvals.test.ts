import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { ChannelApprovals, approvalView } from "../approvals";
import { Store } from "../store";
import { botSchema, jobSchema, roomSchema } from "../contract";

const interaction = (overrides: Record<string, unknown> = {}) => ({
  id: "int-1",
  threadId: "work",
  turnId: "turn",
  createdAt: 10,
  status: "pending",
  statusReason: null,
  resolution: null,
  resolvedAt: null,
  providerId: "codex",
  providerRequestId: "r",
  providerThreadId: "pt",
  payload: {
    kind: "approval",
    reason: "Pushes to the shared branch.",
    availableDecisions: ["allow_once", "allow_for_session", "deny"],
    subject: {
      kind: "command",
      itemId: "item",
      command: "git push origin main",
      cwd: null,
      actions: [],
      sessionGrant: null,
    },
  },
  ...overrides,
});

function setup(pending: unknown[] = [interaction()]) {
  const resolved: unknown[] = [];
  const host = createFakePluginHost({
    pluginId: "bot-teams",
    sdk: {
      threads: {
        interactions: {
          list: async () => pending,
          get: async () => pending[0],
          resolve: async (args: unknown) => {
            resolved.push(args);
            return pending[0];
          },
        },
      },
    },
  });
  const store = new Store(host.bb.storage.database());
  const bot = botSchema.parse({
    id: "bot_0123456789abcdef",
    name: "Designer",
    handle: "designer",
    home: "/tmp",
    projectId: "p",
    hostId: "h",
    paused: false,
    createdAt: 1,
    updatedAt: 1,
    lastWakeAt: 0,
    error: null,
  });
  store.put(bot);
  const room = roomSchema.parse({
    id: randomUUID(),
    name: "Release",
    memberIds: [bot.id],
    paused: false,
    createdAt: 1,
    updatedAt: 1,
  });
  store.putRoom(room);
  store.putConversation({
    id: "c",
    botId: bot.id,
    key: "group",
    threadId: "work",
    title: "Designer",
    kind: "group",
    createdAt: 1,
  });
  const job = jobSchema.parse({
    id: "job-1",
    botId: bot.id,
    conversationKey: "group",
    threadId: "work",
    text: "ship it",
    status: "running",
    reply: null,
    error: null,
    createdAt: 1,
    updatedAt: 1,
    startedAt: 1,
    roomId: room.id,
    runId: "run-1",
  });
  store.enqueue(job);
  let changes = 0;
  const approvals = new ChannelApprovals(host.bb, store, () => changes++);
  return {
    ...host,
    store,
    bot,
    room,
    job,
    approvals,
    resolved,
    changes: () => changes,
  };
}

test("a bot's pending approval reaches the channel that started the work", async () => {
  const x = setup();
  await x.approvals.tick();
  const [approval, ...rest] = x.approvals.list(x.room.id);
  assert.equal(rest.length, 0);
  assert.equal(approval?.kind, "approval");
  assert.equal(approval?.botId, x.bot.id);
  assert.equal(approval?.threadId, "work");
  assert.equal(approval?.jobId, "job-1");
  assert.equal(approval?.title, "wants to run `git push origin main`");
  assert.equal(approval?.detail, "Pushes to the shared branch.");
  assert.deepEqual(approval?.decisions, [
    "allow_once",
    "allow_for_session",
    "deny",
  ]);
  assert.deepEqual(x.approvals.counts(), { [x.room.id]: 1 });
  assert.deepEqual([...x.approvals.waitingThreadIds(x.room.id)], ["work"]);
  assert.equal(x.changes(), 1);
  // An unchanged poll must not churn the channel view.
  await x.approvals.tick();
  assert.equal(x.changes(), 1);
});

test("channel questions Bot Teams opened itself are not forwarded as approvals", async () => {
  const x = setup([
    interaction({
      origin: {
        kind: "plugin",
        pluginId: "bot-teams",
        rendererId: "channel-question",
      },
      payload: { kind: "plugin", title: "Which release date?", data: null },
    }),
  ]);
  await x.approvals.tick();
  assert.deepEqual(x.approvals.list(x.room.id), []);
});

test("finished work stops forwarding its requests", async () => {
  const x = setup();
  await x.approvals.tick();
  assert.equal(x.approvals.list(x.room.id).length, 1);
  x.store.putJob({ ...x.job, status: "done" });
  await x.approvals.tick();
  assert.deepEqual(x.approvals.list(x.room.id), []);
  assert.deepEqual(x.approvals.counts(), {});
});

test("approving from the channel resolves the real interaction once", async () => {
  const x = setup();
  await x.approvals.tick();
  const result = await x.approvals.resolve({
    id: x.room.id,
    threadId: "work",
    interactionId: "int-1",
    decision: "allow_once",
  });
  assert.deepEqual(result, { resolved: true });
  assert.deepEqual(x.resolved, [
    {
      threadId: "work",
      interactionId: "int-1",
      resolution: { decision: "allow_once", grantedPermissions: null },
    },
  ]);
  // The card disappears immediately, without waiting for the next poll.
  assert.deepEqual(x.approvals.list(x.room.id), []);
});

test("denying sends a bare deny", async () => {
  const x = setup();
  await x.approvals.resolve({
    id: x.room.id,
    threadId: "work",
    interactionId: "int-1",
    decision: "deny",
  });
  assert.deepEqual((x.resolved[0] as { resolution: unknown }).resolution, {
    decision: "deny",
  });
});

test("a session approval carries the subject's session grant", async () => {
  const grant = { fileSystem: { read: ["/repo"], write: [] }, network: null };
  const x = setup([
    interaction({
      payload: {
        kind: "approval",
        reason: null,
        availableDecisions: ["allow_once", "allow_for_session", "deny"],
        subject: {
          kind: "command",
          itemId: "item",
          command: "ls",
          cwd: null,
          actions: [],
          sessionGrant: grant,
        },
      },
    }),
  ]);
  await x.approvals.resolve({
    id: x.room.id,
    threadId: "work",
    interactionId: "int-1",
    decision: "allow_for_session",
  });
  assert.deepEqual((x.resolved[0] as { resolution: unknown }).resolution, {
    decision: "allow_for_session",
    grantedPermissions: grant,
  });
});

test("a single multiple-choice question is answerable from the channel", async () => {
  const x = setup([
    interaction({
      payload: {
        kind: "user_question",
        questions: [
          {
            id: "q1",
            prompt: "Which branch?",
            multiSelect: false,
            allowFreeText: false,
            options: [
              { value: "main", label: "main" },
              { value: "next", label: "next" },
            ],
          },
        ],
      },
    }),
  ]);
  await x.approvals.tick();
  const approval = x.approvals.list(x.room.id)[0]!;
  assert.equal(approval.kind, "question");
  assert.equal(approval.title, "has a question");
  assert.equal(approval.questions[0]?.options.length, 2);
  await x.approvals.resolve({
    id: x.room.id,
    threadId: "work",
    interactionId: "int-1",
    answers: { q1: { selected: ["next"] } },
  });
  assert.deepEqual((x.resolved[0] as { resolution: unknown }).resolution, {
    kind: "user_answer",
    answers: { q1: { selected: ["next"] } },
  });
  await assert.rejects(
    x.approvals.resolve({
      id: x.room.id,
      threadId: "work",
      interactionId: "int-1",
      answers: { q1: { selected: ["trunk"] } },
    }),
    /no longer offered/,
  );
});

test("all parts of a multi-question request are answerable from the channel", async () => {
  const x = setup([interaction({ payload: {
    kind: "user_question",
    questions: [
      { id: "q1", prompt: "Which branches?", multiSelect: true,
        allowFreeText: false, options: [
          { value: "main", label: "Main" }, { value: "next", label: "Next" },
        ] },
      { id: "q2", prompt: "Why?", multiSelect: false,
        allowFreeText: true, options: [] },
    ],
  } })]);
  await x.approvals.tick();
  assert.equal(x.approvals.list(x.room.id)[0]?.title, "has 2 questions");
  const answers = {
    q1: { selected: ["main", "next"] },
    q2: { selected: [], freeText: "  Both ship today.  " },
  };
  await x.approvals.resolve({ id: x.room.id, threadId: "work", interactionId: "int-1", answers });
  assert.deepEqual((x.resolved[0] as { resolution: unknown }).resolution, {
    kind: "user_answer",
    answers: {
      q1: { selected: ["main", "next"] },
      q2: { selected: [], freeText: "Both ship today." },
    },
  });
  await assert.rejects(
    x.approvals.resolve({ id: x.room.id, threadId: "work", interactionId: "int-1",
      answers: { q1: { selected: ["main"] } } }),
    /Answer every question/,
  );
  await assert.rejects(
    x.approvals.resolve({ id: x.room.id, threadId: "work", interactionId: "int-1",
      answers: { q1: { selected: ["main"] }, q2: { selected: ["main"] } } }),
    /no longer offered/,
  );
});

test("provider requests are forwarded for native inline rendering", async () => {
  const view = approvalView(
    interaction({
      payload: { kind: "codex/custom", title: "Pick a file", data: null },
    }) as never,
    { roomId: "r", botId: "bot_0123456789abcdef", jobId: null },
  );
  assert.equal(view.kind, "other");
  assert.equal(view.title, "Pick a file");
  assert.deepEqual(view.decisions, []);
  assert.deepEqual(view.questions, []);
});

test("a channel cannot answer a request from a thread it does not own", async () => {
  const x = setup();
  await assert.rejects(
    x.approvals.resolve({
      id: x.room.id,
      threadId: "someone-elses-thread",
      interactionId: "int-1",
      decision: "allow_once",
    }),
    /does not belong to this channel/,
  );
  x.store.putJob({ ...x.job, status: "done" });
  await assert.rejects(
    x.approvals.resolve({
      id: x.room.id,
      threadId: "work",
      interactionId: "int-1",
      decision: "allow_once",
    }),
    /no longer working in this channel/,
  );
  assert.deepEqual(x.resolved, []);
});

test("an answered request cannot be answered twice", async () => {
  const x = setup([interaction({ status: "resolved" })]);
  await assert.rejects(
    x.approvals.resolve({
      id: x.room.id,
      threadId: "work",
      interactionId: "int-1",
      decision: "allow_once",
    }),
    /already answered/,
  );
  assert.deepEqual(x.resolved, []);
});
