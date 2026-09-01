import assert from "node:assert/strict";
import { test } from "node:test";
import {
  inputModalitiesForModel,
  piCompatibilityForModel,
} from "./agent-configs.ts";

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

test("advertises image input only for configured vision models", () => {
  assert.deepEqual(
    inputModalitiesForModel("glm-5.3-flash", true),
    ["text", "image"],
  );
  assert.deepEqual(
    inputModalitiesForModel("zai/glm-5.3-flash-reasoner", true),
    ["text", "image"],
  );
  assert.deepEqual(
    inputModalitiesForModel("deepseek-v4-flash-vision-exp", true),
    ["text", "image"],
  );
  assert.deepEqual(inputModalitiesForModel("glm-5.3-flash", false), ["text"]);
  assert.deepEqual(inputModalitiesForModel("glm-5.2", true), ["text"]);
});
