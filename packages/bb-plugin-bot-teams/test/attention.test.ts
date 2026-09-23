import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { Store } from "../store";
import {
  botSchema,
  roomSchema,
  messageSchema,
  notifyInput,
  rpcContract,
} from "../contract";
import { mentionsOwner } from "../attention";
import { notifyOwner } from "../agent-channels";
import { ChannelNotifications } from "../notifications";

function setup() {
  const host = createFakePluginHost({ pluginId: "bot-teams" });
  const store = new Store(host.bb.storage.database());
  const bot = botSchema.parse({
    id: "bot_0123456789abcdef",
    name: "Atlas",
    handle: "atlas",
    home: "/tmp/attention-qa",
    projectId: "p",
    hostId: "h",
    paused: false,
    createdAt: 1,
    updatedAt: 1,
    lastWakeAt: 0,
    error: null,
  });
  const room = roomSchema.parse({
    id: randomUUID(),
    name: "Launch",
    memberIds: [bot.id],
    paused: false,
    createdAt: 1,
    updatedAt: 1,
  });
  store.put(bot);
  store.putRoom(room);
  store.putConversation({
    id: "conversation",
    botId: bot.id,
    key: "admin",
    threadId: "thread",
    title: "Atlas",
    kind: "admin",
    createdAt: 1,
  });
  const notify = new ChannelNotifications(host.bb, store);
  const message = messageSchema.parse({
    id: "message",
    roomId: room.id,
    runId: "run",
    botId: bot.id,
    speaker: bot.name,
    sourceThreadId: "thread",
    text: "@user Please choose the release date.",
    createdAt: Date.now(),
  });
  return { ...host, store, bot, room, notify, message };
}

test("owner mentions exclude examples, quotations, links, and similar handles", () => {
  for (const text of [
    "@user Please decide",
    "**@USER**, this is blocked",
    "Hi (@user).",
    "Please decide, @user",
    "Please decide, @user.",
  ])
    assert.equal(mentionsOwner(text), true, text);
  for (const text of [
    "@users",
    "@user-name",
    "email@user.com",
    "`@user`",
    "```\n@user\n```",
    "> @user quoted",
    "[@user](https://example.com)",
    "https://example.com/@user",
    "![Hi @user](image.png)",
  ])
    assert.equal(mentionsOwner(text), false, text);
});

test("attention survives reading and reload, is deduplicated, and only acknowledgement resolves it", async () => {
  const x = setup();
  try {
    x.store.putMessage(x.message);
    x.store.putMessage(x.message);
    assert.equal(x.store.attention.list("open", 30, 0).openCount, 1);
    assert.equal(
      (
        x.store.db
          .prepare("SELECT count(*) AS n FROM channel_notifications")
          .get() as { n: number }
      ).n,
      1,
    );
    x.store.putRoom({
      ...x.store.room(x.room.id),
      lastReadAt: Date.now() + 1000,
    });
    assert.equal(
      (await x.notify.resolve("attention:message:0"))?.path,
      `/plugins/bot-teams/channels/${x.room.id}/message/message`,
    );
    const restarted = new Store(x.store.db);
    assert.equal(
      restarted.attention.list("open", 30, 0).items[0]?.message.id,
      "message",
    );
    restarted.attention.update("message", "acknowledge");
    assert.equal(await x.notify.resolve("attention:message:0"), null);
    assert.equal(
      restarted.attention.list("acknowledged", 30, 0).items.length,
      1,
    );
    assert.equal(restarted.attention.list("open", 30, 0).openCount, 0);
  } finally {
    await x.harness.lifecycle.dispose();
  }
});

test("snooze suppresses queued delivery and wakes once after restart with a new event", async () => {
  const x = setup();
  try {
    x.store.putMessage(x.message);
    const snoozed = x.store.attention.update("message", "snooze", 60);
    assert.equal(await x.notify.resolve("attention:message:0"), null);
    const restarted = new Store(x.store.db);
    assert.equal(restarted.attention.wake(snoozed.snoozedUntil! - 1), 0);
    assert.equal(restarted.attention.wake(snoozed.snoozedUntil!), 1);
    assert.equal(restarted.attention.wake(snoozed.snoozedUntil!), 0);
    assert.ok(await x.notify.resolve("attention:message:2"));
    assert.equal(await x.notify.resolve("attention:message:0"), null);
    assert.equal(restarted.attention.list("open", 30, 0).openCount, 1);
    restarted.deleteRoom(x.room.id);
    assert.equal(restarted.attention.get("message"), null);
  } finally {
    await x.harness.lifecycle.dispose();
  }
});

test("notification preferences separate replies from attention; archived requests stay quiet", async () => {
  const x = setup();
  try {
    x.store.putMessage(x.message);
    x.store.putMessage({ ...x.message, id: "ordinary", text: "Working on it" });
    x.notify.preferences = async () => ({
      attentionNotifications: true,
      replyNotifications: false,
    });
    assert.ok(await x.notify.resolve("attention:message:0"));
    assert.equal(await x.notify.resolve("reply:ordinary"), null);
    x.notify.preferences = async () => ({
      attentionNotifications: false,
      replyNotifications: true,
    });
    assert.equal(await x.notify.resolve("attention:message:0"), null);
    assert.ok(await x.notify.resolve("reply:ordinary"));
    x.store.putRoom({ ...x.room, archived: true });
    assert.equal(x.store.attention.list("open", 30, 0).openCount, 0);
    x.store.putRoom(x.room);
    assert.equal(x.store.attention.list("open", 30, 0).openCount, 1);
  } finally {
    await x.harness.lifecycle.dispose();
  }
});

