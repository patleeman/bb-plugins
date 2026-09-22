import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  createFakePluginHost,
  makeThreadResponse,
  makePluginAgentConfigurationContext,
} from "@get-bb/plugin-sdk/testing";
import { z } from "zod";
import plugin from "../server";
import { Store } from "../store";
import { Runtime } from "../runtime";
import { ChannelAutomations, dispatchScript } from "../channel-automations";
import { botSchema, roomSchema } from "../contract";
import {
  channelAutomationCreate,
  channelAutomationList,
  channelAutomationUpdate,
  channelAutomationAction,
  channelAutomationRuns,
} from "../automation-contract";

async function setup() {
  const records = new Map<string, Record<string, any>>();
  const runs = new Map<
    string,
    { id: string; status: string; output?: string }[]
  >();
  let sequence = 0;
  const host = createFakePluginHost({
    pluginId: "bots",
    agentSkillIds: ["bots"],
    sdk: {
      plugins: {
        callRpc: async <T>(args: {
          method: string;
          input?: any;
          outputSchema: z.ZodType<T>;
        }) => {
          const input = args.input;
          const row = records.get(input.automationId);
          let result: unknown;
          switch (args.method) {
            case "automations_list":
              result = [...records.values()].filter(
                (a) => a.projectId === input.projectId,
              );
              break;
            case "automations_create": {
              const id = `auto_${++sequence}`;
              const a = {
                ...input,
                id,
                createdByThreadId: input.createdByThreadId ?? null,
                nextRunAt: input.enabled ? Date.now() + 60_000 : null,
                lastRunAt: null,
                lastRunStatus: null,
                lastError: null,
              };
              records.set(id, a);
              result = a;
              break;
            }
            case "automations_get":
              result = row;
              break;
            case "automations_update":
              Object.assign(row!, input);
              result = row;
              break;
            case "automations_pause":
              row!.enabled = false;
              result = row;
              break;
            case "automations_resume":
              row!.enabled = true;
              result = row;
              break;
            case "automations_delete":
              records.delete(input.automationId);
              result = { ok: true };
              break;
            case "automations_run":
              result = { run: { id: "run_manual", status: "running" } };
              break;
            case "automations_runs":
              result = {
                runs: (runs.get(input.automationId) ?? []).map((run) => ({
                  trigger: "manual",
                  startedAt: 1,
                  finishedAt: 2,
                  error: null,
                  skipReason: null,
                  output: null,
                  ...run,
                })),
                nextCursor: null,
              };
              break;
            default:
              throw new Error(args.method);
          }
          return args.outputSchema.parse(result);
        },
      },
      threads: {
        send: async () => ({ ok: true, delivery: "sent" }),
        spawn: async () =>
          makeThreadResponse({ id: `thr_work_${++sequence}`, status: "idle" }),
        get: async () => makeThreadResponse({ status: "idle" }),
        list: async () => [],
        stop: async () => ({ ok: true }),
        queuedMessages: {
          list: async () => [],
          delete: async () => ({ ok: true }),
        },
      },
    },
  });
  await plugin(host.bb);
  const store = new Store(host.bb.storage.database());
  const runtime = new Runtime(host.bb, store);
  const service = new ChannelAutomations(host.bb, store, runtime);
  const a = botSchema.parse({
    id: "bot_0123456789abcdef",
    name: "Atlas",
    handle: "atlas",
    home: "/tmp/atlas",
    hostId: "host_test",
    projectId: "proj_bots",
    paused: true,
    createdAt: 1,
    updatedAt: 1,
    lastWakeAt: 1,
    error: null,
  });
  const b = botSchema.parse({
    ...a,
    id: "bot_1123456789abcdef",
    name: "Scribe",
    handle: "scribe",
  });
  store.put(a);
  store.put(b);
  const room = roomSchema.parse({
    id: randomUUID(),
    name: "Research",
    memberIds: [a.id, b.id],
    paused: false,
    responseBehavior: "smart",
    createdAt: 1,
    updatedAt: 1,
  });
  store.putRoom(room);
  function active(botId = a.id, automationId?: string) {
    const threadId = `thr_${randomUUID()}`,
      jobId = randomUUID();
    runtime.enqueue(store.get(botId), {
      id: jobId,
      text: "normal channel request",
      conversationKey: `group:${room.id}`,
      roomId: room.id,
      status: "running",
      threadId,
      ...(automationId ? { automationId } : {}),
    });
    store.putConversation({
      id: randomUUID(),
      botId,
      key: `group:${room.id}:${jobId}`,
      kind: "group",
      title: room.name,
      threadId,
      createdAt: 1,
    });
    return { threadId, jobId };
  }
  function input(patch = {}) {
    return channelAutomationCreate.parse({
      channelId: room.id,
      botId: a.id,
      name: "Daily questions",
      prompt: "Summarize open questions.",
      requestId: randomUUID(),
      trigger: {
        triggerType: "schedule",
        cron: "0 9 * * 1-5",
        timezone: "America/New_York",
      },
      ...patch,
    });
  }
  return {
    ...host,
    store,
    runtime,
    service,
    records,
    runs,
    a,
    b,
    room,
    active,
    input,
  };
}

