import test from "node:test";
import assert from "node:assert/strict";
import {
  formatCountdown,
  formatDuration,
  nextAutomation,
  railHasLiveWork,
  railLive,
  railMembers,
  railRoutingCount,
} from "../channel-rail";
import { botSchema, jobSchema, runSchema, type Bot, type Job } from "../contract";

const botId = (n: number) => `bot_${String(n).repeat(16).slice(0, 16)}`;

const bot = (n: number, overrides: Record<string, unknown> = {}): Bot =>
  botSchema.parse({
    id: botId(n),
    name: `Bot ${n}`,
    handle: `bot-${n}`,
    home: "/tmp",
    projectId: "proj",
    hostId: "host",
    createdAt: 0,
    updatedAt: 0,
    lastWakeAt: 0,
    error: null,
    ...overrides,
  });

const job = (overrides: Record<string, unknown> = {}): Job =>
  jobSchema.parse({
    id: "job",
    botId: botId(1),
    conversationKey: "group:room",
    threadId: "thr_1",
    text: "Do the thing",
    status: "running",
    reply: null,
    error: null,
    createdAt: 100,
    updatedAt: 100,
    startedAt: 1000,
    roomId: "room",
    runId: null,
    ...overrides,
  });

const run = (overrides: Record<string, unknown> = {}) =>
  runSchema.parse({
    id: "run",
    roomId: "room",
    status: "running",
    round: 0,
    remaining: [],
    next: [],
    jobId: null,
    createdAt: 0,
    error: null,
    ...overrides,
  });

test("live entries carry the activity, elapsed start, and the queue behind them", () => {
  const entries = railLive([
    job({ id: "head", activitySnippet: "Reading store.ts" }),
    job({ id: "behind", status: "queued", startedAt: null, createdAt: 200 }),
  ]);
  assert.equal(entries.length, 1);
  assert.deepEqual(
    {
      jobId: entries[0]!.jobId,
      running: entries[0]!.running,
      startedAt: entries[0]!.startedAt,
      queuedBehind: entries[0]!.queuedBehind,
      stoppable: entries[0]!.stoppable,
    },
    {
      jobId: "head",
      running: true,
      startedAt: 1000,
      queuedBehind: 1,
      stoppable: true,
    },
  );
  assert.equal(entries[0]!.activity, "Reading store.ts");
});

test("a job already stopping is not stoppable again", () => {
  const [entry] = railLive([job({ cancellationPending: true })]);
  assert.equal(entry!.stoppable, false);
  assert.equal(entry!.activity, "Stopping…");
});

test("dispatching jobs fall back to the dispatch start for elapsed time", () => {
  const [entry] = railLive([
    job({ status: "dispatching", startedAt: null, dispatchStartedAt: 500 }),
  ]);
  assert.equal(entry!.startedAt, 500);
  assert.equal(entry!.running, false);
});

test("routing counts only runs still choosing recipients", () => {
  assert.equal(
    railRoutingCount([
      run({ id: "a", routing: "pending" }),
      run({ id: "b", routing: "pending", status: "done" }),
      run({ id: "c", routing: "done" }),
      run({ id: "d" }),
    ]),
    1,
  );
});

test("members sort by what they are doing, and retired bots drop out", () => {
  const bots = [
    bot(1, { name: "Idle" }),
    bot(2, { name: "Working" }),
    bot(3, { name: "Broken", error: "Provider down" }),
    bot(4, { name: "Gone", retired: true }),
  ];
  const members = railMembers(
    bots,
    bots.map((b) => b.id),
    [job({ botId: botId(2), activitySnippet: "Editing runtime.ts" })],
  );
  assert.deepEqual(
    members.map((m) => [m.bot.name, m.state]),
    [
      ["Working", "working"],
      ["Broken", "attention"],
      ["Idle", "idle"],
    ],
  );
  assert.equal(members[0]!.detail, "Editing runtime.ts");
  assert.equal(members[0]!.threadId, "thr_1");
  assert.equal(members[1]!.detail, "Provider down");
});

test("bots outside the channel are not members of it", () => {
  assert.deepEqual(railMembers([bot(1), bot(2)], [botId(2)], []).length, 1);
});

const automation = (overrides: Record<string, unknown> = {}) => ({
  id: "a",
  projectId: "proj",
  channelId: "room",
  botId: botId(1),
  name: "Standup",
  prompt: "Summarise",
  enabled: true,
  trigger: { triggerType: "schedule" as const, cron: "0 9 * * *", timezone: "UTC" },
  nextRunAt: 2000,
  lastRunAt: null,
  lastRunStatus: null,
  lastError: null,
  ...overrides,
});

test("the next automation is the soonest enabled future run", () => {
  const next = nextAutomation(
    [
      automation({ id: "past", nextRunAt: 500 }),
      automation({ id: "paused", nextRunAt: 1500, enabled: false }),
      automation({ id: "unscheduled", nextRunAt: null }),
      automation({ id: "soon", nextRunAt: 3000 }),
      automation({ id: "later", nextRunAt: 9000 }),
    ],
    1000,
  );
  assert.equal(next?.id, "soon");
});

test("a channel with no upcoming run has no next automation", () => {
  assert.equal(nextAutomation([automation({ enabled: false })], 0), null);
});

test("durations read as two coarse units", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(45_000), "45s");
  assert.equal(formatDuration(8_040_000), "2h 14m");
  assert.equal(formatDuration(7_200_000), "2h");
  assert.equal(formatDuration(134_000_000), "1d 13h");
});

test("countdowns say now rather than counting the last second", () => {
  assert.equal(formatCountdown(500), "now");
  assert.equal(formatCountdown(150_000), "in 2m 30s");
});

test("the rail reports live work from any of its urgent sources", () => {
  assert.equal(railHasLiveWork([], [], [], 0), false);
  assert.equal(railHasLiveWork([job()], [], [], 0), true);
  assert.equal(railHasLiveWork([], [run({ routing: "pending" })], [], 0), true);
  assert.equal(railHasLiveWork([], [], [], 2), true);
});