test("explicit notifications bind identity and request IDs and do not wake bots", async () => {
  const x = setup();
  try {
    const input = notifyInput.parse({
      channelId: x.room.id,
      requestId: randomUUID(),
      reason: "blocker",
      text: "The release needs your decision.",
    });
    const item = notifyOwner(x.store, input, "thread");
    assert.equal(item.message.botId, x.bot.id);
    assert.equal(item.reason, "blocker");
    assert.deepEqual(notifyOwner(x.store, input, "thread"), item);
    assert.equal(x.store.runs(x.room.id).length, 0);
    assert.throws(
      () => notifyOwner(x.store, { ...input, text: "different" }, "thread"),
      /already used/,
    );
    x.store.putRoom({ ...x.room, memberIds: [] });
    assert.throws(() => notifyOwner(x.store, input, "thread"), /invited/);
    assert.equal(
      rpcContract.attentionUpdate.input.safeParse({
        id: item.id,
        action: "snooze",
      }).success,
      false,
    );
    assert.equal(
      rpcContract.attentionUpdate.input.safeParse({
        id: item.id,
        action: "acknowledge",
        minutes: 60,
      }).success,
      false,
    );
  } finally {
    await x.harness.lifecycle.dispose();
  }
});

test("a deleted regular-agent source cannot block later notification delivery", async () => {
  const x = setup();
  try {
    notifyOwner(
      x.store,
      notifyInput.parse({
        channelId: x.room.id,
        requestId: randomUUID(),
        reason: "update",
        text: "Earlier report",
      }),
      "deleted-thread",
    );
    x.store.putMessage({ ...x.message, text: "Report ready" });
    x.harness.inspection.sdk.stub("threads.get", async () => {
      throw new Error("Thread not found");
    });
    x.harness.inspection.sdk.stub(
      "plugins.callRpc",
      async <T>(args: { outputSchema: z.ZodType<T> }) =>
        args.outputSchema.parse({ ok: true }),
    );
    await x.notify.flush();
    assert.equal(x.harness.inspection.sdk.callsTo("plugins.callRpc").length, 1);
    assert.equal(
      (
        x.store.db
          .prepare(
            "SELECT count(*) AS n FROM channel_notifications WHERE dispatched_at IS NULL",
          )
          .get() as { n: number }
      ).n,
      0,
    );
  } finally {
    await x.harness.lifecycle.dispose();
  }
});

test("owner pings expose durable channel counts and transcript status independently of reading", async () => {
  const x = setup();
  try {
    x.store.putMessage(x.message);
    const inspect = () => x.store.transcript(x.room.id).messages.find(m => m.id === x.message.id)!;
    assert.deepEqual(x.store.attention.counts(), { [x.room.id]: 1 });
    assert.equal(inspect().attentionStatus, "open");
    assert.equal(inspect().ownerMention, true);
    x.store.putRoom({ ...x.store.room(x.room.id), lastReadAt: Date.now() + 1000 });
    assert.deepEqual(x.store.attention.counts(), { [x.room.id]: 1 });
    x.store.attention.update(x.message.id, "snooze", 60);
    assert.deepEqual(x.store.attention.counts(), {});
    assert.equal(inspect().attentionStatus, "snoozed");
    x.store.attention.wake(Date.now() + 3_600_001);
    assert.deepEqual(x.store.attention.counts(), { [x.room.id]: 1 });
    x.store.attention.update(x.message.id, "acknowledge");
    assert.equal(inspect().attentionStatus, "acknowledged");
    assert.deepEqual(x.store.attention.counts(), {});
    x.store.attention.update(x.message.id, "reopen");
    x.store.putRoom({ ...x.store.room(x.room.id), archived: true });
    assert.deepEqual(x.store.attention.counts(), {});
  } finally { await x.harness.lifecycle.dispose(); }
});

test("historical pings show a mention without generating a stale question", async () => {
  const x = setup();
  try {
    // Simulates the older installed build that only captured explicit notify calls.
    x.store.db.prepare("INSERT INTO room_messages VALUES (?,?,?)")
      .run(x.message.id, x.room.id, JSON.stringify(x.message));
    const m = x.store.transcript(x.room.id).messages[0];
    assert.equal(m.ownerMention, true);
    assert.equal(m.attentionStatus, undefined);
    assert.deepEqual(x.store.attention.counts(), {});
    assert.equal(x.store.attention.get(x.message.id), null);
    x.store.putMessage({ ...x.message, id: "example", text: "Example: `@user`" });
    assert.equal(x.store.transcript(x.room.id).messages.at(-1)!.ownerMention, false);
  } finally { await x.harness.lifecycle.dispose(); }
});
