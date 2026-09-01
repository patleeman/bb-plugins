import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalModelId,
  inferDwarfStarModelId,
  isDwarfStarModel,
  isDwarfStarVisionModel,
  parseIdleTimeoutMs,
  wireDwarfStarModelId,
} from "./model-selection.ts";

test("recognizes current DwarfStar model ids", () => {
  assert.equal(isDwarfStarModel("deepseek-v4-flash"), true);
  assert.equal(isDwarfStarModel("deepseek-v4-flash-vision-exp"), true);
  assert.equal(isDwarfStarModel("deepseek-v4-pro"), true);
  assert.equal(isDwarfStarModel("glm-5.2"), true);
  assert.equal(isDwarfStarModel("zai/glm-5.2-reasoner"), true);
  assert.equal(isDwarfStarModel("glm-5.3-flash"), true);
  assert.equal(isDwarfStarModel("zai/glm-5.3-flash-reasoner"), true);
  assert.equal(isDwarfStarModel("llama-3.3"), false);
});

test("identifies the vision model families with vision support", () => {
  assert.equal(isDwarfStarVisionModel("glm-5.3-flash"), true);
  assert.equal(isDwarfStarVisionModel("zai/glm-5.3-flash-reasoner"), true);
  assert.equal(isDwarfStarVisionModel("deepseek-v4-flash-vision-exp"), true);
  assert.equal(isDwarfStarVisionModel("glm-5.2"), false);
  assert.equal(isDwarfStarVisionModel("deepseek-v4-flash"), false);
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
    inferDwarfStarModelId(
      "/tmp/ds4/DeepSeek-V4-Flash-Vision-Exp-IQ2XXS-w2Q2K.gguf",
    ),
    "deepseek-v4-flash-vision-exp",
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
  assert.equal(
    canonicalModelId("ds4/deepseek-v4-flash-vision-exp"),
    "deepseek-v4-flash-vision-exp",
  );
  assert.equal(canonicalModelId("gpt-5.6"), null);
});

test("maps the Vision Experimental identity to DS4's wire alias", () => {
  assert.equal(
    wireDwarfStarModelId("deepseek-v4-flash-vision-exp"),
    "deepseek-v4-flash",
  );
  assert.equal(wireDwarfStarModelId("glm-5.3-flash"), "glm-5.3-flash");
});

test("parses and bounds the idle timeout", () => {
  assert.equal(parseIdleTimeoutMs("30"), 30_000);
  assert.equal(parseIdleTimeoutMs("0"), 0);
  assert.equal(parseIdleTimeoutMs("not a number"), 300_000);
  assert.equal(parseIdleTimeoutMs("999999"), 24 * 60 * 60 * 1000);
});
