import test from "node:test";
import assert from "node:assert/strict";
import {
  JevUnavailableError,
  askJev,
  classify,
  modelPrompt,
  parseModelVerdict,
  situationState,
  type Situation,
  type Verdict,
} from "../classifier";

const situation: Situation = {
  title: "Build storage",
  requests: ["Add caching", "Implement storage with PostgreSQL"],
  latestOutput: "Creating the migration now.",
  message: "Actually, use SQLite instead.",
};
const jevAnswer = (choice: string, confidence: number) => ({
  answers: { action: { type: "choice", choice, confidence, probabilities: { [choice]: confidence } } },
});

test("Jev receives the running task and the new message as data", async (t) => {
  const calls: RequestInit[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    calls.push(init);
    return Response.json(jevAnswer("steer", 0.92));
  });
  const verdict = await askJev({ zenApiKey: "k" }, situation, AbortSignal.timeout(1000));
  assert.deepEqual(verdict, { action: "steer", source: "jev", confidence: 0.92, note: null });
  const body = JSON.parse(String(calls[0]!.body));
  assert.equal(body.model, "jev-1.13");
  assert.deepEqual(Object.keys(body.questions.action.criteria), ["steer", "followup"]);
  const state = JSON.parse(body.state);
  assert.equal(state.currentTask, "Implement storage with PostgreSQL");
  assert.equal(state.message, "Actually, use SQLite instead.");
});

test("an uncertain Jev steer becomes a follow-up", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json(jevAnswer("steer", 0.5)));
  const verdict = await askJev({ zenApiKey: "k", steerConfidence: 0.7 }, situation, AbortSignal.timeout(1000));
  assert.equal(verdict.action, "followup");
  assert.match(verdict.note ?? "", /unsure/);
});

test("Jev without a key is unavailable, not an error", async () => {
  const previous = process.env.OPENCODE_API_KEY;
  delete process.env.OPENCODE_API_KEY;
  try {
    await assert.rejects(askJev({}, situation, AbortSignal.timeout(1000)), JevUnavailableError);
  } finally {
    if (previous !== undefined) process.env.OPENCODE_API_KEY = previous;
  }
});

test("Jev rejects HTTP failures and unknown options", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => new Response("no", { status: 402 }));
  await assert.rejects(askJev({ zenApiKey: "k" }, situation, AbortSignal.timeout(1000)), /HTTP 402/);
  fetchMock.mock.mockImplementation(async () => Response.json(jevAnswer("fork", 1)));
  await assert.rejects(askJev({ zenApiKey: "k" }, situation, AbortSignal.timeout(1000)), /unknown/);
});

test("classification falls back from Jev to the model, then to follow-up", async () => {
  const model: Verdict = { action: "steer", source: "model", confidence: null, note: null };
  const warnings: string[] = [];
  const warn = (message: string) => warnings.push(message);
  const signal = AbortSignal.timeout(1000);

  const noKey = await classify(
    { jev: async () => { throw new JevUnavailableError("no key"); }, model: async () => model, warn },
    signal,
  );
  assert.deepEqual(noKey, model);
  assert.deepEqual(warnings, [], "a missing key is expected, not a warning");

  const neither = await classify(
    {
      jev: async () => { throw new Error("HTTP 500"); },
      model: async () => { throw new Error("provider down"); },
      warn,
    },
    signal,
  );
  assert.equal(neither.action, "followup");
  assert.equal(neither.source, "default");
  assert.match(neither.note ?? "", /HTTP 500.*provider down/);
});

test("the model prompt carries bounded data and parses strict JSON", () => {
  const prompt = modelPrompt({ ...situation, message: "x".repeat(20000) });
  assert.match(prompt, /untrusted conversation data/);
  assert.equal(situationState({ ...situation, message: "x".repeat(20000) }).message.length, 16000);
  assert.equal(parseModelVerdict('```json\n{"action":"steer"}\n```').action, "steer");
  // Observed live: a small model renamed the key and added a reason.
  assert.equal(parseModelVerdict('{"decision":"follow-up","reason":"separate task"}').action, "followup");
  assert.equal(parseModelVerdict('Answer: {"action":"Steer"}').action, "steer");
  assert.throws(() => parseModelVerdict('{"action":"fork"}'));
  assert.throws(() => parseModelVerdict("steer"));
});
