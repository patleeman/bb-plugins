import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  classifyModelFile,
  createModelDownloadPlan,
  hasModelFilePartial,
  isUsableModelFile,
} from "./model-download.ts";
import { dwarfStarGgufFileCandidates } from "./run-config.ts";

const DS4_DIR = "/tmp/ds4";

test("plans the Vision Experimental model and matching DSpark download", () => {
  const plan = createModelDownloadPlan({
    ds4Dir: DS4_DIR,
    modelPreset: "DeepSeek V4 Flash Vision Experimental",
    modelPath: `${DS4_DIR}/gguf/DeepSeek-V4-Flash-Vision-Exp-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8.gguf`,
    visionSetting: "auto",
    visionPath: `${DS4_DIR}/gguf/DeepSeek-V4-Flash-Vision-Encoder.gguf`,
    dspark: true,
    dsparkSupportPath: `${DS4_DIR}/gguf/DeepSeek-V4-Flash-Vision-Exp-DSpark-support.gguf`,
  });

  assert.equal(plan.downloadable, true);
  assert.deepEqual(plan.targets, ["ds4f-vision-q2", "ds4f-vision-dspark"]);
  assert.deepEqual(plan.files.map((file) => file.kind), [
    "model",
    "vision",
    "dspark",
  ]);
  assert.equal(plan.files[0]?.target, "ds4f-vision-q2");
  assert.equal(plan.files[1]?.target, "ds4f-vision-q2");
  assert.equal(plan.files[2]?.target, "ds4f-vision-dspark");
});

test("plans the standard base Flash model when its path is not resolved yet", () => {
  const plan = createModelDownloadPlan({
    ds4Dir: DS4_DIR,
    modelPreset: "DeepSeek V4 Flash",
    modelPath: null,
    visionSetting: "",
    visionPath: null,
    dspark: false,
    dsparkSupportPath: null,
  });

  assert.equal(
    plan.files[0]?.path,
    `${DS4_DIR}/gguf/DeepSeek-V4-Flash-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8-chat-v2-imatrix-0731.gguf`,
  );
  assert.deepEqual(plan.targets, ["ds4f-q2"]);
  assert.equal(plan.downloadable, true);
});

test("uses DS4_GGUF_DIR for standard model locations", () => {
  const previous = process.env.DS4_GGUF_DIR;
  try {
    process.env.DS4_GGUF_DIR = "downloaded-models";
    assert.deepEqual(dwarfStarGgufFileCandidates(DS4_DIR, "model.gguf"), [
      `${DS4_DIR}/downloaded-models/model.gguf`,
    ]);
    const plan = createModelDownloadPlan({
      ds4Dir: DS4_DIR,
      modelPreset: "GLM 5.3 Flash",
      modelPath: null,
      visionSetting: "",
      visionPath: null,
      dspark: false,
      dsparkSupportPath: null,
    });
    assert.equal(
      plan.files[0]?.path,
      `${DS4_DIR}/downloaded-models/GLM-5.3-Flash-Q2.gguf`,
    );
  } finally {
    if (previous === undefined) delete process.env.DS4_GGUF_DIR;
    else process.env.DS4_GGUF_DIR = previous;
  }
});

test("requires a named model before automatic download", () => {
  const plan = createModelDownloadPlan({
    ds4Dir: DS4_DIR,
    modelPreset: "auto",
    modelPath: `${DS4_DIR}/gguf/custom-name.gguf`,
    visionSetting: "auto",
    visionPath: null,
    dspark: false,
    dsparkSupportPath: null,
  });

  assert.equal(plan.downloadable, false);
  assert.deepEqual(plan.targets, []);
  assert.match(plan.error ?? "", /named model/i);
});

test("keeps custom sidecar paths checkable without offering the wrong target", () => {
  const customEncoder = "/models/my-vision-encoder.gguf";
  const plan = createModelDownloadPlan({
    ds4Dir: DS4_DIR,
    modelPreset: "GLM 5.3 Flash",
    modelPath: `${DS4_DIR}/gguf/GLM-5.3-Flash-Q2.gguf`,
    visionSetting: customEncoder,
    visionPath: customEncoder,
    dspark: false,
    dsparkSupportPath: null,
  });

  assert.equal(plan.files[1]?.path, customEncoder);
  assert.equal(plan.files[1]?.target, null);
  assert.deepEqual(plan.targets, ["glm53-q2"]);
});

test("classifies complete and partial downloads", () => {
  assert.equal(classifyModelFile(true, true), "present");
  assert.equal(classifyModelFile(false, true), "partial");
  assert.equal(classifyModelFile(false, false), "missing");
});

test("does not treat a zero-byte artifact as a usable model file", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "ds4-model-file-"));
  const emptyPath = join(tempDir, "empty.gguf");
  const populatedPath = join(tempDir, "populated.gguf");
  try {
    writeFileSync(emptyPath, "");
    writeFileSync(populatedPath, "gguf");
    assert.equal(isUsableModelFile(emptyPath), false);
    assert.equal(isUsableModelFile(populatedPath), true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("recognizes Hugging Face incomplete files as partial downloads", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "ds4-model-partial-"));
  const modelPath = join(tempDir, "model.gguf");
  const partialDir = join(tempDir, ".cache", "huggingface", "download");
  try {
    mkdirSync(partialDir, { recursive: true });
    const hash = createHash("sha1")
      .update("model.gguf.metadata")
      .digest("base64")
      .replaceAll("+", "-")
      .replaceAll("/", "_");
    writeFileSync(join(partialDir, `${hash}.etag.incomplete`), "");
    assert.equal(hasModelFilePartial(modelPath), true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