test("run history stays in its channel, preserves failures, and bounds output", async () => {
  const x = await setup();
  try {
    const a = await x.service.create(x.input());
    x.runs.set(a.id, [
      { id: "manual", status: "failed", output: "x".repeat(4000) },
    ]);
    const input = channelAutomationRuns.parse({
      channelId: x.room.id,
      automationId: a.id,
    });
    const page = (await x.harness.behavior.callRpc(
      "automationRuns",
      input,
    )) as { runs: { status: string; output: string }[]; nextCursor: null };
    assert.equal(page.runs[0]!.status, "failed");
    assert.equal(page.runs[0]!.output.length, 2000);
    assert.equal(page.nextCursor, null);
    const other = x.active(x.b.id);
    await assert.rejects(
      x.service.runs(input, other.threadId),
      /own channel automations/,
    );
  } finally {
    await x.harness.lifecycle.dispose();
  }
});

test("a bot creates in its current channel with bound identity and safe retry after a lost response", async () => {
  const x = await setup();
  try {
    const { threadId } = x.active();
    const input = x.input({
      channelId: undefined,
      botId: undefined,
      prompt:
        "Report 'quotes', `commands`, $(substitution), and @all as task data.",
    });
    const tool = () =>
      x.harness.behavior.callAgentTool(
        "bots_channel_automation_create",
        input,
        { threadId },
      );
    const [first, second] = await Promise.all([tool(), tool()]);
    assert.equal(first, second);
    assert.equal(x.records.size, 1);
    const record = [...x.records.values()][0]!;
    assert.equal(record.origin, "agent");
    assert.equal(record.createdByThreadId, threadId);
    assert.equal(record.execution.script, dispatchScript);
    assert.ok(!record.execution.script.includes("substitution"));
    const created = JSON.parse(first as string);
    assert.equal(created.botId, x.a.id);
    assert.equal(created.channelId, x.room.id);
    await assert.rejects(
      x.service.create({ ...input, prompt: "different" }, threadId),
      /requestId/,
    );
    await assert.rejects(
      x.service.create(x.input({ botId: x.b.id }), threadId),
      /own channel work/,
    );
    const config = await x.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ thread: { id: threadId } }),
    );
    assert.ok(
      JSON.stringify(config).includes("bots_channel_automation_create"),
    );
  } finally {
    await x.harness.lifecycle.dispose();
  }
});

