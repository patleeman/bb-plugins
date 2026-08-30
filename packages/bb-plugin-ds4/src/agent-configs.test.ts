import assert from "node:assert/strict";
import { test } from "node:test";
import { piCompatibilityForModel } from "./agent-configs.ts";

test("uses GLM-compatible thinking controls for generated Pi configs", () => {
  const glm = piCompatibilityForModel("glm-5.2");
  assert.equal(glm.thinkingFormat, "zai");
  assert.equal("requiresReasoningContentOnAssistantMessages" in glm, false);
});

test("keeps DeepSeek reasoning replay compatibility for Flash", () => {
  const flash = piCompatibilityForModel("deepseek-v4-flash");
  assert.equal(flash.thinkingFormat, "deepseek");
  assert.equal(flash.requiresReasoningContentOnAssistantMessages, true);
});
