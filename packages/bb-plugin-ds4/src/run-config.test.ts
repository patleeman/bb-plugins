import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentCommand,
  parseDsparkConfidence,
  validateDsparkModelPath,
  type ResolvedRunConfig,
} from "./run-config.ts";

test("uses DwarfStar's backend-specific DSpark default when unset", () => {
  assert.equal(parseDsparkConfidence(""), null);
  assert.equal(parseDsparkConfidence("auto"), null);
  assert.equal(parseDsparkConfidence("default"), null);
  assert.equal(parseDsparkConfidence("0"), 0);
  assert.equal(parseDsparkConfidence("1"), 1);
  assert.equal(parseDsparkConfidence("0.75"), 0.75);
  assert.equal(parseDsparkConfidence("1.1"), null);
  assert.equal(parseDsparkConfidence("not-a-number"), null);
});

test("limits external DSpark support to recognizable Flash models", () => {
  assert.equal(
    validateDsparkModelPath(
      "/tmp/ds4/gguf/DeepSeek-V4-Flash-Layers37-42Q4KExperts-0731.gguf",
    ),
    null,
  );
  assert.match(
    validateDsparkModelPath("/tmp/ds4/gguf/DeepSeek-V4-Pro-IQ2XXS.gguf") ?? "",
    /only with a Flash model/,
  );
  assert.match(
    validateDsparkModelPath("/tmp/ds4/gguf/GLM-5.2-UD-Q2_K.gguf") ?? "",
    /only with a Flash model/,
  );
  assert.match(
    validateDsparkModelPath("/models/custom-name.gguf") ?? "",
    /only with a Flash model/,
  );
});

test("passes the current ROCm and DSpark flags to ds4-agent", () => {
  const cfg: ResolvedRunConfig = {
    ds4Dir: "/tmp/ds4",
    bin: "/tmp/ds4/ds4-server",
    args: [
      "-m",
      "/tmp/ds4/gguf/DeepSeek-V4-Flash-0731.gguf",
      "--rocm",
      "--host",
      "127.0.0.1",
      "--port",
      "8000",
      "-c",
      "32768",
      "--dspark",
      "--dspark-confidence",
      "0.7",
    ],
    modelPath: "/tmp/ds4/gguf/DeepSeek-V4-Flash-0731.gguf",
    host: "127.0.0.1",
    port: 8000,
    ctx: 32768,
    maxTokens: 1024,
    backend: "rocm",
    dspark: true,
    dsparkSupportPath: "/tmp/ds4/gguf/support.gguf",
    dsparkConfidence: 0.7,
    fingerprint: "test",
  };

  assert.deepEqual(agentCommand(cfg), {
    bin: "/tmp/ds4/ds4-agent",
    args: [
      "-m",
      "/tmp/ds4/gguf/DeepSeek-V4-Flash-0731.gguf",
      "--rocm",
      "--mtp",
      "/tmp/ds4/gguf/support.gguf",
      "--dspark",
      "--dspark-confidence",
      "0.7",
      "-c",
      "32768",
    ],
  });
});
