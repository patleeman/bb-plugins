import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { Store } from "../store";
import { botSchema, roomSchema, messageSchema, jobSchema } from "../contract";
import { ChannelNotifications } from "../notifications";

function setup() {
  const host = createFakePluginHost({ pluginId: "bot-teams" });
  const store = new Store(host.bb.storage.database());
  const bot = botSchema.parse({
    id: "bot_0123456789abcdef",
    name: "Atlas",
    handle: "atlas",
    home: "/tmp/notification-qa",
    projectId: "p",
    hostId: "h",
    createdAt: 1,
    updatedAt: 1,
    lastWakeAt: 0,
    error: null,
  });
  const room = roomSchema.parse({
    id: randomUUID(),
    name: "Research",
    memberIds: [bot.id],
    paused: false,
    createdAt: 1,
    updatedAt: 1,
  });
  store.put(bot);
  store.putRoom(room);
  const notifications = new ChannelNotifications(host.bb, store);
  const message = messageSchema.parse({
    id: "reply-1",
    roomId: room.id,
    runId: "run-1",
    botId: bot.id,
    speaker: bot.name,
    text: "Ready",
    createdAt: Date.now(),
  });
  const job = jobSchema.parse({
    id: message.id,
    botId: bot.id,
    conversationKey: `room:${room.id}`,
    threadId: "hidden-thread",
    text: "Help",
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
  return { ...host, store, bot, room, notifications, message, job };
}

test("only public bot replies enqueue; duplicate inserts do not notify twice", async () => {
  const x = setup();
  try {
    x.store.putMessage({ ...x.message, id: "owner", botId: null });
    x.store.putMessage({ ...x.message, id: "system", system: "bot_joined" });
    assert.equal(
      z
        .object({ n: z.number() })
        .parse(
          x.store.db
            .prepare("SELECT count(*) AS n FROM channel_notifications")
            .get(),
        ).n,
      0,
    );
    x.store.putMessage(x.message);
    x.store.putMessage(x.message);
    assert.equal(
      z
        .object({ n: z.number() })
        .parse(
          x.store.db
            .prepare("SELECT count(*) AS n FROM channel_notifications")
            .get(),
        ).n,
      1,
    );
    assert.deepEqual(await x.notifications.resolve("reply:reply-1"), {
      coalesceKey: x.room.id,
      title: "#Research · Atlas",
      body: "Ready",
      kind: "turn-finished",
      threadId: "hidden-thread",
      projectId: "p",
      path: `/plugins/bot-teams/channels/${x.room.id}/message/reply-1`,
    });
    x.store.putRoom({
      ...x.store.room(x.room.id),
      lastReadAt: x.store.room(x.room.id).updatedAt,
    });
    assert.equal(await x.notifications.resolve("reply:reply-1"), null);
  } finally {
    await x.harness.lifecycle.dispose();
  }
});

test("archive, removal, retirement, and reading suppress already queued replies", async () => {
  for (const change of ["archive", "remove", "retire", "read"]) {
    const x = setup();
    try {
      x.store.putMessage(x.message);
      if (change === "archive") x.store.putRoom({ ...x.room, archived: true });
      if (change === "remove") x.store.putRoom({ ...x.room, memberIds: [] });
      if (change === "retire") x.store.put({ ...x.bot, retired: true });
      if (change === "read")
        x.store.putRoom({ ...x.room, lastReadAt: Date.now() + 100 });
      assert.equal(
        await x.notifications.resolve("reply:reply-1"),
        null,
        change,
      );
    } finally {
      await x.harness.lifecycle.dispose();
    }
  }
});

test("new replies remain unread when channel timestamps advance in the same millisecond", async () => {
  const x = setup();
  try {
    const timestamp = Date.now() + 100;
    x.store.putRoom({ ...x.room, updatedAt: timestamp, lastReadAt: timestamp });
    x.store.putMessage(x.message);
    assert.ok(await x.notifications.resolve("reply:reply-1"));
  } finally {
    await x.harness.lifecycle.dispose();
  }
});

test("attachment-only replies notify and cancelled jobs do not", async () => {
  const x = setup();
  try {
    x.store.putMessage({
      ...x.message,
      text: "",
      attachments: [
        {
          id: randomUUID(),
          roomId: x.room.id,
          projectId: "p",
          name: "report.txt",
          path: "report.txt",
          type: "localFile",
          sizeBytes: 3,
        },
      ],
    });
    assert.equal(
      (await x.notifications.resolve("reply:reply-1"))?.body,
      "Atlas shared 1 file.",
    );
    x.store.putJob({ ...x.job, status: "cancelled" });
    assert.equal(await x.notifications.resolve("error:reply-1"), null);
  } finally {
    await x.harness.lifecycle.dispose();
  }
});

test("terminal failures notify until a retry supersedes them", async () => {
  const x = setup();
  try {
    x.store.putJob({
      ...x.job,
      status: "error",
      error: "Provider unavailable",
    });
    assert.equal(
      (await x.notifications.resolve("error:reply-1"))?.kind,
      "thread-error",
    );
    x.store.enqueue({
      ...x.job,
      id: "retry",
      status: "queued",
      retryOf: x.job.id,
    });
    assert.equal(await x.notifications.resolve("error:reply-1"), null);
  } finally {
    await x.harness.lifecycle.dispose();
  }
});

test("outbox survives a sender outage and retries only undispatched events", async () => {
  const x = setup();
  try {
    x.store.putMessage(x.message);
    await x.notifications.flush();
    assert.equal(
      z
        .object({ dispatched_at: z.number().nullable() })
        .parse(
          x.store.db
            .prepare("SELECT dispatched_at FROM channel_notifications")
            .get(),
        ).dispatched_at,
      null,
    );
    const events: string[] = [];
    x.harness.inspection.sdk.stub(
      "plugins.callRpc",
      async <T>(args: { input?: unknown; outputSchema: z.ZodType<T> }) => {
        events.push(
          z.object({ eventId: z.string() }).parse(args.input).eventId,
        );
        return args.outputSchema.parse({ ok: true });
      },
    );
    const restarted = new ChannelNotifications(x.bb, x.store);
    await restarted.flush();
    await restarted.flush();
    assert.deepEqual(events, ["reply:reply-1"]);
  } finally {
    await x.harness.lifecycle.dispose();
  }
});

test("pending input targets its work thread and is suppressed when read or answered", async () => {
  const x = setup();
  try {
    x.store.putConversation({
      id: "c",
      botId: x.bot.id,
      key: x.job.conversationKey,
      threadId: "hidden-thread",
      title: "Research",
      kind: "group",
      createdAt: 1,
    });
    x.harness.inspection.sdk.stub("threads.get", async () =>
      makeThreadResponse({
        id: "hidden-thread",
        projectId: "p",
        status: "active",
        visibility: "hidden",
      }),
    );
    let pending = true;
    x.harness.inspection.sdk.stub("threads.interactions.list", async () =>
      pending
        ? [
            {
              id: "i",
              threadId: "hidden-thread",
              status: "pending",
              statusReason: null,
              createdAt: 1,
              expiresAt: null,
              resolvedAt: null,
              turnId: "turn",
              providerId: "codex",
              providerThreadId: "provider",
              providerRequestId: "request",
              origin: {
                kind: "provider",
                providerId: "codex",
                providerThreadId: "provider",
                providerRequestId: "request",
              },
              payload: {
                kind: "user_question",
                questions: [
                  {
                    id: "q",
                    prompt: "Continue?",
                    multiSelect: false,
                    allowFreeText: true,
                  },
                ],
              },
              resolution: null,
            },
          ]
        : [],
    );
    x.notifications.interaction("hidden-thread", "i");
    const notice = await x.notifications.resolve("interaction:i");
    assert.equal(notice?.kind, "pending-interaction");
    assert.equal(notice?.threadId, "hidden-thread");
    assert.equal(notice?.path, undefined);
    pending = false;
    assert.equal(await x.notifications.resolve("interaction:i"), null);
    pending = true;
    x.store.putRoom({
      ...x.store.room(x.room.id),
      lastReadAt: x.store.room(x.room.id).updatedAt,
    });
    assert.equal(await x.notifications.resolve("interaction:i"), null);
  } finally {
    await x.harness.lifecycle.dispose();
  }
});
