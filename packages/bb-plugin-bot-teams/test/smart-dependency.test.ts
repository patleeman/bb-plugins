import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { Store } from "../store";
import { Runtime } from "../runtime";
import { botSchema, roomSchema, type Job } from "../contract";
import type { RoutingPlan } from "../send-mode";
import { requestStatus } from "../agent-channels";

function setup(executionMode: "serialized" | "parallel") {
  const host = createFakePluginHost({ pluginId: "bot-teams", sdk: { threads: { stop: async () => ({ ok: true }), queuedMessages: { list: async () => [] } } } });
  const store = new Store(host.bb.storage.database());
  const runtime = new Runtime(host.bb, store);
  const bots = ["News Desk", "Secretary", "Researcher"].map((name, i) => botSchema.parse({
    id: `bot_${String(i + 1).padStart(16, "0")}`,
    name,
    handle: ["news-desk", "secretary", "researcher"][i],
    home: `/tmp/smart-dependency-${i}`,
    projectId: "p", hostId: "h", createdAt: 1, updatedAt: 1, lastWakeAt: 0, error: null,
  }));
  for (const bot of bots) store.put(bot);
  const room = roomSchema.parse({ id: randomUUID(), name: "News", memberIds: bots.map((bot) => bot.id), responseBehavior: "smart", paused: false, createdAt: 1, updatedAt: 1 });
  store.putRoom(room);
  const plan: RoutingPlan = {
    coordinatorId: bots[0]!.id, collaboratorIds: [bots[1]!.id], executionMode,
    finalizerId: bots[0]!.id,
    routes: (executionMode === "parallel" ? bots.slice(0, 2) : bots.slice(0, 1)).map((bot) => ({ botId: bot.id, action: "followup" })),
    source: "jev",
  };
  runtime.route = async () => plan;
  runtime.returnDecision = async () => true;
  async function collect() {
    await runtime.driveRoom(store.room(room.id));
    await new Promise((resolve) => setImmediate(resolve));
  }
  async function finish(job: Job, reply: string, status: Job["status"] = "done", error: string | null = null) {
    store.putJob({ ...job, status, reply, error });
    await collect();
  }
  return { ...host, store, runtime, bots, room, collect, finish,
    close: async () => { await runtime.dispose(); await host.harness.lifecycle.dispose(); } };
}

test("Smart serializes a coordinator and dependency, then returns one final answer", async () => {
  const x = setup("serialized");
  try {
    const request = x.runtime.send(x.room, "@news-desk work with @secretary", randomUUID());
    assert.equal(x.store.requestJobs(request.id).length, 0);
    await x.collect();
    const primary = x.store.requestJobs(request.id)[0]!;
    assert.equal(primary.botId, x.bots[0]!.id);
    assert.equal(x.store.requestJobs(request.id).length, 1);
    assert.deepEqual(x.store.message(request.id)?.classifierPlan?.collaboratorIds, [x.bots[1]!.id]);
    await x.finish(primary, "@secretary Check the facts.");
    const helper = x.store.requestJobs(request.id).find((job) => job.botId === x.bots[1]!.id)!;
    assert.equal(helper.parentTaskId, primary.id);
    await x.finish(helper, "@news-desk The facts check out.");
    const returned = x.store.requestJobs(request.id).filter((job) => job.returnOf);
    assert.equal(returned.length, 1);
    assert.equal(returned[0]!.botId, primary.botId);
    await x.finish(returned[0]!, "Here is the final report.");
    await x.collect();
    assert.deepEqual(x.store.visibleMessages(x.room.id).map((message) => message.text), [request.text, "Here is the final report."]);
    assert.equal(x.store.runs(x.room.id)[0]!.finalMessageId, returned[0]!.id);
    assert.equal(x.store.requestJobs(request.id).filter((job) => job.returnOf).length, 1);
  } finally { await x.close(); }
});

