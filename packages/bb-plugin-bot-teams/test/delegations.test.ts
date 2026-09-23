import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { Store } from "../store";
import { Runtime } from "../runtime";
import { botSchema, roomSchema, type Job } from "../contract";
import { agentAuthor } from "../agent-channels";

function setup() {
  const host = createFakePluginHost({
    pluginId: "bot-teams",
    sdk: {
      threads: {
        stop: async () => ({ ok: true }),
        queuedMessages: { list: async () => [] },
      },
    },
  });
  const store = new Store(host.bb.storage.database()),
    runtime = new Runtime(host.bb, store);
  const bots = ["Atlas", "Scribe", "Scout"].map((name, i) =>
    botSchema.parse({
      id: `bot_${String(i + 1).padStart(16, "0")}`,
      name,
      handle: name.toLowerCase(),
      home: `/tmp/return-${name}`,
      projectId: "p",
      hostId: "h",
      paused: false,
      createdAt: 1,
      updatedAt: 1,
      lastWakeAt: 0,
      error: null,
    }),
  );
  for (const bot of bots) store.put(bot);
  const room = roomSchema.parse({
    id: randomUUID(),
    name: "Research",
    memberIds: bots.map((bot) => bot.id),
    paused: false,
    createdAt: 1,
    updatedAt: 1,
  });
  store.putRoom(room);
  runtime.returnDecision = async () => true;
  const request = runtime.send(
    room,
    "@atlas Investigate and summarize",
    randomUUID(),
  );
  const source = store.requestJobs(request.id)[0]!;
  async function collect() {
    await runtime.driveRoom(store.room(room.id));
    await new Promise((resolve) => setImmediate(resolve));
  }
  async function finish(
    job: Job,
    reply: string,
    status: Job["status"] = "done",
    error: string | null = null,
  ) {
    store.putJob({ ...job, status, reply, error });
    await collect();
  }
  const returns = () =>
    store.requestJobs(request.id).filter((job) => job.returnOf);
  return {
    ...host,
    store,
    runtime,
    bots,
    room,
    request,
    source,
    collect,
    finish,
    returns,
    close: async () => {
      await runtime.dispose();
      await host.harness.lifecycle.dispose();
    },
  };
}

test("a direct delegate returns to its requester once without mentioning it", async () => {
  const x = setup();
  try {
    await x.finish(x.source, "@scribe Review the query performance");
    const delegate = x.store.work(x.bots[1]!.id)[0]!;
    assert.equal(x.returns().length, 0);
    await x.finish(delegate, "The query needs an index on room_id.");
    assert.equal(x.returns().length, 1);
    const returned = x.returns()[0]!;
    assert.equal(returned.botId, x.bots[0]!.id);
    assert.equal(returned.conversationKey, x.source.conversationKey);
    assert.match(returned.text, /index on room_id/);
    assert.match(returned.text, /"status":"success"/);
    await x.collect();
    await x.collect();
    assert.equal(x.returns().length, 1);
  } finally {
    await x.close();
  }
});

test("broadcast final answers delegate to channel members and return once", async () => {
  for (const alias of ["all", "channel", "everyone"]) {
    const x = setup();
    try {
      await x.finish(x.source, `@${alias} Review the query performance`);
      const delegates = x.store
        .requestJobs(x.request.id)
        .filter((job) => job.id !== x.source.id);
      assert.deepEqual(
        delegates.map((job) => job.botId).sort(),
        x.bots.slice(1).map((bot) => bot.id).sort(),
      );
      await x.finish(delegates[0]!, "First review complete.");
      assert.equal(x.returns().length, 0);
      await x.finish(delegates[1]!, "Second review complete.");
      assert.equal(x.returns().length, 1);
      assert.equal(x.returns()[0]!.botId, x.source.botId);
      // A synthesis turn must not start another broadcast handoff.
      await x.finish(x.returns()[0]!, `@${alias} Both reviews complete.`);
      assert.equal(x.store.requestJobs(x.request.id).length, 4);
    } finally {
      await x.close();
    }
  }
});

