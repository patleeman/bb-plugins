import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { Store } from "../store";
import { Runtime, jobPrompt, primaryLane } from "../runtime";
import { profileInput, type Bot, type Room } from "../contract";
import { channelWork } from "../channel-work";

function setup() {
  let seq = 0;
  const threads = new Map<
    string,
    {
      status: "active" | "idle";
      prompt: string;
      output: string | null;
      metadata: Record<string, unknown>;
    }
  >();
  const host = createFakePluginHost({
    pluginId: "bot-teams",
    sdk: {
      providers: {
        list: async () =>
          [
            {
              id: "codex",
              available: true,
              capabilities: { supportsFork: true },
            },
          ] as never,
      },
      threads: {
        spawn: async (args) => {
          const id = `thr_main_${++seq}`;
          threads.set(id, {
            status: "active",
            prompt: args.input?.find((i) => i.type === "text")?.text ?? "",
            output: null,
            metadata: args.pluginMetadata ?? {},
          });
          return makeThreadResponse({ id, status: "active" });
        },
        fork: async (args) => {
          const id = `thr_fork_${++seq}`;
          assert.ok(threads.has(args.sourceThreadId));
          threads.set(id, {
            status: "active",
            prompt: args.input?.find((i) => i.type === "text")?.text ?? "",
            output: null,
            metadata: args.pluginMetadata ?? {},
          });
          return makeThreadResponse({ id, status: "active" });
        },
        send: async (args) => {
          assert.ok(
            store
              .work(bot.id)
              .some(
                (job) =>
                  (job.threadId === args.threadId &&
                    job.status === "dispatching") ||
                  (job.threadId === args.threadId && job.status === "running"),
              ),
            "register before core dispatch hook",
          );
          const thread = threads.get(args.threadId)!;
          thread.prompt = args.input.find((i) => i.type === "text")?.text ?? "";
          thread.status = "active";
          return { ok: true, delivery: "sent" };
        },
        get: async ({ threadId }) =>
          makeThreadResponse({
            id: threadId,
            status: threads.get(threadId)?.status ?? "idle",
          }),
        list: async () =>
          [...threads].map(([id, thread]) =>
            makeThreadResponse({ id, status: thread.status }),
          ),
        getPluginMetadata: async ({ threadId }) =>
          threads.get(threadId)?.metadata as never,
        output: async ({ threadId }) => ({
          output: threads.get(threadId)?.output ?? null,
        }),
        timeline: async ({ threadId }) =>
          ({
            rows: [
              {
                kind: "conversation",
                role: "user",
                text: threads.get(threadId)?.prompt,
              },
            ],
            hasOlder: false,
          }) as never,
        stop: async ({ threadId }) => {
          const t = threads.get(threadId);
          if (t) t.status = "idle";
          return { ok: true };
        },
        queuedMessages: {
          list: async () => [],
          delete: async () => ({ ok: true }),
        },
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
  const room: Room = {
    id: randomUUID(),
    name: "Fork QA",
    memberIds: [bot.id],
    paused: false,
    createdAt: 1,
    updatedAt: 1,
    responseBehavior: "directed",
  };
  store.putRoom(room);
  const runtime = new Runtime(host.bb, store);
  const send = (
    text: string,
    mode?: "fork" | "steer" | "followup",
    replyTo: string | null = null,
  ) =>
    runtime.send(
      store.room(room.id),
      text,
      randomUUID(),
      [],
      replyTo,
      undefined,
      undefined,
      mode,
    );
  const finish = async (threadId: string, output: string) => {
    Object.assign(threads.get(threadId)!, { status: "idle", output });
    await runtime.settleFromEvent(threadId, output);
    await runtime.driveRoom(store.room(room.id));
  };
  const main = async () => {
    const message = send("@atlas Implement the migration");
    await runtime.drive(bot);
    const job = store.job(`${message.id}:${bot.id}`)!;
    runtime.busy.set(primaryLane(bot.id, job.conversationKey), {
      threadId: job.threadId!,
      at: Date.now(),
    });
    return job;
  };
  return {
    ...host,
    store,
    runtime,
    bot,
    room,
    threads,
    send,
    finish,
    main,
    close: async () => {
      await runtime.dispose();
      await host.harness.lifecycle.dispose();
    },
  };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("a native fork answers alongside the primary and replies reuse the fork", async () => {
  const x = setup();
  try {
    const main = await x.main();
    const question = x.send("/fork @atlas Why SQLite?");
    await x.runtime.driveForks(x.bot);
    const fork = x.store.job(`${question.id}:${x.bot.id}`)!;
    assert.equal(x.store.job(main.id)?.status, "running");
    assert.notEqual(fork.threadId, main.threadId);
    assert.equal(fork.forkSourceThreadId, main.threadId);
    assert.equal(
      (
        x.harness.inspection.sdk.callsTo("threads.fork")[0]![0] as {
          sourceThreadId: string;
        }
      ).sourceThreadId,
      main.threadId,
    );
    assert.match(jobPrompt(fork), /do not resume inherited work/);
    assert.equal(channelWork(x.store.work(x.bot.id)).length, 2);
    assert.equal(
      x.runtime.busy.get(primaryLane(x.bot.id, main.conversationKey))?.threadId,
      main.threadId,
    );
    await x.finish(fork.threadId!, "SQLite suits this local workload.");
    const answer = x.store.message(fork.id)!;
    assert.equal(answer.replyTo, question.id);
    assert.equal(answer.conversationKey, fork.conversationKey);
    const followup = x.send("What about backups?", "followup", answer.id);
    await x.runtime.driveForks(x.bot);
    assert.equal(
      x.store.job(`${followup.id}:${x.bot.id}`)?.threadId,
      fork.threadId,
    );
    assert.equal(x.harness.inspection.sdk.callsTo("threads.fork").length, 1);
    assert.equal(x.harness.inspection.sdk.callsTo("threads.send").length, 1);
    assert.equal(x.store.job(main.id)?.status, "running");
  } finally {
    await x.close();
  }
});

test("stopping a fork preserves the primary, including after runtime restart", async () => {
  const x = setup();
  let restarted: Runtime | undefined;
  try {
    const main = await x.main();
    const question = x.send("@atlas Side question", "fork");
    await x.runtime.driveForks(x.bot);
    const fork = x.store.job(`${question.id}:${x.bot.id}`)!;
    restarted = new Runtime(x.bb, x.store);
    await restarted.reconcileBusy(x.bot);
    assert.equal(
      restarted.busy.get(primaryLane(x.bot.id, main.conversationKey))?.threadId,
      main.threadId,
    );
    await restarted.cancel(fork, "Stopped fork");
    assert.equal(x.store.job(main.id)?.status, "running");
    assert.equal(x.threads.get(main.threadId!)?.status, "active");
    assert.deepEqual(
      x.harness.inspection.sdk
        .callsTo("threads.stop")
        .map((c) => (c[0] as { threadId: string }).threadId),
      [fork.threadId],
    );
  } finally {
    await restarted?.dispose();
    await x.close();
  }
});

test("Smart can fork a mentioned question; explicit modes bypass classification", async () => {
  const x = setup();
  try {
    const main = await x.main();
    x.store.putRoom({ ...x.room, responseBehavior: "smart" });
    let calls = 0;
    x.runtime.route = async (_m, _r, _b, _s, tasks, required) => {
      calls++;
      assert.deepEqual(required, [x.bot.id]);
      assert.equal(tasks?.[0]?.threadId, main.threadId);
      assert.match(tasks?.[0]?.task ?? "", /migration/);
      return [{ botId: x.bot.id, action: "fork" }];
    };
    const question = x.send("@atlas Quick question: why SQLite?");
    await x.runtime.driveRoom(x.store.room(x.room.id));
    await flush();
    await x.runtime.driveForks(x.bot);
    assert.equal(
      x.store.job(`${question.id}:${x.bot.id}`)?.dispatchAction,
      "fork",
    );
    assert.deepEqual(x.store.message(question.id)?.classifierActions, [
      { botId: x.bot.id, action: "fork" },
    ]);
    assert.equal(x.store.job(main.id)?.status, "running");
    const queued = x.send("@atlas Actually use WAL later", "followup");
    await x.runtime.driveRoom(x.store.room(x.room.id));
    await flush();
    assert.equal(calls, 1);
    assert.equal(x.store.job(`${queued.id}:${x.bot.id}`)?.status, "queued");
    assert.equal(x.store.message(queued.id)?.classifierActions, undefined);
    const correction = x.send("@atlas Use WAL now", "steer");
    await flush();
    assert.equal(x.store.job(main.id)?.triggerMessageId, correction.id);
    assert.equal(x.store.message(correction.id)?.classifierActions, undefined);
    assert.equal(calls, 1);
  } finally {
    await x.close();
  }
});

test("a slow router cannot steer a replacement task", async () => {
  const x = setup();
  try {
    const main = await x.main();
    x.store.putRoom({ ...x.room, responseBehavior: "smart" });
    let resolve!: (v: { botId: string; action: "steer" }[]) => void;
    x.runtime.route = () =>
      new Promise((r) => {
        resolve = r;
      });
    const correction = x.send("@atlas Adjust the migration");
    await x.runtime.driveRoom(x.store.room(x.room.id));
    await flush();
    await x.finish(main.threadId!, "Migration complete");
    const next = x.send("@atlas Now inspect logs", "followup");
    await x.runtime.drive(x.bot);
    resolve([{ botId: x.bot.id, action: "steer" }]);
    await flush();
    assert.equal(
      x.store.job(`${next.id}:${x.bot.id}`)?.triggerMessageId,
      next.id,
    );
    assert.equal(x.store.job(`${correction.id}:${x.bot.id}`)?.status, "queued");
    assert.deepEqual(x.store.message(correction.id)?.classifierActions, [
      { botId: x.bot.id, action: "followup", suggestedAction: "steer" },
    ]);
  } finally {
    await x.close();
  }
});

test("unsupported forks fail independently and retry preserves their source", async () => {
  const x = setup();
  try {
    const main = await x.main();
    x.harness.inspection.sdk.stub("providers.list", async () => [
      { id: "codex", capabilities: { supportsFork: false } },
    ]);
    const q = x.send("@atlas side question", "fork");
    await x.runtime.driveForks(x.bot);
    const fork = x.store.job(`${q.id}:${x.bot.id}`)!;
    assert.equal(fork.status, "error");
    assert.match(fork.error!, /does not support/);
    assert.equal(x.store.job(main.id)?.status, "running");
    const retry = await x.runtime.retryJob(fork.id);
    assert.equal(retry.forkSourceThreadId, main.threadId);
    assert.equal(retry.conversationKey, fork.conversationKey);
  } finally {
    await x.close();
  }
});

test("fork concurrency is bounded without blocking the primary", async () => {
  const x = setup();
  try {
    const main = await x.main();
    const requests = Array.from({ length: 3 }, (_, i) =>
      x.send(`@atlas question ${i}`, "fork"),
    );
    await x.runtime.driveForks(x.bot);
    assert.equal(x.harness.inspection.sdk.callsTo("threads.fork").length, 2);
    assert.equal(
      x.store.job(`${requests[2]!.id}:${x.bot.id}`)?.status,
      "queued",
    );
    const first = x.store.job(`${requests[0]!.id}:${x.bot.id}`)!;
    await x.finish(first.threadId!, "Answer");
    await x.runtime.driveForks(x.bot);
    assert.equal(x.harness.inspection.sdk.callsTo("threads.fork").length, 3);
    assert.equal(x.store.job(main.id)?.status, "running");
  } finally {
    await x.close();
  }
});

test("request retries are idempotent and reject delivery mode changes", async () => {
  const x = setup();
  try {
    await x.main();
    const id = randomUUID();
    x.runtime.send(x.room, "/fork @atlas Why?", id);
    x.runtime.send(x.room, "/fork @atlas Why?", id);
    assert.equal(x.store.work(x.bot.id).length, 2);
    assert.throws(
      () => x.runtime.send(x.room, "@atlas Why?", id),
      /different content/,
    );
  } finally {
    await x.close();
  }
});

test("a steer arriving during spawn is persisted and delivered after registration", async () => {
  const x = setup();
  try {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    x.harness.inspection.sdk.stub(
      "threads.spawn",
      async (args: Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0]) => {
        await gate;
        x.threads.set("thr_delayed", {
          status: "active",
          prompt: args.input?.find((i) => i.type === "text")?.text ?? "",
          output: null,
          metadata: args.pluginMetadata ?? {},
        });
        return makeThreadResponse({ id: "thr_delayed", status: "active" });
      },
    );
    const original = x.send("@atlas Implement the migration");
    const drive = x.runtime.drive(x.bot);
    await flush();
    const correction = x.send("@atlas Use WAL", "steer");
    const current = x.store.job(`${original.id}:${x.bot.id}`)!;
    assert.ok(current.pendingSteer);
    assert.equal(current.triggerMessageId, correction.id);
    assert.match(current.text, /Use WAL/);
    assert.equal(current.requiresPromptMatch, true);
    release();
    await drive;
    await flush();
    assert.equal(x.store.work(x.bot.id).length, 1);
    assert.equal(x.store.job(current.id)?.pendingSteer, undefined);
    const [send] = x.harness.inspection.sdk.callsTo("threads.send");
    assert.equal((send?.[0] as { mode: string }).mode, "steer");
    assert.match(x.threads.get("thr_delayed")!.prompt, /Use WAL/);
  } finally {
    await x.close();
  }
});

test("a restarted runtime recovers a correction without publishing inherited output", async () => {
  const x = setup();
  let restart: Runtime | undefined;
  try {
    const main = await x.main();
    const oldPrompt = jobPrompt(main);
    // A durable correction saved just before the send starts.
    const corrected = {
      ...x.store.job(main.id)!,
      text: "Corrected task",
      requiresPromptMatch: true,
      pendingSteer: { priorPrompt: oldPrompt },
    };
    x.store.putJob(corrected);
    restart = new Runtime(x.bb, x.store);
    Object.assign(x.threads.get(main.threadId!)!, {
      status: "idle",
      output: "Old answer",
    });
    await restart.settleFromEvent(main.threadId!, "Old answer");
    assert.equal(x.store.job(main.id)?.status, "running");
    await restart.drive(x.bot);
    assert.equal(x.store.job(main.id)?.pendingSteer, undefined);
    assert.equal(x.store.job(main.id)?.reply, null);
    assert.match(x.threads.get(main.threadId!)!.prompt, /Corrected task/);
  } finally {
    await restart?.dispose();
    await x.close();
  }
});

test("a single eligible bot receives ordinary messages without recipient classification in every mode", async () => {
  for (const responseBehavior of ["smart", "directed", "everyone"] as const) {
    const x = setup();
    try {
      x.store.putRoom({ ...x.room, responseBehavior });
      x.runtime.route = async () => {
        throw new Error("Idle single-bot messages must not classify");
      };
      const m = x.send("Thanks, and please continue");
      assert.equal(x.store.job(`${m.id}:${x.bot.id}`)?.status, "queued");
      assert.equal(
        x.store.runs(x.room.id).find((r) => r.id === m.id)?.routing,
        undefined,
      );
    } finally {
      await x.close();
    }
  }
});

test("busy Auto uses classifier actions even for keyword-looking questions in every mode", async () => {
  for (const responseBehavior of ["smart", "directed", "everyone"] as const) {
    const x = setup();
    try {
      x.store.putRoom({ ...x.room, responseBehavior });
      const main = await x.main();
      let calls = 0;
      x.runtime.route = async (_m, _room, _bots, _signal, tasks, required) => {
        calls++;
        assert.deepEqual(required, [x.bot.id]);
        assert.equal(tasks?.[0]?.busy, true);
        return [{ botId: x.bot.id, action: "followup" }];
      };
      for (const text of [
        "Why PostgreSQL instead of SQLite?",
        "Do not stop the current task; explain stop sequences.",
      ]) {
        const next = x.send(text);
        await x.runtime.driveRoom(x.store.room(x.room.id));
        await flush();
        assert.equal(
          x.store.job(main.id)?.triggerMessageId,
          main.triggerMessageId,
        );
        assert.equal(x.store.job(`${next.id}:${x.bot.id}`)?.status, "queued");
      }
      assert.equal(calls, 2);
      assert.equal(x.harness.inspection.sdk.callsTo("threads.send").length, 0);
    } finally {
      await x.close();
    }
  }
});

test("a deleted active fork settles and later forks still start", async () => {
  const x = setup();
  try {
    await x.main();
    const first = x.send("Separate question", "fork");
    await x.runtime.driveForks(x.bot);
    const lost = x.store.job(`${first.id}:${x.bot.id}`)!;
    x.harness.inspection.sdk.stub("threads.get", async ({ threadId }) => {
      if (threadId === lost.threadId) throw new Error("Thread not found");
      return makeThreadResponse({ id: threadId, status: "active" });
    });
    const second = x.send("Another question", "fork");
    await x.runtime.tick();
    assert.equal(x.store.job(lost.id)?.status, "error");
    assert.equal(x.store.byThread(lost.threadId!), null);
    assert.equal(x.store.job(`${second.id}:${x.bot.id}`)?.status, "running");
  } finally {
    await x.close();
  }
});

test("a rate-limited primary does not block cleanup of a deleted fork", async () => {
  const x = setup();
  try {
    const main = await x.main();
    const m = x.send("Parallel check", "fork");
    await x.runtime.driveForks(x.bot);
    const fork = x.store.job(`${m.id}:${x.bot.id}`)!;
    await x.finish(main.threadId!, "Primary finished");
    x.runtime.busy.clear();
    x.store.put({
      ...x.bot,
      limits: {
        turnsPerHour: 1,
        turnsPerDay: 1,
        minutesPerTurn: 20,
        concurrentForks: 2,
      },
    });
    x.send("Queued after budget", "followup");
    x.harness.inspection.sdk.stub("threads.get", async ({ threadId }) => {
      if (threadId === fork.threadId) throw new Error("Thread not found");
      return makeThreadResponse({ id: threadId, status: "idle" });
    });
    await x.runtime.tick();
    assert.equal(x.store.job(fork.id)?.status, "error");
    assert.match(x.store.get(x.bot.id).error!, /limit reached/);
  } finally {
    await x.close();
  }
});
