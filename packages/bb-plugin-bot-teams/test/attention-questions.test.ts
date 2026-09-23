import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { AttentionQuestions } from "../attention-questions";
import { Store } from "../store";
import { botSchema, roomSchema, messageSchema } from "../contract";

function setup() {
  let visibility: "hidden" | "visible" = "hidden";
  const host = createFakePluginHost({ pluginId: "bot-teams", sdk: { threads: {
    get: async () => makeThreadResponse({ id: "work", visibility }),
    update: async args => { if (args.visibility) visibility = args.visibility; return { ok: true }; },
    interactions: { list: async () => [] },
  } } });
  const store = new Store(host.bb.storage.database());
  const bot = botSchema.parse({ id: "bot_0123456789abcdef", name: "Atlas", handle: "atlas", home: "/tmp", projectId: "p", hostId: "h", paused: false, createdAt: 1, updatedAt: 1, lastWakeAt: 0, error: null });
  store.put(bot);
  const room = roomSchema.parse({ id: randomUUID(), name: "Release", memberIds: [bot.id], paused: false, createdAt: 1, updatedAt: 1 });
  store.putRoom(room);
  store.putConversation({ id: "c", botId: bot.id, key: "admin", threadId: "work", title: "Atlas", kind: "admin", createdAt: 1 });
  const add = (id = "question", reason: "decision" | "blocker" | "update" = "decision") => store.putMessage(messageSchema.parse({ id, roomId: room.id, runId: "run", botId: bot.id, speaker: "Atlas", sourceThreadId: "work", text: "Which release date should we use?", attentionReason: reason, createdAt: Date.now() }));
  const replies: unknown[] = [];
  const send = async (input: unknown) => { replies.push(input); };
  const questions = new AttentionQuestions(host.bb, store, send, () => {});
  return { ...host, store, room, add, replies, send, questions, visibility: () => visibility,
    close: async () => { await questions.dispose(); await host.harness.lifecycle.dispose(); } };
}