test("channel schedules enforce membership and ownership while listing bounded pages", async () => {
  const x = await setup();
  try {
    const first = await x.service.create(x.input());
    const second = await x.service.create(x.input({ botId: x.b.id }));
    const page = await x.service.list(
      channelAutomationList.parse({ channelId: x.room.id, limit: 1 }),
    );
    assert.equal(page.automations.length, 1);
    assert.equal(page.nextOffset, 1);
    const caller = x.active();
    await assert.rejects(
      x.service.action(
        channelAutomationAction.parse({
          automationId: second.id,
          action: "pause",
        }),
        caller.threadId,
      ),
      /own channel automations/,
    );
    const updated = await x.service.update(
      channelAutomationUpdate.parse({
        automationId: first.id,
        prompt: "New prompt",
      }),
      caller.threadId,
    );
    assert.equal(updated.prompt, "New prompt");
    assert.deepEqual(updated.trigger, first.trigger);
    await x.service.action(
      channelAutomationAction.parse({
        automationId: first.id,
        action: "pause",
      }),
      caller.threadId,
    );
    assert.equal(x.records.get(first.id)!.enabled, false);
    const other = {
      ...x.room,
      id: randomUUID(),
      name: "Elsewhere",
      memberIds: [x.b.id],
    };
    x.store.putRoom(other);
    await assert.rejects(
      x.service.list(
        channelAutomationList.parse({ channelId: other.id }),
        caller.threadId,
      ),
      /invited/,
    );
    await assert.rejects(
      x.service.action(
        channelAutomationAction.parse({
          channelId: other.id,
          automationId: first.id,
          action: "delete",
        }),
      ),
      /not found in this channel/,
    );
  } finally {
    await x.harness.lifecycle.dispose();
  }
});

test("dispatch is idempotent, selects only its bot, and uses current channel context", async () => {
  const x = await setup();
  try {
    const a = await x.service.create(
      x.input({ prompt: "Summarize questions mentioning @all and @scribe." }),
    );
    x.runs.set(a.id, [
      { id: "run_1", status: "running" },
      { id: "run_2", status: "running" },
    ]);
    const first = await x.service.dispatch(a.projectId, a.id, "run_1");
    const restarted = new ChannelAutomations(x.bb, x.store, x.runtime);
    assert.deepEqual(
      await restarted.dispatch(a.projectId, a.id, "run_1"),
      first,
    );
    assert.equal(x.store.work(x.a.id).length, 1);
    assert.equal(x.store.work(x.b.id).length, 0);
    assert.equal(x.store.work(x.a.id)[0]!.automationId, a.id);
    assert.equal(
      (await x.service.dispatch(a.projectId, a.id, "run_2")).wakeAgent,
      false,
    );
    x.store.putRoom({ ...x.room, responseBehavior: "directed" });
    x.runtime.send(
      x.store.room(x.room.id),
      "The latest release code is ORBIT-42.",
      randomUUID(),
    );
    await x.runtime.drive(x.a);
    const args = x.harness.inspection.sdk.callsTo("threads.spawn")[0]![0];
    assert.ok(JSON.stringify(args).includes("ORBIT-42"));
    const job = x.store.work(x.a.id)[0]!;
    x.runtime.complete(job.threadId!, "The release code is ORBIT-42.");
    await x.runtime.driveRoom(x.room);
    const reply = x.store.message(job.id)!;
    assert.equal(reply.botId, x.a.id);
    assert.equal(reply.automationId, a.id);
    assert.ok(
      "requestId" in (await x.service.dispatch(a.projectId, a.id, "run_2")),
    );
  } finally {
    await x.harness.lifecycle.dispose();
  }
});

test("dispatcher rejects forged, finished, or agent-invoked runs and skips inactive channel targets", async () => {
  const x = await setup();
  try {
    const a = await x.service.create(x.input());
    x.runs.set(a.id, [
      { id: "active", status: "running" },
      { id: "done", status: "succeeded" },
    ]);
    await assert.rejects(
      x.service.dispatch(a.projectId, a.id, "active", "thr_agent"),
      /Only the automation runner/,
    );
    await assert.rejects(
      x.service.dispatch(a.projectId, a.id, "missing"),
      /no longer active/,
    );
    await assert.rejects(
      x.service.dispatch(a.projectId, a.id, "done"),
      /no longer active/,
    );
    x.store.putRoom({ ...x.room, archived: true });
    assert.equal(
      (await x.service.dispatch(a.projectId, a.id, "active")).wakeAgent,
      false,
    );
    x.store.putRoom({ ...x.room, memberIds: [x.b.id] });
    assert.equal(
      (await x.service.dispatch(a.projectId, a.id, "active")).wakeAgent,
      false,
    );
    x.store.putRoom(x.room);
    x.store.put({ ...x.a, retired: true });
    assert.equal(
      (await x.service.dispatch(a.projectId, a.id, "active")).wakeAgent,
      false,
    );
    x.store.put(x.a);
    x.records.get(a.id)!.execution.script = "echo changed";
    await assert.rejects(
      x.service.dispatch(a.projectId, a.id, "active"),
      /not a channel dispatcher/,
    );
    assert.equal(x.store.roomJobs(x.room.id).length, 0);
  } finally {
    await x.harness.lifecycle.dispose();
  }
});

