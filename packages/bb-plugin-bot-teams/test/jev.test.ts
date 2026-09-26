import test from "node:test";
import assert from "node:assert/strict";
import {
  askJev,
  selectJevBots,
  selectJevActions,
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
const routeAnswers = (coordinatorId: string, execution: "serialized" | "parallel", collaborators: string[] = [], actions: Record<string, string> = {}) => ({
  coordinator: choice(coordinatorId),
  execution: choice(execution),
  ...Object.fromEntries(bots.flatMap((bot) => [
    [`collaborator:${bot.id}`, choice(collaborators.includes(bot.id) ? "yes" : "no")],
    [`action:${bot.id}`, choice(actions[bot.id] ?? "followup")],
  ])),
});

test("Jev batches all recipients and actions into one direct request", async (t) => {
  const calls: { url: unknown; init: RequestInit | undefined }[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (url: unknown, init: RequestInit) => {
      calls.push({ url, init });
      return Response.json({
        answers: routeAnswers(bots[0]!.id, "serialized", [], { [bots[0]!.id]: "fork" }),
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
  assert.deepEqual(result, { coordinatorId: bots[0]!.id, collaboratorIds: [], executionMode: "serialized", finalizerId: bots[0]!.id, routes: [{ botId: bots[0]!.id, action: "fork" }], source: "jev" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://opencode.ai/zen/v1/systemone");
  const body = JSON.parse(String(calls[0]!.init!.body));
  assert.equal(body.model, "jev-1.13");
  assert.equal(Object.keys(body.questions).length, 6);
  assert.equal(JSON.parse(body.state).message.text, message.text);
  assert.equal(calls[0]!.init!.redirect, "error");
});

test("Jev distinguishes work with a helper from each bot weighing in", async (t) => {
  const named = bots.map((bot, i) => ({ ...bot, name: ["News Desk", "Secretary"][i]!, handle: ["news-desk", "secretary"][i]! }));
  const states: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    states.push(JSON.parse(body.state));
    const parallel = states.length === 2;
    return Response.json({ answers: routeAnswers(named[0]!.id, parallel ? "parallel" : "serialized", [named[1]!.id]) });
  });
  const serialMessage = { ...message, text: "@news-desk work with @secretary" };
  const parallelMessage = { ...message, text: "@news-desk and @secretary each weigh in" };
  const candidateIds = named.map((bot) => bot.id);
  const serial = await selectJevBots(config, serialMessage, [], named, new AbortController().signal, [], candidateIds);
  const parallel = await selectJevBots(config, parallelMessage, [], named, new AbortController().signal, [], candidateIds);
  assert.equal(serial.coordinatorId, named[0]!.id);
  assert.deepEqual(serial.collaboratorIds, [named[1]!.id]);
  assert.equal(serial.executionMode, "serialized");
  assert.deepEqual(serial.routes.map((route) => route.botId), [named[0]!.id]);
  assert.equal(parallel.executionMode, "parallel");
  assert.deepEqual(parallel.routes.map((route) => route.botId), candidateIds);
  assert.equal(parallel.finalizerId, named[0]!.id);
  assert.deepEqual((states[0] as { message: { candidateBotIds: string[] } }).message.candidateBotIds, candidateIds);
});

test("Directed Jev classification keeps every literal recipient", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ answers: {
    [bots[0]!.id]: choice("steer", 0.9),
    [bots[1]!.id]: choice("fork", 0.2),
  } }));
  assert.deepEqual(
    await selectJevActions(config, message, [], bots, new AbortController().signal, tasks, bots.map((bot) => bot.id)),
    [{ botId: bots[0]!.id, action: "steer" }, { botId: bots[1]!.id, action: "followup" }],
  );
});

test("uncertain Jev steer and fork decisions default to follow-up", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      answers: {
        ...routeAnswers(bots[0]!.id, "parallel", [bots[1]!.id]),
        [`action:${bots[0]!.id}`]: choice("steer", 0.3),
        [`action:${bots[1]!.id}`]: choice("fork", 0.6),
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
    { coordinatorId: bots[0]!.id, collaboratorIds: [bots[1]!.id], executionMode: "parallel", finalizerId: bots[0]!.id, routes: bots.map((bot) => ({ botId: bot.id, action: "followup" })), source: "jev" },
  );
});

test("uncertain parallel work stays with one coordinator", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ answers: {
    ...routeAnswers(bots[0]!.id, "parallel", [bots[1]!.id]),
    execution: choice("parallel", 0.3),
  } }));
  const plan = await selectJevBots(config, message, [], bots, new AbortController().signal, [], bots.map((bot) => bot.id));
  assert.equal(plan.executionMode, "serialized");
  assert.deepEqual(plan.collaboratorIds, [bots[1]!.id]);
  assert.deepEqual(plan.routes.map((route) => route.botId), [bots[0]!.id]);
});

test("Jev receives prior bot identity and safely continues an uncertain follow-up", async (t) => {
  const previous = messageSchema.parse({
    ...message,
    id: "previous",
    botId: bots[0]!.id,
    speaker: bots[0]!.name,
    text: "The database query failed in the sandbox.",
  });
  const followup = { ...message, id: "followup", text: "You were querying the db directly??" };
  const states: { recent: { botId: string }[]; message: { continuationCandidateId: string } }[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    states.push(JSON.parse(String(JSON.parse(String(init.body)).state)));
    return Response.json({ answers: {
      ...routeAnswers(bots[1]!.id, "parallel", [bots[0]!.id]),
      coordinator: choice(bots[1]!.id, 0.4),
    } });
  });
  const plan = await selectJevBots(config, followup, [previous], bots, new AbortController().signal);
  assert.equal(states[0]?.recent[0]?.botId, bots[0]!.id);
  assert.equal(states[0]?.message.continuationCandidateId, bots[0]!.id);
  assert.deepEqual(plan, {
    coordinatorId: bots[0]!.id,
    collaboratorIds: [],
    executionMode: "serialized",
    finalizerId: bots[0]!.id,
    routes: [{ botId: bots[0]!.id, action: "followup" }],
    source: "fallback",
  });
  await assert.rejects(
    selectJevBots(config, { ...followup, text: "Review the deployment schedule" }, [previous], bots, new AbortController().signal),
    /uncertain about the coordinator/,
  );
});

test("explicit mentions become candidates and idle bots cannot be steered", async (t) => {
  const request = jevRoutingRequest(message, [], bots, [], [bots[1]!.id]);
  assert.deepEqual(Object.keys(request.questions), ["coordinator", "execution", `collaborator:${bots[1]!.id}`, `action:${bots[1]!.id}`]);
  const question = request.questions[`action:${bots[1]!.id}`]!;
  assert.deepEqual(
    question.type === "choice" && Object.keys(question.criteria),
    ["skip", "followup"],
  );
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ answers: {
      coordinator: choice(bots[1]!.id),
      execution: choice("serialized"),
      [`collaborator:${bots[1]!.id}`]: choice("no"),
      [`action:${bots[1]!.id}`]: choice("steer"),
    } }),
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
