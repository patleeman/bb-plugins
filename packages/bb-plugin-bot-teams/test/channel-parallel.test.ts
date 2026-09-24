import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  createFakePluginHost,
  makeMessageDispatchHookContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { profileInput, type Bot, type Room } from "../contract";
import { Store } from "../store";
import { Runtime, jobPrompt, primaryLane } from "../runtime";

test("one bot starts work in separate channels while each channel stays serial", async () => {
  let sequence = 0;
  const host = createFakePluginHost({
    pluginId: "bot-teams",
    agentSkillIds: ["bots"],
    sdk: {
      plugins: { callRpc: async (args) => args.outputSchema.parse([]) },
      projects: {
        list: async () => [{
          id: "proj_personal",
          kind: "personal",
          name: "Personal",
          sources: [],
          gitRemoteUrl: null,
          createdAt: 1,
          updatedAt: 1,
        }] as never,
      },
      threads: {
        spawn: async () => makeThreadResponse({
          id: `thr_channel_${++sequence}`,
          status: "active",
        }),
        get: async ({ threadId }) => makeThreadResponse({ id: threadId, status: "active" }),
        queuedMessages: { list: async () => [] },
      },
    },
  });
  const store = new Store(host.bb.storage.database());
  const bot: Bot = {
    ...profileInput.parse({ name: "Atlas" }),
    id: "bot_0123456789abcdef",
    handle: "atlas",
    home: "/tmp/atlas",
    projectId: "proj_test",
    hostId: "host_test",
    paused: false,
    createdAt: 1,
    updatedAt: 1,
    lastWakeAt: Date.now(),
    error: null,
  };
  store.put(bot);
  const room = (name: string): Room => ({
    id: randomUUID(),
    name,
    memberIds: [bot.id],
    paused: false,
    createdAt: 1,
    updatedAt: 1,
    responseBehavior: "directed",
  });
  const firstRoom = room("First"), secondRoom = room("Second");
  store.putRoom(firstRoom);
  store.putRoom(secondRoom);
  const runtime = new Runtime(host.bb, store);
  await plugin(host.bb);
  let releaseSlow: (() => void) | undefined;
  try {
    const send = (target: Room, text: string) =>
      runtime.send(target, text, randomUUID(), [], null, undefined, undefined, "followup");
    const first = send(firstRoom, "@atlas First task");
    const later = send(firstRoom, "@atlas Later task");
    await runtime.tick();
    const firstJob = store.job(`${first.id}:${bot.id}`)!;
    assert.equal(firstJob.status, "running");
    const hook = host.harness.inspection.registrations.hooks["message.dispatch"]!;
    assert.equal((await hook(makeMessageDispatchHookContext({
      thread: { id: firstJob.threadId! },
      origin: "plugin",
      originPluginId: "bot-teams",
      input: { text: jobPrompt(firstJob) },
    }))).action, "proceed");

    const other = send(secondRoom, "@atlas Other task");
    await runtime.tick();
    const laterJob = store.job(`${later.id}:${bot.id}`)!;
    const otherJob = store.job(`${other.id}:${bot.id}`)!;
    assert.equal(firstJob.status, "running");
    assert.equal(otherJob.status, "running");
    assert.equal(laterJob.status, "queued");
    assert.notEqual(firstJob.threadId, otherJob.threadId);
    assert.notEqual(primaryLane(bot.id, firstJob.conversationKey), primaryLane(bot.id, otherJob.conversationKey));
    assert.equal((await runtime.roomJobsWithActivity(firstRoom.id)).find((job) => job.id === laterJob.id)?.queuePosition, 2);
    assert.equal(host.harness.inspection.sdk.callsTo("threads.spawn").length, 2);

    assert.equal((await hook(makeMessageDispatchHookContext({
      thread: { id: otherJob.threadId! },
      origin: "plugin",
      originPluginId: "bot-teams",
      input: { text: jobPrompt(otherJob) },
    }))).action, "proceed");

    const thirdRoom = room("Third"), fourthRoom = room("Fourth");
    store.putRoom(thirdRoom);
    store.putRoom(fourthRoom);
    const slow = send(thirdRoom, "@atlas Slow dispatch");
    const fast = send(fourthRoom, "@atlas Independent dispatch");
    let notifyEntered!: () => void;
    const entered = new Promise<void>((resolve) => { notifyEntered = resolve; });
    const hold = new Promise<void>((resolve) => { releaseSlow = resolve; });
    host.harness.inspection.sdk.stub("threads.spawn", async () => {
      const id = `thr_channel_${++sequence}`;
      if (id === "thr_channel_3") {
        notifyEntered();
        await hold;
      }
      return makeThreadResponse({ id, status: "active" });
    });
    const driving = runtime.drive(bot);
    await entered;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(store.job(`${slow.id}:${bot.id}`)?.status, "dispatching");
    assert.equal(store.job(`${fast.id}:${bot.id}`)?.status, "running");
    releaseSlow?.();
    await driving;
    assert.equal(store.job(`${slow.id}:${bot.id}`)?.status, "running");
  } finally {
    releaseSlow?.();
    await runtime.dispose();
    await host.harness.lifecycle.dispose();
  }
});