test("fan-out waits for every direct delegate and returns all outcomes once", async () => {
  const x = setup();
  try {
    await x.finish(x.source, "@scribe Check storage. @scout Check the UI.");
    const b = x.store.work(x.bots[1]!.id)[0]!,
      c = x.store.work(x.bots[2]!.id)[0]!;
    await x.finish(b, "Storage looks correct.");
    assert.equal(x.returns().length, 0);
    await x.finish(c, "The empty state is broken.");
    assert.equal(x.returns().length, 1);
    assert.match(x.returns()[0]!.text, /Storage looks correct/);
    assert.match(x.returns()[0]!.text, /empty state is broken/);
  } finally {
    await x.close();
  }
});

test("failures and cancellations are included after all delegates settle", async () => {
  const x = setup();
  try {
    await x.finish(x.source, "@scribe Check storage. @scout Check the UI.");
    await x.finish(
      x.store.work(x.bots[1]!.id)[0]!,
      "",
      "error",
      "Provider unavailable",
    );
    assert.equal(x.returns().length, 0);
    await x.finish(
      x.store.work(x.bots[2]!.id)[0]!,
      "",
      "cancelled",
      "Stopped by the owner",
    );
    assert.match(x.returns()[0]!.text, /"status":"failure"/);
    assert.match(x.returns()[0]!.text, /"status":"cancelled"/);
    assert.match(x.returns()[0]!.text, /Provider unavailable/);
  } finally {
    await x.close();
  }
});

test("a delegate that cannot start times out and reports that status", async () => {
  const x = setup();
  try {
    await x.finish(x.source, "@scribe Review storage");
    const group = x.runtime.delegations.pending(x.room.id)[0]!;
    x.runtime.delegations.put({ ...group, deadlineAt: Date.now() - 1 });
    await x.collect();
    assert.equal(x.returns().length, 1);
    assert.match(x.returns()[0]!.text, /"status":"timeout"/);
    const child = x.store
      .requestJobs(x.request.id)
      .find((job) => job.delegationId)!;
    assert.equal(child.status, "cancelled");
    assert.equal(child.timedOut, true);
  } finally {
    await x.close();
  }
});

test("unrelated replies do not settle a delegation or wake its requester", async () => {
  const x = setup();
  try {
    await x.finish(x.source, "@scribe Review storage");
    const unrelated = x.runtime.send(
      x.store.room(x.room.id),
      "@scout An unrelated question",
      randomUUID(),
    );
    await x.finish(x.store.requestJobs(unrelated.id)[0]!, "Unrelated result");
    assert.equal(x.returns().length, 0);
    await x.finish(x.store.work(x.bots[1]!.id)[0]!, "Storage is ready.");
    assert.equal(x.returns().length, 1);
    assert.doesNotMatch(x.returns()[0]!.text, /Unrelated result/);
  } finally {
    await x.close();
  }
});

test("classifier-identified acknowledgments do not wake the requester", async () => {
  const x = setup();
  try {
    let inspected = "";
    x.runtime.returnDecision = async (group) => {
      inspected = x.runtime.delegations.classificationPrompt(group);
      return false;
    };
    await x.finish(x.source, "Thanks @scribe!");
    await x.finish(x.store.work(x.bots[1]!.id)[0]!, "You're welcome, @atlas.");
    await x.collect();
    assert.equal(x.returns().length, 0);
    assert.equal(x.store.work(x.bots[0]!.id).length, 0);
    assert.match(inspected, /Thanks @scribe/);
    assert.match(inspected, /acknowledgments/);
    assert.equal(x.store.runs(x.room.id)[0]!.status, "done");
  } finally {
    await x.close();
  }
});

test("explicit return mentions and synthesis mentions cannot create notification loops", async () => {
  const x = setup();
  try {
    await x.finish(x.source, "@scribe Review storage");
    await x.finish(
      x.store.work(x.bots[1]!.id)[0]!,
      "@atlas The report is ready.",
    );
    assert.equal(x.store.work(x.bots[0]!.id).length, 1);
    const returned = x.returns()[0]!;
    assert.equal(returned.depth, 2);
    await x.finish(returned, "Thanks @scribe. Here is the final synthesis.");
    await x.collect();
    assert.equal(x.store.work(x.bots[0]!.id).length, 0);
    assert.equal(x.store.work(x.bots[1]!.id).length, 0);
    assert.equal(x.returns().length, 1);
  } finally {
    await x.close();
  }
});