test("scheduled work and its bot handoffs cannot recursively schedule more work", async () => {
  const x = await setup();
  try {
    const a = await x.service.create(x.input());
    x.runs.set(a.id, [{ id: "active", status: "running" }]);
    await x.service.dispatch(a.projectId, a.id, "active");
    await x.runtime.drive(x.a);
    const job = x.store.work(x.a.id)[0]!;
    await assert.rejects(
      x.service.create(x.input(), job.threadId!),
      /Scheduled channel work/,
    );
    await assert.rejects(
      x.service.update(
        channelAutomationUpdate.parse({
          automationId: a.id,
          name: "recursive",
        }),
        job.threadId!,
      ),
      /Scheduled channel work/,
    );
    await assert.rejects(
      x.service.action(
        channelAutomationAction.parse({
          automationId: a.id,
          action: "run",
          requestId: randomUUID(),
        }),
        job.threadId!,
      ),
      /Scheduled channel work/,
    );
    await x.service.action(
      channelAutomationAction.parse({ automationId: a.id, action: "pause" }),
      job.threadId!,
    );
    x.runtime.complete(job.threadId!, "@scribe please check my answer.");
    await x.runtime.driveRoom(x.room);
    const followup = x.store.work(x.b.id)[0]!;
    assert.equal(followup.automationId, a.id);
    await x.runtime.drive(x.b);
    await assert.rejects(
      x.service.create(
        x.input({ botId: x.b.id }),
        x.store.job(followup.id)!.threadId!,
      ),
      /Scheduled channel work/,
    );
    const normal = x.active();
    await x.service.create(x.input(), normal.threadId);
    assert.equal(x.records.size, 2);
  } finally {
    await x.harness.lifecycle.dispose();
  }
});

test("CLI creates one-shot channel work and applies guarded lifecycle actions", async () => {
  const x = await setup();
  try {
    const run = (args: string[]) => x.harness.behavior.runCli(args);
    const at = new Date(Date.now() + 3600_000).toISOString();
    const created = await run([
      "channel",
      "schedule",
      x.room.id,
      "--bot",
      "@atlas",
      "--name",
      "Reminder",
      "--text",
      "Check the answer",
      "--at",
      at,
      "--paused",
      "--json",
    ]);
    assert.equal(created.exitCode, 0, created.stderr);
    const a = JSON.parse(created.stdout!);
    assert.equal(a.enabled, false);
    assert.equal(a.trigger.runAt, Date.parse(at));
    assert.equal(
      (await run(["channel", "automations", x.room.id, "--json"])).exitCode,
      0,
    );
    assert.equal(
      (
        await run([
          "channel",
          "automation",
          x.room.id,
          a.id,
          "resume",
          "--json",
        ])
      ).exitCode,
      0,
    );
    assert.equal(x.records.get(a.id)!.enabled, true);
    assert.notEqual(
      (
        await run([
          "channel",
          "automation",
          x.room.id,
          a.id,
          "delete",
          "--json",
        ])
      ).exitCode,
      0,
    );
    assert.equal(
      (
        await run([
          "channel",
          "automation",
          x.room.id,
          a.id,
          "delete",
          "--yes",
          "--json",
        ])
      ).exitCode,
      0,
    );
    assert.equal(x.records.size, 0);
    const invalid = await run([
      "channel",
      "schedule",
      x.room.id,
      "--name",
      "Invalid",
      "--text",
      "Invalid",
      "--at",
      "2026-09-21T12:00:00",
      "--json",
    ]);
    assert.notEqual(invalid.exitCode, 0);
    assert.match(invalid.stderr!, /UTC offset/);
  } finally {
    await x.harness.lifecycle.dispose();
  }
});

