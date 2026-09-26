import test from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { usePersonalProject } from "../bot-project";
import { Store } from "../store";
import { botSchema, jobSchema } from "../contract";

const personal = {
  id: "personal_from_sdk",
  kind: "personal" as const,
  name: "Personal",
  sources: [],
  gitRemoteUrl: null,
  createdAt: 1,
  updatedAt: 1,
};

test("repairs deleted-project profiles without replacing bot homes, history, or schedule settings", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "bot-teams",
    sdk: { projects: { list: async () => [personal] } },
  });
  const store = new Store(bb.storage.database());
  const bot = botSchema.parse({
    id: "bot_0123456789abcdef",
    name: "Atlas",
    handle: "atlas",
    home: "/old/bot/home",
    hostId: "host_old",
    projectId: "deleted_project",
    createdAt: 1,
    updatedAt: 1,
    lastWakeAt: 1,
    error: null,
  });
  store.put(bot);
  store.enqueue(
    jobSchema.parse({
      id: "cancelled-dispatch",
      botId: bot.id,
      conversationKey: "mission",
      threadId: null,
      text: "Work",
      status: "cancelled",
      reply: null,
      error: "Cancelled by the owner.",
      cancellationPending: true,
      createdAt: 1,
      updatedAt: 1,
      startedAt: null,
      roomId: null,
      runId: null,
    }),
  );
  store.putConversation({
    id: "conversation",
    botId: bot.id,
    key: "mission",
    threadId: "live_thread",
    kind: "mission",
    title: "Mission",
    createdAt: 1,
  });
  await bb.storage.kv.set("projectId", "deleted_project");
  try {
    assert.equal(await usePersonalProject(bb, store), personal.id);
    assert.deepEqual(store.get(bot.id), { ...bot, projectId: personal.id });
    assert.equal(store.conversations(bot.id)[0]?.threadId, "live_thread");
    assert.equal(store.job("cancelled-dispatch")?.status, "cancelled");
    assert.equal(store.job("cancelled-dispatch")?.cancellationPending, false);
    assert.deepEqual(await bb.storage.kv.get("previousProjectIds"), [
      "deleted_project",
    ]);
    assert.equal(await bb.storage.kv.get("projectId"), personal.id);
    assert.equal(await usePersonalProject(bb, store), personal.id);
    assert.deepEqual(harness.inspection.sdk.callsTo("projects.list")[0], [
      { includePersonal: true },
    ]);
    assert.equal(harness.inspection.sdk.callsTo("projects.create").length, 0);
    harness.inspection.sdk.stub("projects.list", async () => {
      throw new Error("offline");
    });
    await assert.rejects(usePersonalProject(bb, store), /offline/);
    assert.equal(store.get(bot.id).projectId, personal.id);
    harness.inspection.sdk.stub("projects.list", async () => []);
    await assert.rejects(
      usePersonalProject(bb, store),
      /Personal project is unavailable/,
    );
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("paused bots from before pause was removed keep their schedules off", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "bot-teams" });
  try {
    const db = bb.storage.database();
    new Store(db);
    const legacy = (id: string, paused: boolean) =>
      JSON.stringify({
        ...botSchema.parse({
          id,
          name: id,
          handle: id,
          home: `/homes/${id}`,
          hostId: "host",
          projectId: "project",
          intervalMinutes: 30,
          createdAt: 1,
          updatedAt: 1,
          lastWakeAt: 1,
          error: null,
        }),
        paused,
      });
    const insert = db.prepare("INSERT INTO bots VALUES (?,?)");
    insert.run("bot_0000000000000001", legacy("bot_0000000000000001", true));
    insert.run("bot_0000000000000002", legacy("bot_0000000000000002", false));
    const store = new Store(db);
    const [paused, running] = store.all();
    assert.equal(paused!.intervalMinutes, 0);
    assert.equal(running!.intervalMinutes, 30);
    assert.ok(!("paused" in paused!) && !("paused" in running!));
  } finally {
    await harness.lifecycle.dispose();
  }
});