test("an interrupted classifier can retry after restart without duplicating a return", async () => {
  const x = setup();
  try {
    x.runtime.returnDecision = async () => {
      throw new Error("offline");
    };
    await x.finish(x.source, "@scribe Review storage");
    await x.finish(x.store.work(x.bots[1]!.id)[0]!, "Ready");
    const group = x.runtime.delegations.pending(x.room.id)[0]!;
    assert.match(group.error!, /offline/);
    x.runtime.delegations.put({ ...group, retryAt: 0 });
    const restarted = new Runtime(x.bb, x.store);
    restarted.returnDecision = async () => true;
    try {
      await restarted.driveRoom(x.store.room(x.room.id));
      await new Promise((resolve) => setImmediate(resolve));
      await restarted.driveRoom(x.store.room(x.room.id));
      assert.equal(x.returns().length, 1);
    } finally {
      await restarted.dispose();
    }
  } finally {
    await x.close();
  }
});

test("archiving the channel during classification suppresses the return", async () => {
  const x = setup();
  try {
    let resolve!: (value: boolean) => void;
    x.runtime.returnDecision = () =>
      new Promise((r) => {
        resolve = r;
      });
    await x.finish(x.source, "@scribe Review storage");
    await x.finish(x.store.work(x.bots[1]!.id)[0]!, "Ready");
    x.store.putRoom({ ...x.store.room(x.room.id), archived: true });
    resolve(true);
    await new Promise((r) => setImmediate(r));
    assert.equal(x.returns().length, 0);
  } finally {
    await x.close();
  }
});

test("a return turn cannot send a fresh cross-channel delegation", async () => {
  const x = setup();
  try {
    await x.finish(x.source, "@scribe Review storage");
    await x.finish(x.store.work(x.bots[1]!.id)[0]!, "Ready");
    const returned = x.returns()[0]!;
    x.store.putJob({
      ...returned,
      status: "running",
      threadId: "return-thread",
    });
    x.store.putConversation({
      id: "return-conversation",
      botId: returned.botId,
      key: returned.conversationKey,
      threadId: "return-thread",
      title: "Research",
      kind: "group",
      createdAt: 1,
    });
    const author = agentAuthor(x.store, "return-thread");
    const other = { ...x.room, id: randomUUID() };
    x.store.putRoom(other);
    assert.throws(
      () =>
        x.runtime.send(
          other,
          "@scribe More work",
          randomUUID(),
          [],
          null,
          author,
        ),
      /handoff limit/,
    );
  } finally {
    await x.close();
  }
});

test("separate cross-channel sends including a reply join one return to the original session", async () => {
  const x = setup();
  try {
    const source = {
      ...x.source,
      status: "running" as const,
      threadId: "source-thread",
    };
    x.store.putJob(source);
    x.store.putConversation({
      id: "source-c",
      botId: source.botId,
      key: source.conversationKey,
      threadId: source.threadId,
      title: "Research",
      kind: "group",
      createdAt: 1,
    });
    const other = {
      ...x.room,
      id: randomUUID(),
      name: "Consultation",
      responseBehavior: "directed" as const,
    };
    x.store.putRoom(other);
    x.store.putMessage({
      id: "prior-b",
      roomId: other.id,
      runId: "prior",
      botId: x.bots[1]!.id,
      speaker: "Scribe",
      text: "Ready for a question.",
      createdAt: 1,
      attachments: [],
      replyTo: null,
    });
    const author = agentAuthor(x.store, source.threadId, other.id);
    const bRequest = x.runtime.send(
      other,
      "Review the database.",
      randomUUID(),
      [],
      "prior-b",
      author,
    );
    const cRequest = x.runtime.send(
      x.store.room(other.id),
      "@scout Review the UI.",
      randomUUID(),
      [],
      null,
      author,
    );
    assert.equal(x.runtime.delegations.pending(x.room.id).length, 1);
    await x.finish(x.store.requestJobs(bRequest.id)[0]!, "Database is ready.");
    assert.equal(x.returns().length, 0);
    await x.finish(source, "[PASS]");
    assert.equal(x.returns().length, 0);
    await x.finish(x.store.requestJobs(cRequest.id)[0]!, "UI needs a fix.");
    assert.equal(x.returns().length, 1);
    assert.equal(
      x.store.message(x.returns()[0]!.triggerMessageId!)?.roomId,
      x.room.id,
    );
    assert.equal(x.returns()[0]!.roomId, x.room.id);
    assert.equal(x.returns()[0]!.conversationKey, source.conversationKey);
    assert.match(x.returns()[0]!.text, /Database is ready/);
    assert.match(x.returns()[0]!.text, /UI needs a fix/);
  } finally {
    await x.close();
  }
});

