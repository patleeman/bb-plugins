import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentCommand,
  DEFAULT_DEEPSEEK_VISION_FILE,
  DEFAULT_DEEPSEEK_VISION_MODEL_FILE,
  DEFAULT_DSPARK_VISION_SUPPORT_FILE,
  DEFAULT_GLM53_VISION_FILE,
  dwarfStarVisionBackendError,
  dwarfStarVisionArgsError,
  dwarfStarVisionExtraArgsError,
  hasDwarfStarVisionArg,
  isDwarfStarVisionProcessReady,
  parseDsparkConfidence,
  resolveConfig,
  resolvedDwarfStarModelId,
  validateDsparkModelPath,
  validateDsparkSupportPath,
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
  assert.equal(
    validateDsparkModelPath(
      `/tmp/ds4/gguf/${DEFAULT_DEEPSEEK_VISION_MODEL_FILE}`,
    ),
    null,
  );
});

test("matches Vision Experimental models with their DSpark support file", () => {
  const modelPath = `/tmp/ds4/gguf/${DEFAULT_DEEPSEEK_VISION_MODEL_FILE}`;
  const supportPath = `/tmp/ds4/gguf/${DEFAULT_DSPARK_VISION_SUPPORT_FILE}`;
  assert.equal(validateDsparkSupportPath(modelPath, supportPath), null);
  assert.match(
    validateDsparkSupportPath(
      modelPath,
      "/tmp/ds4/gguf/DeepSeek-V4-Flash-DSpark-support-0731.gguf",
    ) ?? "",
    /requires its matching DSpark support/i,
  );
  assert.match(
    validateDsparkSupportPath(
      "/tmp/ds4/gguf/DeepSeek-V4-Flash-0731.gguf",
      supportPath,
    ) ?? "",
    /only be used with the DeepSeek V4 Flash Vision Experimental/i,
  );
});

test("matches Vision Experimental DSpark through the standard model symlink", () => {
  const ds4Dir = mkdtempSync(join(tmpdir(), "ds4-dspark-link-"));
  const modelPath = join(ds4Dir, "ds4flash.gguf");
  const targetPath = join(ds4Dir, DEFAULT_DEEPSEEK_VISION_MODEL_FILE);
  const supportPath = join(ds4Dir, DEFAULT_DSPARK_VISION_SUPPORT_FILE);
  try {
    writeFileSync(targetPath, "model");
    writeFileSync(supportPath, "support");
    symlinkSync(DEFAULT_DEEPSEEK_VISION_MODEL_FILE, modelPath);
    assert.equal(validateDsparkSupportPath(modelPath, supportPath), null);
  } finally {
    rmSync(ds4Dir, { recursive: true, force: true });
  }
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
    visionPath: null,
    extraArgs: [],
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
      "--mtp-model",
      "/tmp/ds4/gguf/support.gguf",
      "--dspark",
      "--dspark-confidence",
      "0.7",
      "-c",
      "32768",
    ],
  });
});

test("auto-detects the GLM 5.3 vision sidecar through the default model link", () => {
  const ds4Dir = mkdtempSync(join(tmpdir(), "ds4-vision-"));
  const modelPath = join(ds4Dir, "gguf", "GLM-5.3-Flash-Q2.gguf");
  const visionPath = join(ds4Dir, "gguf", DEFAULT_GLM53_VISION_FILE);
  try {
    mkdirSync(join(ds4Dir, "gguf"));
    writeFileSync(join(ds4Dir, "ds4-server"), "");
    writeFileSync(modelPath, "model");
    writeFileSync(visionPath, "vision");
    symlinkSync("gguf/GLM-5.3-Flash-Q2.gguf", join(ds4Dir, "ds4flash.gguf"));

    const cfg = resolveConfig({
      ds4Dir,
      modelPath: "",
      visionPath: "auto",
      backend: "auto",
      host: "127.0.0.1",
      port: "8000",
      ctx: "32768",
      maxTokens: "1024",
      kvDiskDir: "",
      kvDiskSpaceMb: "8192",
      power: "",
      extraArgs: "",
      dspark: false,
      dsparkSupportPath: "",
      dsparkConfidence: "",
      restartOnCrash: true,
    });

    assert.equal(cfg.visionPath, visionPath);
    assert.deepEqual(cfg.args.slice(0, 4), ["-m", join(ds4Dir, "ds4flash.gguf"), "--vision", visionPath]);
  } finally {
    rmSync(ds4Dir, { recursive: true, force: true });
  }
});