test("Smart parallel work waits for both contributors and blocks a reciprocal wake", async () => {
  const x = setup("parallel");
  try {
    const request = x.runtime.send(x.room, "@news-desk and @secretary each weigh in", randomUUID());
    await x.collect();
    const jobs = x.store.requestJobs(request.id);
    assert.deepEqual(jobs.map((job) => job.botId), [x.bots[0]!.id, x.bots[1]!.id]);
    assert.equal(jobs[1]!.parentTaskId, jobs[0]!.id);
    await x.finish(jobs[1]!, "@news-desk My independent view.");
    assert.equal(x.store.requestJobs(request.id).length, 2);
    assert.equal(x.store.visibleMessages(x.room.id).length, 1);
    assert.equal(requestStatus(x.store, x.room.id, request.id).responses.find((result) => result.botId === jobs[1]!.botId)?.messageId, null);
    await x.finish(jobs[0]!, "My initial view.");
    const returns = x.store.requestJobs(request.id).filter((job) => job.returnOf);
    assert.equal(returns.length, 1);
    assert.match(returns[0]!.text, /My independent view/);
    await x.finish(returns[0]!, "Combined answer.");
    await x.collect();
    assert.deepEqual(x.store.visibleMessages(x.room.id).map((message) => message.text), [request.text, "Combined answer."]);
    assert.deepEqual(x.store.transcript(x.room.id).messages.map((message) => message.text), [request.text, "Combined answer."]);
    assert.equal(x.store.requestJobs(request.id).filter((job) => job.returnOf).length, 1);
  } finally { await x.close(); }
});

test("planned parallel work returns helper failure to the coordinator", async () => {
  const x = setup("parallel");
  try {
    const request = x.runtime.send(x.room, "@news-desk and @secretary each weigh in", randomUUID());
    await x.collect();
    const [primary, helper] = x.store.requestJobs(request.id);
    await x.finish(helper!, "", "error", "Provider unavailable");
    await x.finish(primary!, "My initial view.");
    const final = x.store.requestJobs(request.id).find((job) => job.returnOf && job.botId === primary!.botId)!;
    assert.match(final.text, /"status":"failure"/);
    assert.match(final.text, /Provider unavailable/);
    await x.finish(final, "Secretary failed; here is the available answer.");
    assert.equal(x.store.visibleMessages(x.room.id).length, 2);
  } finally { await x.close(); }
});

test("uncertain Smart routing falls back only for one explicit recipient", async () => {
  const x = setup("serialized");
  try {
    x.runtime.route = async () => { throw new Error("Jev unavailable"); };
    const single = x.runtime.send(x.room, "@news-desk review this", randomUUID());
    await x.collect();
    assert.deepEqual(x.store.requestJobs(single.id).map((job) => job.botId), [x.bots[0]!.id]);
    assert.equal(x.store.message(single.id)?.classifierPlan?.source, "fallback");
    const multiple = x.runtime.send(x.room, "@news-desk work with @secretary", randomUUID());
    await x.collect();
    assert.equal(x.store.requestJobs(multiple.id).length, 0);
    assert.equal(x.store.runs(x.room.id).find((run) => run.id === multiple.id)?.routing, "error");
    x.runtime.route = async () => ({ coordinatorId: x.bots[0]!.id, collaboratorIds: [x.bots[1]!.id], executionMode: "serialized", finalizerId: x.bots[0]!.id, routes: [{ botId: x.bots[0]!.id, action: "followup" }], source: "jev" });
    x.runtime.retryRouting(x.room.id, multiple.id);
    await x.collect();
    assert.deepEqual(x.store.requestJobs(multiple.id).map((job) => job.botId), [x.bots[0]!.id]);
  } finally { await x.close(); }
});

test("an unmentioned owner question continues the previous bot answer when Jev fails", async () => {
  const x = setup("serialized");
  try {
    const first = x.runtime.send(x.room, "@news-desk inspect Birdclaw", randomUUID());
    await x.collect();
    const primary = x.store.requestJobs(first.id)[0]!;
    await x.finish(primary, "The database query failed in the sandbox.");
    x.runtime.route = async () => { throw new Error("Jev unavailable"); };
    const followup = x.runtime.send(x.room, "You were querying the db directly??", randomUUID());
    await x.collect();
    assert.deepEqual(x.store.requestJobs(followup.id).map((job) => job.botId), [primary.botId]);
    assert.equal(x.store.message(followup.id)?.classifierPlan?.source, "fallback");
  } finally { await x.close(); }
});