test("nested direct delegates finish their synthesis before their parent returns", async () => {
  const x = setup();
  try {
    await x.finish(x.source, "@scribe Review the implementation.");
    const b = x.store.work(x.bots[1]!.id)[0]!;
    await x.finish(b, "@scout Check the UI for me.");
    assert.equal(x.returns().length, 0);
    const c = x.store.work(x.bots[2]!.id)[0]!;
    assert.equal(c.depth, 2);
    await x.finish(c, "The UI is correct.");
    const bReturn = x.returns().find((job) => job.botId === x.bots[1]!.id)!;
    assert.ok(bReturn);
    assert.equal(
      x.returns().filter((job) => job.botId === x.bots[0]!.id).length,
      0,
    );
    await x.finish(bReturn, "The implementation is correct, including the UI.");
    assert.equal(
      x.returns().filter((job) => job.botId === x.bots[0]!.id).length,
      1,
    );
    assert.match(
      x.returns().find((job) => job.botId === x.bots[0]!.id)!.text,
      /including the UI/,
    );
  } finally {
    await x.close();
  }
});

test("a delegated bot's cross-channel return mention cannot wake its ancestor early", async () => {
  const x = setup();
  try {
    await x.finish(x.source, "@scribe Review storage.");
    const child = {
      ...x.store.work(x.bots[1]!.id)[0]!,
      status: "running" as const,
      threadId: "child-thread",
    };
    x.store.putJob(child);
    x.store.putConversation({
      id: "child-c",
      botId: child.botId,
      key: child.conversationKey,
      threadId: child.threadId,
      title: "Research",
      kind: "group",
      createdAt: 1,
    });
    const other = {
      ...x.room,
      id: randomUUID(),
      name: "Other",
      responseBehavior: "everyone" as const,
    };
    x.store.putRoom(other);
    const message = x.runtime.send(
      other,
      "@atlas Here is a progress acknowledgment.",
      randomUUID(),
      [],
      null,
      agentAuthor(x.store, child.threadId, other.id),
    );
    assert.equal(x.store.requestJobs(message.runId).length, 0);
    assert.equal(x.store.work(x.bots[0]!.id).length, 0);
    await x.finish(child, "The report is ready.");
    assert.equal(x.store.work(x.bots[0]!.id).length, 1);
  } finally {
    await x.close();
  }
});

