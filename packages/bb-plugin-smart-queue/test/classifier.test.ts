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

const signal = () => AbortSignal.timeout(1000);
/** No ambient keys: tests must not depend on the machine running them. */
const env = {};

test("Jev receives the running task and the new message as data", async (t) => {
  const calls: { url: string; init: RequestInit }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Response.json(jevAnswer("steer", 0.92));
  });
  const verdict = await askJev({ typesafeApiKey: "k" }, situation, signal(), env);
  assert.deepEqual(verdict, { action: "steer", source: "jev", confidence: 0.92, note: null, via: "TypeSafe" });
  assert.equal(calls[0]!.url, "https://api.typesafe.ai/v1/systemone");
  assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, "Bearer k");
  const body = JSON.parse(String(calls[0]!.init.body));
  assert.equal(body.model, "jev-latest");
  assert.deepEqual(Object.keys(body.questions.action.criteria), ["steer", "followup"]);
  const state = JSON.parse(body.state);
  assert.equal(state.currentTask, "Implement storage with PostgreSQL");
  assert.equal(state.message, "Actually, use SQLite instead.");
});

test("an uncertain Jev steer becomes a follow-up", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json(jevAnswer("steer", 0.5)));
  const verdict = await askJev({ zenApiKey: "k", steerConfidence: 0.7 }, situation, signal(), env);
  assert.equal(verdict.action, "followup");
  assert.match(verdict.note ?? "", /unsure/);
});

test("Jev without any provider is unavailable, not an error", async () => {
  await assert.rejects(askJev({}, situation, signal(), env), JevUnavailableError);
});

test("auto moves to the next provider when one fails", async (t) => {
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    urls.push(url);
    return url.includes("typesafe.ai") ? new Response("busy", { status: 529 }) : Response.json(jevAnswer("followup", 0.9));
  });
  const verdict = await askJev({ typesafeApiKey: "a", zenApiKey: "b" }, situation, signal(), env);
  assert.deepEqual(urls, ["https://api.typesafe.ai/v1/systemone", "https://opencode.ai/zen/v1/systemone"]);
  assert.equal(verdict.via, "OpenCode Zen");
});

test("Jev reports every failed provider, and rejects unknown options", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => new Response("no", { status: 402 }));
  await assert.rejects(
    askJev({ typesafeApiKey: "a", openRouterApiKey: "b" }, situation, signal(), env),
    /TypeSafe says the account is out of credit.*OpenRouter says the account is out of credit/,
  );
  fetchMock.mock.mockImplementation(async () => Response.json(jevAnswer("fork", 1)));
  await assert.rejects(askJev({ zenApiKey: "k" }, situation, signal(), env), /unknown/);
});

test("a custom endpoint gets its own model, and no auth header without a key", async (t) => {
  const calls: { url: string; init: RequestInit }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Response.json(jevAnswer("followup", 0.9));
  });
  const verdict = await askJev(
    { jevProvider: "custom", customJevEndpoint: "http://localhost:8080/v1/systemone", customJevModel: "jev-local" },
    situation,
    signal(),
    env,
  );
  assert.equal(verdict.via, "Custom (localhost:8080)");
  assert.equal(JSON.parse(String(calls[0]!.init.body)).model, "jev-local");
  assert.equal("Authorization" in (calls[0]!.init.headers as Record<string, string>), false);
});

test("an oversized response is refused", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("x".repeat(70 * 1024)));
  await assert.rejects(askJev({ zenApiKey: "k" }, situation, signal(), env), /too large/);
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