test("an explicit send mode keeps a direct Smart coordinator and its helper lineage", async () => {
  const x = setup("serialized");
  try {
    x.runtime.route = async () => { throw new Error("Single explicit mode must not classify"); };
    const request = x.runtime.send(x.room, "@news-desk check this", randomUUID(), [], null, undefined, undefined, "followup");
    const primary = x.store.requestJobs(request.id)[0]!;
    assert.equal(primary.dispatchAction, "followup");
    assert.equal(primary.coordinatorId, primary.botId);
    await x.finish(primary, "@secretary Check the source.");
    const helper = x.store.requestJobs(request.id).find((job) => job.botId === x.bots[1]!.id)!;
    assert.equal(helper.coordinatorId, primary.botId);
    await x.finish(helper, "Source confirmed.");
    const final = x.store.requestJobs(request.id).find((job) => job.returnOf)!;
    await x.finish(final, "Confirmed final answer.");
    assert.deepEqual(x.store.visibleMessages(x.room.id).map((message) => message.text), [request.text, "Confirmed final answer."]);
  } finally { await x.close(); }
});

test("Smart broadcast with one member publishes its coordinator answer", async () => {
  const x = setup("serialized");
  try {
    const room = { ...x.room, memberIds: [x.bots[0]!.id] };
    x.store.putRoom(room);
    const request = x.runtime.send(room, "@all Review", randomUUID());
    const job = x.store.requestJobs(request.id)[0]!;
    await x.finish(job, "Reviewed.");
    assert.deepEqual(x.store.visibleMessages(room.id).map((message) => message.text), [request.text, "Reviewed."]);
    assert.equal(x.store.runs(room.id)[0]!.finalMessageId, job.id);
  } finally { await x.close(); }
});

test("steering a coordinator with live delegates queues without changing its root", async () => {
  const x = setup("parallel");
  try {
    const request = x.runtime.send(x.room, "@news-desk and @secretary each weigh in", randomUUID());
    await x.collect();
    const primary = x.store.requestJobs(request.id)[0]!;
    x.store.putJob({ ...primary, status: "running", threadId: "thr_primary" });
    const correction = x.runtime.send(x.room, "@news-desk Correct the date", randomUUID(), [], null, undefined, undefined, "steer");
    const original = x.store.job(primary.id)!;
    const queued = x.store.requestJobs(correction.id)[0]!;
    assert.equal(original.runId, request.id);
    assert.equal(queued.dispatchAction, "followup");
    assert.deepEqual(x.store.message(correction.id)?.classifierActions, [{ botId: primary.botId, action: "followup", suggestedAction: "steer" }]);
  } finally { await x.close(); }
});

test("parallel helper retry and nested delegation preserve the coordinator lineage", async () => {
  const x = setup("parallel");
  try {
    const request = x.runtime.send(x.room, "@news-desk and @secretary each weigh in", randomUUID());
    await x.collect();
    const [primary, helper] = x.store.requestJobs(request.id);
    await x.finish(helper!, "", "error", "Provider unavailable");
    const retry = await x.runtime.retryJob(helper!.id);
    assert.equal(retry.rootTaskId, request.id);
    assert.equal(retry.parentTaskId, primary!.id);
    await x.finish(retry, "@researcher Verify this detail.");
    const nested = x.store.requestJobs(request.id).find((job) => job.botId === x.bots[2]!.id)!;
    assert.equal(nested.coordinatorId, primary!.botId);
    await x.finish(nested, "Detail verified.");
    const helperReturn = x.store.requestJobs(request.id).find((job) => job.returnOf && job.botId === helper!.botId)!;
    await x.finish(helperReturn, "Verified helper result.");
    await x.finish(primary!, "My initial view.");
    const final = x.store.requestJobs(request.id).find((job) => job.returnOf && job.botId === primary!.botId)!;
    assert.match(final.text, /Verified helper result/);
    await x.finish(final, "Final answer.");
    assert.deepEqual(x.store.visibleMessages(x.room.id).map((message) => message.text), [request.text, "Final answer."]);
  } finally { await x.close(); }
});
