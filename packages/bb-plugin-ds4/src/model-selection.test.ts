import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalModelId,
  inferDwarfStarModelId,
  isDwarfStarModel,
  matchesModelSelection,
  parseIdleTimeoutMs,
} from "./model-selection.ts";

test("recognizes current DwarfStar model ids", () => {
  assert.equal(isDwarfStarModel("deepseek-v4-flash"), true);
  assert.equal(isDwarfStarModel("deepseek-v4-pro"), true);
  assert.equal(isDwarfStarModel("glm-5.2"), true);
  assert.equal(isDwarfStarModel("zai/glm-5.2-reasoner"), true);
  assert.equal(isDwarfStarModel("glm-5.3-flash"), true);
  assert.equal(isDwarfStarModel("zai/glm-5.3-flash-reasoner"), true);
  assert.equal(isDwarfStarModel("llama-3.3"), false);
});

test("infers the canonical model from current GGUF filenames", () => {
  assert.equal(inferDwarfStarModelId("/tmp/ds4/ds4flash.gguf"), "deepseek-v4-flash");
  assert.equal(
    inferDwarfStarModelId("/tmp/ds4/DeepSeek-V4-Flash-Layers37-0731.gguf"),
    "deepseek-v4-flash",
  );
  assert.equal(
    inferDwarfStarModelId("/tmp/ds4/DeepSeek-V4-Pro-IQ2XXS.gguf"),
    "deepseek-v4-pro",
  );
  assert.equal(
    inferDwarfStarModelId("/tmp/ds4/GLM-5.2-UD-Q2_K.gguf"),
    "glm-5.2",
  );
  assert.equal(
    inferDwarfStarModelId("/tmp/ds4/gguf/GLM-5.3-Flash-Q2.gguf"),
    "glm-5.3-flash",
  );
  assert.equal(
    inferDwarfStarModelId("/tmp/ds4/glm5-next-Q4_K.gguf"),
    "glm-5.3-flash",
  );
  assert.equal(inferDwarfStarModelId("/tmp/ds4/DeepSeek-V4-Flashback.gguf"), null);
  assert.equal(inferDwarfStarModelId("/tmp/ds4/my-flash-model.gguf"), null);
  assert.equal(inferDwarfStarModelId("/tmp/ds4/custom-name.gguf"), null);
});

test("reduces picker selections and aliases to canonical ids", () => {
  assert.equal(canonicalModelId("ds4/deepseek-v4-flash"), "deepseek-v4-flash");
  assert.equal(canonicalModelId("glm-5.3-flash-chat"), "glm-5.3-flash");
  assert.equal(canonicalModelId("zai/glm-5.2-reasoner"), "glm-5.2");
  assert.equal(canonicalModelId("ds4/GLM-5.3-Flash-Q2"), "glm-5.3-flash");
  assert.equal(canonicalModelId("gpt-5.6"), null);
});

test("matches the default DS4 model namespace", () => {
  assert.equal(
    matchesModelSelection(
      { providerId: "pi", model: "ds4/deepseek-v4-flash" },
      "",
      "ds4/",
    ),
    true,
  );
});

test("supports exact model ids and an optional provider filter", () => {
  assert.equal(
    matchesModelSelection(
      { providerId: "pi", model: "deepseek-v4-flash" },
      "pi",
      "deepseek-v4-flash",
    ),
    true,
  );
  assert.equal(
    matchesModelSelection(
      { providerId: "codex", model: "ds4/deepseek-v4-flash" },
      "pi",
      "ds4/",
    ),
    false,
  );
});

test("does not match a sibling namespace", () => {
  assert.equal(
    matchesModelSelection(
      { providerId: "pi", model: "ds4-pro/deepseek-v4-flash" },
      "",
      "ds4",
    ),
    false,
  );
});

test("parses and bounds the idle timeout", () => {
  assert.equal(parseIdleTimeoutMs("30"), 30_000);
  assert.equal(parseIdleTimeoutMs("0"), 0);
  assert.equal(parseIdleTimeoutMs("not a number"), 300_000);
  assert.equal(parseIdleTimeoutMs("999999"), 24 * 60 * 60 * 1000);
});