test("delegate retries retain ancestry, renew the deadline, and return once", async () => {
  const x = setup();
  try {
    let finishClassification!: (value: boolean) => void;
    x.runtime.returnDecision = () =>
      new Promise((resolve) => {
        finishClassification = resolve;
      });
    await x.finish(x.source, "@scribe Review storage.");
    const b = x.store.work(x.bots[1]!.id)[0]!;
    await x.finish(b, "", "error", "Temporary failure");
    const group = x.runtime.delegations.pending(x.room.id)[0]!;
    x.runtime.delegations.put({ ...group, deadlineAt: Date.now() - 1 });
    const retry = await x.runtime.retryJob(b.id);
    assert.equal(retry.delegationId, b.delegationId);
    assert.ok(x.runtime.delegations.get(group.id)!.deadlineAt > Date.now());
    finishClassification(true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(x.returns().length, 0);
    x.runtime.returnDecision = async () => true;
    await x.finish(retry, "@atlas The retry succeeded.");
    assert.equal(x.returns().length, 1);
    assert.equal(x.store.work(x.bots[0]!.id).length, 1);
  } finally {
    await x.close();
  }
});

test("cross-channel synthesis replies only reference messages in their destination", async () => {
  const x = setup();
  try {
    const source = {
      ...x.source,
      status: "running" as const,
      threadId: "origin",
    };
    x.store.putJob(source);
    x.store.putConversation({
      id: "origin-c",
      botId: source.botId,
      key: source.conversationKey,
      threadId: "origin",
      title: "Origin",
      kind: "group",
      createdAt: 1,
    });
    const other = { ...x.room, id: randomUUID(), name: "Delegates" };
    x.store.putRoom(other);
    const request = x.runtime.send(
      other,
      "@scribe Review storage",
      randomUUID(),
      [],
      null,
      agentAuthor(x.store, "origin", other.id),
    );
    await x.finish(source, "[PASS]");
    await x.finish(x.store.requestJobs(request.runId)[0]!, "Ready.");
    const returned = x.returns()[0]!;
    assert.equal(
      x.store.message(returned.triggerMessageId!)!.roomId,
      x.room.id,
    );
    await x.finish(returned, "Final synthesis.");
    const reply = x.store.message(returned.id)!;
    assert.equal(x.store.message(reply.replyTo!)!.roomId, reply.roomId);
  } finally {
    await x.close();
  }
});

test("a nested handoff timeout stops descendants and returns a timeout outcome", async () => {
  const x = setup();
  try {
    await x.finish(x.source, "@scribe Review storage.");
    const b = x.store.work(x.bots[1]!.id)[0]!;
    await x.finish(b, "@scout Check the details.");
    const aGroup = x.runtime.delegations.get(`job:${x.source.id}`)!;
    x.runtime.delegations.put({ ...aGroup, deadlineAt: Date.now() - 1 });
    await x.collect();
    await x.collect();
    assert.equal(
      x.returns().filter((job) => job.botId === x.bots[0]!.id).length,
      1,
    );
    assert.match(
      x.returns().find((job) => job.botId === x.bots[0]!.id)!.text,
      /"status":"timeout"/,
    );
    assert.equal(x.store.work(x.bots[2]!.id).length, 0);
  } finally {
    await x.close();
  }
});

test("a requester retry invalidates an in-flight return and cancellation keeps it quiet", async () => {
  const x = setup();
  try {
    const source = { ...x.source, status: "running" as const };
    x.store.putJob(source);
    const request = x.runtime.send(
      x.room,
      "@scribe Review storage.",
      randomUUID(),
      [],
      null,
      {
        botId: source.botId,
        jobId: source.id,
        depth: source.depth + 1,
        speaker: x.bots[0]!.name,
        sourceThreadId: "requester-thread",
      },
    );
    await x.finish(source, "", "error", "Temporary failure");
    let finishClassification!: (value: boolean) => void;
    x.runtime.returnDecision = () =>
      new Promise((resolve) => {
        finishClassification = resolve;
      });
    await x.finish(x.store.requestJobs(request.runId)[0]!, "Storage is ready.");
    const retry = await x.runtime.retryJob(source.id);
    finishClassification(true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(x.returns().length, 0);
    assert.equal(
      x.runtime.delegations.get(`job:${source.id}`)!.status,
      "waiting",
    );
    x.runtime.returnDecision = async () => {
      throw new Error("A cancelled requester must not need classification");
    };
    await x.finish(retry, "", "cancelled", "Stopped by the owner");
    assert.equal(x.returns().length, 0);
    assert.equal(
      x.runtime.delegations.get(`job:${source.id}`)!.status,
      "ignored",
    );
  } finally {
    await x.close();
  }
});

test("a cancelled requester can retry successfully and receive one return", async () => {
  const x = setup();
  try {
    const source = { ...x.source, status: "running" as const };
    x.store.putJob(source);
    const request = x.runtime.send(
      x.room,
      "@scribe Review storage.",
      randomUUID(),
      [],
      null,
      {
        botId: source.botId,
        jobId: source.id,
        depth: source.depth + 1,
        speaker: x.bots[0]!.name,
        sourceThreadId: "requester-thread",
      },
    );
    await x.finish(source, "", "cancelled", "Stopped by the owner");
    const retry = await x.runtime.retryJob(source.id);
    await x.finish(retry, "[PASS]");
    await x.finish(x.store.requestJobs(request.runId)[0]!, "Storage is ready.");
    assert.equal(x.returns().length, 1);
    assert.match(x.returns()[0]!.text, /Storage is ready/);
    await x.collect();
    assert.equal(x.returns().length, 1);
  } finally {
    await x.close();
  }
});