test("a decision creates one real question in the bot's visible thread without an agent run or push RPC", async () => {
  const x = setup();
  try {
    x.add();
    await x.questions.tick(); await x.questions.tick();
    assert.equal(x.visibility(), "visible");
    const pending = x.harness.inspection.pendingInteractions;
    assert.equal(pending.length, 1);
    assert.equal(pending[0].threadId, "work");
    assert.equal(pending[0].rendererId, "channel-question");
    assert.match(pending[0].title, /#Release.*Atlas/);
    assert.equal(x.harness.inspection.sdk.callsTo("threads.spawn").length, 0);
    assert.equal(x.harness.inspection.sdk.callsTo("plugins.callRpc").length, 0);
  } finally { await x.close(); }
});

test("answer delivery is durable, idempotent and targets the original message", async () => {
  const x = setup();
  try {
    x.add(); await x.questions.tick();
    const pending = x.harness.inspection.pendingInteractions[0];
    // Persist before BB completes the interaction, as the real describeSubmission callback does.
    await pending.describeSubmission!({ action: "reply", text: "Friday" });
    await pending.describeSubmission!({ action: "reply", text: "Friday" });
    x.harness.behavior.submitInteraction(pending.id, { action: "reply", text: "Friday" });
    await setImmediate();
    await x.questions.dispose();
    let attempts = 0;
    const restarted = new AttentionQuestions(x.bb, new Store(x.store.db), async input => {
      attempts++; await x.send(input);
    }, () => {});
    await restarted.tick(); await restarted.tick();
    assert.equal(attempts, 1);
    assert.equal(x.replies.length, 1);
    assert.deepEqual(x.replies[0], { id: x.room.id, requestId: (x.replies[0] as { requestId: string }).requestId, text: "Friday", replyTo: "question" });
    assert.equal(x.store.attention.get("question")?.status, "acknowledged");
    assert.equal(x.visibility(), "hidden");
    await restarted.dispose();
  } finally { await x.close(); }
});

test("acknowledging in the inbox cancels the prompt and restores hidden visibility", async () => {
  const x = setup();
  try {
    x.add(); await x.questions.tick();
    x.store.attention.update("question", "acknowledge");
    await x.questions.tick(); await setImmediate();
    assert.equal(x.harness.inspection.pendingInteractions.length, 0);
    assert.equal(x.visibility(), "hidden");
    assert.equal(x.replies.length, 0);
  } finally { await x.close(); }
});

test("snooze creates one fresh question after waking", async () => {
  const x = setup();
  try {
    x.add(); await x.questions.tick();
    x.harness.behavior.submitInteraction(x.harness.inspection.pendingInteractions[0].id, { action: "snooze" });
    await setImmediate();
    assert.equal(x.store.attention.get("question")?.status, "snoozed");
    await x.questions.tick();
    assert.equal(x.harness.inspection.pendingInteractions.length, 0);
    x.store.attention.wake(x.store.attention.get("question")!.snoozedUntil!);
    await x.questions.tick(); await x.questions.tick();
    assert.equal(x.harness.inspection.pendingInteractions.length, 1);
  } finally { await x.close(); }
});

test("FYIs and disabled attention do not create questions", async () => {
  const x = setup();
  try {
    x.add("report", "update"); await x.questions.tick();
    assert.equal(x.harness.inspection.pendingInteractions.length, 0);
    x.add(); x.questions.preferences = async () => ({ attentionNotifications: false });
    await x.questions.tick();
    assert.equal(x.harness.inspection.pendingInteractions.length, 0);
    x.questions.preferences = async () => ({ attentionNotifications: true });
    await x.questions.tick();
    assert.equal(x.harness.inspection.pendingInteractions.length, 1);
    x.questions.preferences = async () => ({ attentionNotifications: false });
    await x.questions.tick(); await setImmediate();
    assert.equal(x.harness.inspection.pendingInteractions.length, 0);
  } finally { await x.close(); }
});

test("dismissal and reload retain the inbox item without repeating a phone prompt", async () => {
  const x = setup();
  try {
    x.add(); await x.questions.tick();
    x.harness.behavior.cancelInteraction(x.harness.inspection.pendingInteractions[0].id);
    await setImmediate(); await x.questions.dispose();
    const restarted = new AttentionQuestions(x.bb, new Store(x.store.db), x.send, () => {});
    await restarted.tick();
    assert.equal(x.harness.inspection.pendingInteractions.length, 0);
    assert.equal(x.store.attention.get("question")?.status, "open");
    await restarted.dispose();
  } finally { await x.close(); }
});

test("questions queue behind an existing provider question without revealing its thread", async () => {
  const x = setup();
  try {
    x.add();
    x.harness.inspection.sdk.stub("threads.interactions.list", async () => [{ status: "pending" }]);
    await x.questions.tick();
    assert.equal(x.harness.inspection.pendingInteractions.length, 0);
    assert.equal(x.visibility(), "hidden");
    x.harness.inspection.sdk.stub("threads.interactions.list", async () => []);
    await x.questions.tick();
    assert.equal(x.harness.inspection.pendingInteractions.length, 1);
  } finally { await x.close(); }
});

test("a stale answer cannot acknowledge or reply to a snoozed request", async () => {
  const x = setup();
  try {
    x.add(); await x.questions.tick();
    const pending = x.harness.inspection.pendingInteractions[0];
    x.store.attention.update("question", "snooze", 60);
    await pending.describeSubmission!({ action: "reply", text: "Stale" });
    x.harness.behavior.submitInteraction(pending.id, { action: "reply", text: "Stale" });
    await setImmediate(); await x.questions.tick();
    assert.equal(x.replies.length, 0);
    assert.equal(x.store.attention.get("question")?.status, "snoozed");
  } finally { await x.close(); }
});

test("channel archive and deletion cancel active questions", async () => {
  for (const remove of [false, true]) {
    const x = setup();
    try {
      x.add(); await x.questions.tick();
      if (remove) x.store.deleteRoom(x.room.id);
      else x.store.putRoom({ ...x.room, archived: true });
      await x.questions.tick(); await setImmediate();
      assert.equal(x.harness.inspection.pendingInteractions.length, 0);
      assert.equal(x.visibility(), "hidden");
    } finally { await x.close(); }
  }
});

test("one undeliverable answer does not block later answers or new questions", async () => {
  const x = setup();
  try {
    x.add("bad"); x.add("good"); x.add("next");
    x.store.db.prepare("INSERT INTO attention_question_replies(id,attention_id,room_id,text,revision) VALUES (?,?,?,?,?)")
      .run("bad-reply", "bad", x.room.id, "@retired", 0);
    x.store.db.prepare("INSERT INTO attention_question_replies(id,attention_id,room_id,text,revision) VALUES (?,?,?,?,?)")
      .run("good-reply", "good", x.room.id, "Friday", 0);
    for (const id of ["bad", "good"])
      x.store.db.prepare("INSERT INTO attention_questions VALUES (?,?,?,?)").run(id, 0, "work", "settled");
    const q = new AttentionQuestions(x.bb, x.store, async input => {
      if (input.text === "@retired") throw new Error("Restore the retired bot before mentioning it.");
      await x.send(input);
    }, () => {});
    await q.tick();
    assert.equal(x.replies.length, 1);
    assert.match(x.store.attention.view(x.store.attention.get("bad")!).pendingReply!.error!, /retired bot/);
    assert.equal(x.store.attention.get("bad")?.status, "open");
    assert.equal(x.store.attention.get("good")?.status, "acknowledged");
    assert.equal(x.harness.inspection.pendingInteractions.length, 1);
    await q.dispose();
  } finally { await x.close(); }
});

test("unissued requests older than one day still open; delayed old answers cannot acknowledge new revisions", async () => {
  const x = setup();
  try {
    x.add();
    const value = { ...x.store.attention.get("question")!, updatedAt: Date.now() - 2 * 86400000 };
    x.store.db.prepare("UPDATE channel_attention SET json=? WHERE id=?").run(JSON.stringify(value), value.id);
    await x.questions.tick();
    const pending = x.harness.inspection.pendingInteractions[0];
    assert.ok(pending);
    await pending.describeSubmission!({ action: "reply", text: "Friday" });
    x.harness.behavior.submitInteraction(pending.id, { action: "reply", text: "Friday" });
    await setImmediate();
    x.store.attention.update("question", "snooze", 60);
    x.store.attention.update("question", "reopen");
    await x.questions.tick();
    assert.equal(x.replies.length, 1);
    assert.equal(x.store.attention.get("question")?.status, "open");
    assert.equal(x.harness.inspection.pendingInteractions.length, 1);
  } finally { await x.close(); }
});

test("discard cannot report success while a failed answer is being retried", async () => {
  const x = setup();
  let release!: () => void;
  const sending = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  const service = new AttentionQuestions(x.bb, x.store, async input => {
    started(); await sending; await x.send(input);
  }, () => {});
  try {
    x.add();
    const id = randomUUID();
    x.store.db.prepare("INSERT INTO attention_question_replies(id,attention_id,room_id,text,revision,error) VALUES (?,?,?,?,?,?)")
      .run(id, "question", x.room.id, "Friday", 0, "Temporary failure");
    const tick = service.tick(); await began;
    assert.throws(() => service.discardReply(id), /being sent/);
    release(); await tick;
    assert.equal(x.replies.length, 1);
    assert.equal(x.store.attention.get("question")?.status, "acknowledged");
    assert.throws(() => service.discardReply(id), /no longer waiting/);
  } finally { release(); await service.dispose(); await x.close(); }
});

test("discard removes only the displayed failed reply across request revisions", async () => {
  const x = setup();
  try {
    x.add();
    const older = randomUUID(), newer = randomUUID();
    const put = x.store.db.prepare("INSERT INTO attention_question_replies(id,attention_id,room_id,text,revision,error) VALUES (?,?,?,?,?,?)");
    put.run(older, "question", x.room.id, "Friday", 0, "Invalid reply target");
    put.run(newer, "question", x.room.id, "Monday", 2, null);
    assert.equal(x.store.attention.view(x.store.attention.get("question")!).pendingReply?.id, older);
    x.questions.discardReply(older);
    assert.equal(x.store.attention.view(x.store.attention.get("question")!).pendingReply?.id, newer);
    assert.throws(() => x.questions.discardReply(newer), /Only a failed answer/);
  } finally { await x.close(); }
});

test("archived-channel answers cannot fill the delivery batch ahead of active channels", async () => {
  const x = setup();
  try {
    x.add();
    const archived = { ...x.room, id: randomUUID(), archived: true };
    x.store.putRoom(archived);
    const put = x.store.db.prepare("INSERT INTO attention_question_replies(id,attention_id,room_id,text,revision) VALUES (?,?,?,?,?)");
    for (let i = 0; i < 50; i++) put.run(randomUUID(), "old", archived.id, "Hold", 0);
    put.run(randomUUID(), "question", x.room.id, "Friday", 0);
    await x.questions.tick();
    assert.equal(x.replies.length, 1);
    assert.equal((x.replies[0] as { text: string }).text, "Friday");
    assert.equal((x.store.db.prepare("SELECT count(*) AS n FROM attention_question_replies").get() as { n: number }).n, 50);
  } finally { await x.close(); }
});