test("retrying a scheduled response retains recursion and overlap protection", async () => {
  const x = await setup();
  try {
    const a = await x.service.create(x.input());
    x.runs.set(a.id, [
      { id: "first", status: "running" },
      { id: "next", status: "running" },
    ]);
    await x.service.dispatch(a.projectId, a.id, "first");
    await x.runtime.drive(x.a);
    const job = x.store.work(x.a.id)[0]!;
    x.runtime.complete(job.threadId!, null, "Temporary failure");
    await x.runtime.driveRoom(x.room);
    const retry = await x.runtime.retryJob(job.id);
    assert.equal(retry.automationId, a.id);
    assert.equal(
      (await x.service.dispatch(a.projectId, a.id, "next")).wakeAgent,
      false,
    );
    await x.runtime.drive(x.a);
    await assert.rejects(
      x.service.create(x.input(), x.store.job(retry.id)!.threadId!),
      /Scheduled channel work/,
    );
  } finally {
    await x.harness.lifecycle.dispose();
  }
});

test("a run that expires while waiting for the room lock cannot enqueue work", async () => {
  const x = await setup();
  try {
    const a = await x.service.create(x.input());
    const run = { id: "waiting", status: "running" };
    x.runs.set(a.id, [run]);
    let release!: () => void;
    const blocked = x.runtime.locked(
      `room:${x.room.id}`,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    const dispatch = x.service.dispatch(a.projectId, a.id, run.id);
    await new Promise((resolve) => setImmediate(resolve));
    run.status = "failed";
    release();
    await blocked;
    await assert.rejects(dispatch, /no longer active/);
    assert.equal(x.store.roomJobs(x.room.id).length, 0);
  } finally {
    await x.harness.lifecycle.dispose();
  }
});

test("automation history links dispatch to the completed response and retries", async () => {
  const x = await setup();
  try {
    const a = await x.service.create(x.input());
    x.runs.set(a.id, [{ id: "result", status: "running" }]);
    await x.service.dispatch(a.projectId, a.id, "result");
    await x.runtime.drive(x.a);
    const job = x.store.work(x.a.id)[0]!;
    let page = await x.service.runs({
      channelId: x.room.id,
      automationId: a.id,
      limit: 20,
    });
    assert.equal(page.runs[0]?.responseStatus, "running");
    assert.equal(page.runs[0]?.responseThreadId, job.threadId);
    x.runtime.complete(job.threadId!, null, "Temporary failure");
    await x.runtime.driveRoom(x.room);
    const retry = await x.runtime.retryJob(job.id);
    await x.runtime.drive(x.a);
    x.runtime.complete(x.store.job(retry.id)!.threadId!, "AUTOMATION_COMPLETE");
    await x.runtime.driveRoom(x.room);
    page = await x.service.runs({
      channelId: x.room.id,
      automationId: a.id,
      limit: 20,
    });
    assert.equal(page.runs[0]?.responseStatus, "done");
    assert.equal(page.runs[0]?.responseMessageId, retry.id);
    assert.equal(page.runs[0]?.responseError, undefined);
  } finally {
    await x.harness.lifecycle.dispose();
  }
});

test("CLI edits a paused schedule without enabling it", async () => {
  const x = await setup();
  try {
    const a = await x.service.create(x.input({ enabled: false }));
    const result = await x.harness.behavior.runCli([
      "channel",
      "schedule-update",
      x.room.id,
      a.id,
      "--name",
      "Updated reminder",
      "--text",
      "New task",
      "--cron",
      "0 9 * * 1-5",
      "--timezone",
      "America/New_York",
      "--json",
    ]);
    assert.equal(result.exitCode, 0, result.stderr);
    const updated = JSON.parse(result.stdout!);
    assert.equal(updated.name, "Updated reminder");
    assert.equal(updated.prompt, "New task");
    assert.equal(updated.enabled, false);
    assert.equal(updated.trigger.cron, "0 9 * * 1-5");
  } finally {
    await x.harness.lifecycle.dispose();
  }
});