test("resolves the DeepSeek Vision Experimental model preset and sidecars", () => {
  const ds4Dir = mkdtempSync(join(tmpdir(), "ds4-vision-exp-"));
  const modelPath = join(ds4Dir, "gguf", DEFAULT_DEEPSEEK_VISION_MODEL_FILE);
  const visionPath = join(ds4Dir, "gguf", DEFAULT_DEEPSEEK_VISION_FILE);
  const supportPath = join(ds4Dir, "gguf", DEFAULT_DSPARK_VISION_SUPPORT_FILE);
  try {
    mkdirSync(join(ds4Dir, "gguf"));
    writeFileSync(join(ds4Dir, "ds4-server"), "");
    writeFileSync(modelPath, "model");
    writeFileSync(visionPath, "vision");
    writeFileSync(supportPath, "support");
    symlinkSync("gguf/GLM-5.3-Flash-Q2.gguf", join(ds4Dir, "ds4flash.gguf"));

    const cfg = resolveConfig({
      ds4Dir,
      modelPath: "custom-path-is-ignored-for-named-presets.gguf",
      modelPreset: "deepseek-v4-flash-vision-exp",
      visionPath: "auto",
      backend: "auto",
      host: "127.0.0.1",
      port: "8000",
      ctx: "32768",
      maxTokens: "1024",
      kvDiskDir: "",
      kvDiskSpaceMb: "8192",
      power: "",
      extraArgs: "",
      dspark: true,
      dsparkSupportPath: "",
      dsparkConfidence: "",
      restartOnCrash: true,
    });

    assert.equal(cfg.modelPath, modelPath);
    assert.equal(cfg.visionPath, visionPath);
    assert.equal(cfg.dsparkSupportPath, supportPath);
    assert.deepEqual(
      cfg.args.slice(0, 6),
      ["-m", modelPath, "--vision", visionPath, "--host", "127.0.0.1"],
    );
    assert.equal(cfg.args.includes("--mtp-model"), true);
  } finally {
    rmSync(ds4Dir, { recursive: true, force: true });
  }
});

test("keeps the GLM family when a recognizable symlink targets a custom filename", () => {
  const ds4Dir = mkdtempSync(join(tmpdir(), "ds4-vision-link-"));
  const modelPath = join(ds4Dir, "GLM-5.3-Flash.gguf");
  const targetPath = join(ds4Dir, "model-with-custom-name.gguf");
  const visionPath = join(ds4Dir, "gguf", DEFAULT_GLM53_VISION_FILE);
  try {
    mkdirSync(join(ds4Dir, "gguf"));
    writeFileSync(join(ds4Dir, "ds4-server"), "");
    writeFileSync(targetPath, "model");
    writeFileSync(visionPath, "vision");
    symlinkSync("model-with-custom-name.gguf", modelPath);

    assert.equal(resolvedDwarfStarModelId(modelPath), "glm-5.3-flash");
    const cfg = resolveConfig({
      ds4Dir,
      modelPath: "GLM-5.3-Flash.gguf",
      visionPath: "auto",
      backend: "auto",
      host: "127.0.0.1",
      port: "8000",
      ctx: "32768",
      maxTokens: "1024",
      kvDiskDir: "",
      kvDiskSpaceMb: "8192",
      power: "",
      extraArgs: "",
      dspark: false,
      dsparkSupportPath: "",
      dsparkConfidence: "",
      restartOnCrash: true,
    });
    assert.equal(cfg.visionPath, visionPath);
  } finally {
    rmSync(ds4Dir, { recursive: true, force: true });
  }
});

test("matches the configured vision flag exactly", () => {
  const args = ["-m", "/tmp/model.gguf", "--vision", "/tmp/encoder.gguf"];
  assert.equal(hasDwarfStarVisionArg(args, "/tmp/encoder.gguf"), true);
  assert.equal(
    hasDwarfStarVisionArg(
      ["-m", "gguf/model.gguf", "--vision", "gguf/encoder.gguf"],
      "/tmp/ds4/gguf/encoder.gguf",
      "/tmp/ds4",
    ),
    true,
  );
  assert.equal(
    hasDwarfStarVisionArg(
      [...args, "--vision", "/tmp/other-encoder.gguf"],
      "/tmp/encoder.gguf",
    ),
    false,
  );
  assert.equal(hasDwarfStarVisionArg(args, "/tmp/other-encoder.gguf"), false);
  assert.equal(
    hasDwarfStarVisionArg(["-m", "/tmp/model.gguf"], "/tmp/encoder.gguf"),
    false,
  );
});

