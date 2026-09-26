import test from "node:test";
import assert from "node:assert/strict";
import { defaultFallback, fallbackSchema } from "../contract";

test("the fallback defaults to the thread's own provider", () => {
  assert.deepEqual(defaultFallback, { mode: "thread" });
});

test("a chosen fallback model needs a provider and a model; reasoning is optional", () => {
  const chosen = { mode: "model", providerId: "pi", model: "opencode-go/qwen3.8-flash", reasoningLevel: "low" };
  assert.deepEqual(fallbackSchema.parse(chosen), chosen);
  assert.equal(fallbackSchema.safeParse({ ...chosen, reasoningLevel: null }).success, true);
  assert.equal(fallbackSchema.safeParse({ ...chosen, model: " " }).success, false);
  assert.equal(fallbackSchema.safeParse({ ...chosen, reasoningLevel: "turbo" }).success, false);
});

test("stored values from the page are strict", () => {
  assert.equal(fallbackSchema.safeParse({ mode: "off", providerId: "pi" }).success, false);
  assert.equal(fallbackSchema.safeParse({ mode: "sometimes" }).success, false);
});
