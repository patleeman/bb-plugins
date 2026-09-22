import test from "node:test";
import assert from "node:assert/strict";
import {
  askJev,
  selectJevBots,
  classifyJevReturn,
  jevRoutingRequest,
} from "../jev";
import { botSchema, messageSchema } from "../contract";
import { selectBots } from "../smart-router";

const bots = ["Atlas", "Scribe"].map((name, index) =>
  botSchema.parse({
    id: `bot_${String(index + 1).padStart(16, "0")}`,
    name,
    handle: name.toLowerCase(),
    home: `/tmp/jev-${name}`,
    projectId: "p",
    hostId: "h",
    paused: false,
    createdAt: 1,
    updatedAt: 1,
    lastWakeAt: 0,
    error: null,
  }),
);
const message = messageSchema.parse({
  id: "m",
  roomId: "r",
  runId: "m",
  botId: null,
  speaker: "Owner",
  text: "Why PostgreSQL instead of SQLite?",
  createdAt: 1,
});
const tasks = bots.map((bot) => ({
  botId: bot.id,
  busy: true,
  task: "Implement storage",
  threadId: "t",
}));
const config = { zenApiKey: "test-secret" };
const choice = (value: string, confidence = 1) => ({
  type: "choice",
  choice: value,
  confidence,
  probabilities: { [value]: 1 },
});

test("Jev batches all recipients and actions into one direct request", async (t) => {
  const calls: { url: unknown; init: RequestInit | undefined }[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (url: unknown, init: RequestInit) => {
      calls.push({ url, init });
      return Response.json({
        answers: {
          [bots[0]!.id]: choice("fork"),
          [bots[1]!.id]: choice("skip"),
        },
      });
    },
  );
  const result = await selectBots(
    {} as never,
    {} as never,
    {
      ...config,
      routingEngine: "jev",
      routingProvider: "pi",
      routingModel: "slow",
      routingFallbackProvider: "codex",
      routingFallbackModel: "slow",
    },
    "p",
    "h",
    "/tmp",
    message,
    [],
    bots,
    new AbortController().signal,
    tasks,
  );
  assert.deepEqual(result, [{ botId: bots[0]!.id, action: "fork" }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://opencode.ai/zen/v1/systemone");
  const body = JSON.parse(String(calls[0]!.init!.body));
  assert.equal(body.model, "jev-1.13");
  assert.equal(Object.keys(body.questions).length, 2);
  assert.equal(JSON.parse(body.state).message.text, message.text);
  assert.equal(calls[0]!.init!.redirect, "error");
});

test("uncertain Jev steer and fork decisions default to follow-up", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      answers: {
        [bots[0]!.id]: choice("steer", 0.3),
        [bots[1]!.id]: choice("fork", 0.6),
      },
    }),
  );
  assert.deepEqual(
    await selectJevBots(
      config,
      message,
      [],
      bots,
      new AbortController().signal,
      tasks,
    ),
    bots.map((bot) => ({ botId: bot.id, action: "followup" })),
  );
});

test("explicit recipients cannot be skipped and idle bots cannot be steered", async (t) => {
  const request = jevRoutingRequest(message, [], bots, [], [bots[1]!.id]);
  assert.deepEqual(Object.keys(request.questions), [bots[1]!.id]);
  const question = request.questions[bots[1]!.id]!;
  assert.deepEqual(
    question.type === "choice" && Object.keys(question.criteria),
    ["followup"],
  );
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ answers: { [bots[1]!.id]: choice("skip") } }),
  );
  await assert.rejects(
    selectJevBots(
      config,
      message,
      [],
      bots,
      new AbortController().signal,
      [],
      [bots[1]!.id],
    ),
    /unknown decision option/,
  );
});

test("Jev validates missing answers, answer types, and confidence", async (t) => {
  const replies = [
    {},
    { [bots[0]!.id]: { type: "noul", noul: 0.9 } },
    { [bots[0]!.id]: choice("followup", 2) },
  ];
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ answers: replies.shift() }),
  );
  for (let i = 0; i < 3; i++)
    await assert.rejects(
      selectJevBots(
        config,
        message,
        [],
        [bots[0]!],
        new AbortController().signal,
      ),
    );
});

test("Jev failures do not expose response bodies or start an agent fallback", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response("private gateway details test-secret", { status: 401 }),
  );
  await assert.rejects(
    selectBots(
      {} as never,
      {} as never,
      {
        ...config,
        routingEngine: "jev",
        routingProvider: "pi",
        routingModel: "slow",
        routingFallbackProvider: "codex",
        routingFallbackModel: "slow",
      },
      "p",
      "h",
      "/tmp",
      message,
      [],
      bots,
      new AbortController().signal,
    ),
    (error: Error) =>
      /HTTP 401/.test(error.message) &&
      !/test-secret|private/.test(error.message),
  );
});

test("Jev cancellation and deadline abort the HTTP request", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init: RequestInit) => {
      const signal = init.signal!;
      return await new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    },
  );
  const controller = new AbortController();
  const pending = selectJevBots(config, message, [], bots, controller.signal);
  controller.abort(new Error("Stopped"));
  await assert.rejects(pending, /Stopped/);
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(
      selectJevBots(
        { ...config, jevTimeoutMs: 250 },
        message,
        [],
        bots,
        new AbortController().signal,
      ),
      /timeout/i,
    );
  } finally {
    clearInterval(keepAlive);
  }
});

test("Jev returns require both a real request and useful settled results", async (t) => {
  const probabilities = [
    [0.99, 0.98],
    [0.99, 0.05],
    [0.02, 0.99],
  ];
  t.mock.method(globalThis, "fetch", async () => {
    const values = probabilities.shift()!;
    return Response.json({
      answers: {
        request: { type: "noul", noul: values[0] },
        result: { type: "noul", noul: values[1] },
      },
    });
  });
  for (const expected of [true, false, false])
    assert.equal(
      await classifyJevReturn(
        config,
        { requests: [], results: [] },
        new AbortController().signal,
      ),
      expected,
    );
});

test("Jev rejects invalid settings and unknown required recipients before network access", async () => {
  await assert.rejects(
    askJev(
      { ...config, jevTimeoutMs: 0 },
      {},
      {},
      new AbortController().signal,
    ),
  );
  await assert.rejects(
    selectJevBots(
      config,
      message,
      [],
      bots,
      new AbortController().signal,
      [],
      ["unknown"],
    ),
    /outside the roster/,
  );
});
