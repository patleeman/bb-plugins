// Pure run-configuration logic for the DS4 plugin: resolving the DS4 checkout
// directory, building the ds4-server command line, and computing a fingerprint
// used to detect config drift (so the supervisor can restart on change).

import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { inferDwarfStarModelId } from "./model-selection.ts";

export type BackendChoice = "auto" | "metal" | "cuda" | "rocm" | "cpu";

/** Practical default for the 2-bit models on a 128 GB Apple Silicon host. */
export const DEFAULT_DWARFSTAR_CONTEXT_TOKENS = 250_000;

/** Current support checkpoint shipped by DwarfStar's ds4f-dspark target. */
export const DEFAULT_DSPARK_SUPPORT_FILE =
  "DeepSeek-V4-Flash-DSpark-support-0731.gguf";
/** Kept as a fallback for older checkouts that predate the 0731 checkpoint. */
const LEGACY_DSPARK_SUPPORT_FILE = "DeepSeek-V4-Flash-DSpark-support.gguf";
/** Sidecar encoder shipped by DwarfStar's GLM 5.3 vision target. */
export const DEFAULT_GLM53_VISION_FILE =
  "GLM-5.3-Flash-Vision-Encoder.gguf";

export interface RunSettings {
  ds4Dir: string;
  modelPath: string;
  /** `auto` detects the standard GLM 5.3 encoder; empty disables vision. */
  visionPath: string;
  backend: BackendChoice;
  host: string;
  port: string;
  ctx: string;
  maxTokens: string;
  kvDiskDir: string;
  kvDiskSpaceMb: string;
  power: string;
  extraArgs: string;
  dspark: boolean;
  dsparkSupportPath: string;
  dsparkConfidence: string;
  /** Supervisor-only setting; it does not affect the ds4-server command line. */
  restartOnCrash: boolean;
}

export interface ResolvedRunConfig {
  ds4Dir: string | null;
  /** Absolute path to the ds4-server binary, or null when the dir is unknown. */
  bin: string | null;
  args: string[];
  modelPath: string | null;
  /** Absolute path to the GLM 5.3 vision encoder, or null when disabled. */
  visionPath: string | null;
  /** Parsed flags supplied through the free-form extraArgs setting. */
  extraArgs: string[];
  host: string;
  port: number;
  ctx: number;
  maxTokens: number;
  backend: BackendChoice;
  dspark: boolean;
  /** Absolute path to the DSpark support GGUF, or null when no checkout exists. */
  dsparkSupportPath: string | null;
  /** null lets DwarfStar choose its backend-specific default. */
  dsparkConfidence: number | null;
  fingerprint: string;
}