test("requires an adopted external server to carry the configured vision flag", () => {
  const args = ["-m", "/tmp/model.gguf", "--vision", "/tmp/encoder.gguf"];
  assert.equal(
    isDwarfStarVisionProcessReady(true, args, "/tmp/encoder.gguf"),
    true,
  );
  assert.equal(
    isDwarfStarVisionProcessReady(true, ["-m", "/tmp/model.gguf"], "/tmp/encoder.gguf"),
    false,
  );
  assert.equal(isDwarfStarVisionProcessReady(false, null, "/tmp/encoder.gguf"), true);
});

test("rejects vision overrides hidden in extraArgs", () => {
  assert.equal(dwarfStarVisionArgsError(["-m", "/tmp/model.gguf"], null), null);
  assert.match(
    dwarfStarVisionArgsError(
      ["-m", "/tmp/model.gguf", "--vision", "/tmp/encoder.gguf"],
      null,
    ) ?? "",
    /set visionPath/i,
  );
  assert.match(
    dwarfStarVisionArgsError(
      [
        "-m",
        "/tmp/model.gguf",
        "--vision",
        "/tmp/encoder.gguf",
        "--vision",
        "/tmp/other-encoder.gguf",
      ],
      "/tmp/encoder.gguf",
    ) ?? "",
    /extraArgs/i,
  );
  assert.match(
    dwarfStarVisionExtraArgsError(["--backend", "cpu"], "/tmp/encoder.gguf") ?? "",
    /override --backend/i,
  );
  assert.match(
    dwarfStarVisionExtraArgsError(["--gpu-vram", "0"], "/tmp/encoder.gguf") ?? "",
    /override --gpu-vram/i,
  );
  assert.match(
    dwarfStarVisionExtraArgsError(["--gpu-devices", "0,1"], "/tmp/encoder.gguf") ?? "",
    /override --gpu-devices/i,
  );
  assert.match(
    dwarfStarVisionExtraArgsError(["--cuda-tensor-parallel"], "/tmp/encoder.gguf") ?? "",
    /override --cuda-tensor-parallel/i,
  );
  assert.match(
    dwarfStarVisionExtraArgsError(["--backend=cpu"], "/tmp/encoder.gguf") ?? "",
    /override --backend/i,
  );
  assert.match(
    dwarfStarVisionExtraArgsError(["--chdir", "other-checkout"], null) ?? "",
    /working directory stable/i,
  );
  assert.match(
    dwarfStarVisionExtraArgsError(["--cpu", "--chdir", "other-checkout"], null) ?? "",
    /working directory stable/i,
  );
  assert.match(
    dwarfStarVisionExtraArgsError(["--backend=cpu", "--vision=/tmp/other-encoder.gguf"], null) ?? "",
    /set visionPath/i,
  );
  assert.equal(
    dwarfStarVisionExtraArgsError(["--backend", "cpu"], null),
    null,
  );
});

test("rejects CPU vision configurations", () => {
  assert.match(
    dwarfStarVisionBackendError("cpu", "/tmp/encoder.gguf") ?? "",
    /not supported with the CPU backend/i,
  );
  assert.equal(dwarfStarVisionBackendError("metal", "/tmp/encoder.gguf"), null);
  assert.equal(dwarfStarVisionBackendError("cpu", null), null);
});

test("passes a configured GLM 5.3 vision encoder to ds4-agent", () => {
  const cfg: ResolvedRunConfig = {
    ds4Dir: "/tmp/ds4",
    bin: "/tmp/ds4/ds4-server",
    args: [
      "-m",
      "/tmp/ds4/gguf/GLM-5.3-Flash-Q2.gguf",
      "--vision",
      "/tmp/ds4/gguf/GLM-5.3-Flash-Vision-Encoder.gguf",
      "--metal",
      "--host",
      "127.0.0.1",
      "--port",
      "8000",
      "-c",
      "32768",
    ],
    modelPath: "/tmp/ds4/gguf/GLM-5.3-Flash-Q2.gguf",
    visionPath: "/tmp/ds4/gguf/GLM-5.3-Flash-Vision-Encoder.gguf",
    extraArgs: [],
    host: "127.0.0.1",
    port: 8000,
    ctx: 32768,
    maxTokens: 1024,
    backend: "metal",
    dspark: false,
    dsparkSupportPath: null,
    dsparkConfidence: null,
    fingerprint: "test",
  };

  assert.deepEqual(agentCommand(cfg), {
    bin: "/tmp/ds4/ds4-agent",
    args: [
      "-m",
      "/tmp/ds4/gguf/GLM-5.3-Flash-Q2.gguf",
      "--vision",
      "/tmp/ds4/gguf/GLM-5.3-Flash-Vision-Encoder.gguf",
      "--metal",
      "-c",
      "32768",
    ],
  });
});