/** Quote-aware whitespace splitter for the free-form extraArgs field. */
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** Parse the optional DSpark threshold; empty/auto delegates to DwarfStar. */
export function parseDsparkConfidence(raw: string): number | null {
  const input = raw.trim().toLowerCase();
  if (!input || input === "auto" || input === "default") return null;
  const value = Number(input);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

/**
 * DSpark's external support GGUF is currently paired only with Flash. Keep
 * the opt-in path safe when a user points the same checkout at PRO, GLM, or a
 * custom model whose family cannot be verified from its filename.
 */
export function validateDsparkModelPath(modelPath: string | null): string | null {
  if (!modelPath) return null;
  return inferDwarfStarModelId(modelPath) === "deepseek-v4-flash"
    ? null
    : `DSpark is supported only with a Flash model. The configured model path is not recognizable as Flash: ${modelPath}. Disable dspark or set modelPath to a supported Flash GGUF.`;
}

/**
 * Resolve the DS4 checkout directory. Explicit setting wins; otherwise the
 * DS4_DIR env var, then common locations, then `which ds4-server`.
 */
export function detectDs4Dir(explicit: string): string | null {
  if (explicit && existsSync(join(explicit, "ds4-server"))) return explicit;
  if (process.env.DS4_DIR && existsSync(join(process.env.DS4_DIR, "ds4-server"))) {
    return process.env.DS4_DIR;
  }
  const home = homedir();
  const candidates = [
    join(home, "workingdir", "ds4"),
    join(home, "ds4"),
    join(home, "src", "ds4"),
    join(home, "code", "ds4"),
    join(home, "dev", "ds4"),
    "/opt/ds4",
  ];
  for (const c of candidates) {
    if (existsSync(join(c, "ds4-server"))) return c;
  }
  try {
    const out = execFileSync("which", ["ds4-server"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (out && existsSync(out)) return dirname(out);
  } catch {
    // not on PATH
  }
  return null;
}

/** Infer a model family through a symlink such as ds4flash.gguf. */
export function resolvedDwarfStarModelId(modelPath: string | null) {
  if (!modelPath) return null;
  try {
    return inferDwarfStarModelId(realpathSync(modelPath)) ?? inferDwarfStarModelId(modelPath);
  } catch {
    return inferDwarfStarModelId(modelPath);
  }
}

export function resolveConfig(s: RunSettings): ResolvedRunConfig {
  const ds4Dir = detectDs4Dir(s.ds4Dir);
  const port = parseInt(s.port, 10) || 8000;
  const ctx = parseInt(s.ctx, 10) || DEFAULT_DWARFSTAR_CONTEXT_TOKENS;
  const maxTokens = parseInt(s.maxTokens, 10) || 0;
  const backend: BackendChoice =
    s.backend === "metal" ||
    s.backend === "cuda" ||
    s.backend === "rocm" ||
    s.backend === "cpu"
      ? s.backend
      : "auto";
  const dspark = s.dspark === true;
  const dsparkConfidence = parseDsparkConfidence(s.dsparkConfidence);

  const modelPath = s.modelPath
    ? isAbsolute(s.modelPath)
      ? s.modelPath
      : join(ds4Dir ?? ".", s.modelPath)
    : ds4Dir
      ? join(ds4Dir, "ds4flash.gguf")
      : null;

  const bin = ds4Dir ? join(ds4Dir, "ds4-server") : null;

  const visionSetting = (s.visionPath ?? "").trim();
  const visionPath =
    visionSetting.toLowerCase() === "auto"
        ? ds4Dir && resolvedDwarfStarModelId(modelPath) === "glm-5.3-flash"
        ? [
            join(ds4Dir, "gguf", DEFAULT_GLM53_VISION_FILE),
            join(ds4Dir, DEFAULT_GLM53_VISION_FILE),
          ].find((candidate) => existsSync(candidate)) ?? null
        : null
      : visionSetting
        ? isAbsolute(visionSetting)
          ? visionSetting
          : join(ds4Dir ?? ".", visionSetting)
        : null;

  const dsparkSupportSetting = s.dsparkSupportPath.trim();
  const dsparkSupportPath = ds4Dir
    ? dsparkSupportSetting
      ? isAbsolute(dsparkSupportSetting)
        ? dsparkSupportSetting
        : join(ds4Dir, dsparkSupportSetting)
      : [
          join(ds4Dir, "gguf", DEFAULT_DSPARK_SUPPORT_FILE),
          join(ds4Dir, DEFAULT_DSPARK_SUPPORT_FILE),
          join(ds4Dir, "gguf", LEGACY_DSPARK_SUPPORT_FILE),
          join(ds4Dir, LEGACY_DSPARK_SUPPORT_FILE),
        ].find((candidate) => existsSync(candidate)) ??
        join(ds4Dir, "gguf", DEFAULT_DSPARK_SUPPORT_FILE)
    : null;

  const args: string[] = [];
  if (modelPath) args.push("-m", modelPath);
  if (visionPath) args.push("--vision", visionPath);
  if (backend !== "auto") args.push(`--${backend}`);
  args.push("--host", s.host || "127.0.0.1", "--port", String(port), "-c", String(ctx));
  if (maxTokens > 0) args.push("-n", String(maxTokens)); // default max output tokens
  if (s.kvDiskDir) {
    args.push("--kv-disk-dir", s.kvDiskDir);
    args.push("--kv-disk-space-mb", String(parseInt(s.kvDiskSpaceMb, 10) || 4096));
  }
  if (s.power) args.push("--power", s.power);
  if (dspark) {
    if (dsparkSupportPath) args.push("--mtp-model", dsparkSupportPath);
    args.push("--dspark");
    if (dsparkConfidence !== null) {
      args.push("--dspark-confidence", String(dsparkConfidence));
    }
  }
  const extraArgs = s.extraArgs.trim() ? splitArgs(s.extraArgs) : [];
  args.push(...extraArgs);

  const fingerprint = JSON.stringify({
    ds4Dir,
    modelPath,
    visionPath,
    backend,
    host: s.host || "127.0.0.1",
    port,
    ctx,
    maxTokens,
    kvDiskDir: s.kvDiskDir,
    kvDiskSpaceMb: s.kvDiskSpaceMb,
    power: s.power,
    extraArgs: s.extraArgs,
    dspark,
    dsparkSupportPath,
    dsparkConfidence,
  });

  return {
    ds4Dir,
    bin,
    args,
    modelPath,
    visionPath,
    extraArgs,
    host: s.host || "127.0.0.1",
    port,
    ctx,
    maxTokens,
    backend,
    dspark,
    dsparkSupportPath,
    dsparkConfidence,
    fingerprint,
  };
}

/** Return true when a ds4 command line includes the requested vision encoder. */
export function hasDwarfStarVisionArg(
  args: readonly string[],
  visionPath: string,
  processCwd: string | null = null,
): boolean {
  let index = -1;
  for (let i = args.length - 1; i >= 0; i--) {
    if (args[i] === "--vision") {
      index = i;
      break;
    }
  }
  if (index < 0) return false;
  const configuredPath = args[index + 1];
  if (configuredPath === visionPath) return true;
  if (!processCwd || !configuredPath) return false;
  return canonicalPath(configuredPath, processCwd) === canonicalPath(visionPath, processCwd);
}

/**
 * An adopted external process is vision-capable only when its command line
 * includes the encoder configured for this plugin. Plugin-owned processes are
 * launched from the resolved configuration, so their command line is already
 * trusted here.
 */
export function isDwarfStarVisionProcessReady(
  external: boolean,
  args: readonly string[] | null,
  visionPath: string,
  processCwd: string | null = null,
): boolean {
  return !external || hasDwarfStarVisionArg(args ?? [], visionPath, processCwd);
}

/** Reject an extraArgs override that could change the effective encoder. */
export function dwarfStarVisionArgsError(
  args: readonly string[],
  visionPath: string | null,
): string | null {
  const count = args.filter((arg) => arg === "--vision").length;
  if (count <= (visionPath ? 1 : 0)) return null;
  return visionPath
    ? "Do not add --vision through extraArgs. Configure the encoder with visionPath so the effective vision capability is unambiguous."
    : "Do not add --vision through extraArgs. Set visionPath to auto or an encoder path, or leave it empty to disable vision.";
}

const VISION_CONFLICTING_EXTRA_ARGS = new Set([
  "-m",
  "--model",
  "--vision",
  "--backend",
  "--metal",
  "--cuda",
  "--rocm",
  "--cpu",
  "--gpu-vram",
  "--gpu-devices",
  "--cuda-tensor-parallel",
  "--chdir",
]);

/** Keep free-form flags from changing the effective vision model or backend. */
export function dwarfStarVisionExtraArgsError(
  extraArgs: readonly string[],
  visionPath: string | null,
): string | null {
  const unconditional = extraArgs.find((arg) => {
    const flag = extraArgFlag(arg);
    return flag === "--chdir" || flag === "--vision";
  });
  if (unconditional) {
    const flag = extraArgFlag(unconditional);
    if (flag === "--vision") {
      return visionPath
        ? "Do not add --vision through extraArgs. Configure the encoder with visionPath so the effective vision capability is unambiguous."
        : "Do not add --vision through extraArgs. Set visionPath to auto or an encoder path, or leave it empty to disable vision.";
    }
    return "Do not pass --chdir through extraArgs. The plugin must keep the DS4 working directory stable for safe process recovery.";
  }
  if (!visionPath) return null;
  const conflicting = extraArgs.find((arg) =>
    VISION_CONFLICTING_EXTRA_ARGS.has(extraArgFlag(arg)),
  );
  if (!conflicting) return null;
  const flag = extraArgFlag(conflicting);
  return `Do not override ${flag} through extraArgs while vision is enabled. Use the dedicated model/backend setting so the effective vision configuration can be validated.`;
}

function extraArgFlag(arg: string): string {
  const equals = arg.indexOf("=");
  return equals > 0 ? arg.slice(0, equals) : arg;
}

/** DS4's GLM 5.3 vision path requires a GPU backend. */
export function dwarfStarVisionBackendError(
  backend: BackendChoice,
  visionPath: string | null,
): string | null {
  return visionPath && backend === "cpu"
    ? "GLM 5.3 vision is not supported with the CPU backend. Choose auto, metal, cuda, or rocm, or disable vision."
    : null;
}

function canonicalPath(value: string, cwd: string): string {
  const path = isAbsolute(value) ? value : resolve(cwd, value);
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Quote a single argument for inclusion in a shell command string. */
export function shellQuote(arg: string): string {
  return /[\s"']/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

/** Build the command line for the interactive ds4-agent (no HTTP flags). */
export function agentCommand(cfg: ResolvedRunConfig): {
  bin: string;
  args: string[];
} {
  const bin = cfg.ds4Dir ? join(cfg.ds4Dir, "ds4-agent") : "ds4-agent";
  const args: string[] = [];
  if (cfg.modelPath) args.push("-m", cfg.modelPath);
  if (cfg.visionPath) args.push("--vision", cfg.visionPath);
  const backend = cfg.args.find(
    (a) => a === "--metal" || a === "--cuda" || a === "--rocm" || a === "--cpu",
  );
  if (backend) args.push(backend);
  if (cfg.dspark) {
    if (cfg.dsparkSupportPath) args.push("--mtp-model", cfg.dsparkSupportPath);
    args.push("--dspark");
    if (cfg.dsparkConfidence !== null) {
      args.push("--dspark-confidence", String(cfg.dsparkConfidence));
    }
  }
  args.push("-c", String(cfg.ctx));
  return { bin, args };
}
