// Pure run-configuration logic for the DS4 plugin: resolving the DS4 checkout
// directory, building the ds4-server command line, and computing a fingerprint
// used to detect config drift (so the supervisor can restart on change).

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";
import { inferDwarfStarModelId } from "./model-selection.ts";

export type BackendChoice = "auto" | "metal" | "cuda" | "rocm" | "cpu";

/** Current support checkpoint shipped by DwarfStar's ds4f-dspark target. */
export const DEFAULT_DSPARK_SUPPORT_FILE =
  "DeepSeek-V4-Flash-DSpark-support-0731.gguf";
/** Kept as a fallback for older checkouts that predate the 0731 checkpoint. */
const LEGACY_DSPARK_SUPPORT_FILE = "DeepSeek-V4-Flash-DSpark-support.gguf";

export interface RunSettings {
  ds4Dir: string;
  modelPath: string;
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
  restartOnCrash: boolean;
  configurePi: boolean;
  configureOpencode: boolean;
  configureCodex: boolean;
}

export interface ResolvedRunConfig {
  ds4Dir: string | null;
  /** Absolute path to the ds4-server binary, or null when the dir is unknown. */
  bin: string | null;
  args: string[];
  modelPath: string | null;
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

export function resolveConfig(s: RunSettings): ResolvedRunConfig {
  const ds4Dir = detectDs4Dir(s.ds4Dir);
  const port = parseInt(s.port, 10) || 8000;
  const ctx = parseInt(s.ctx, 10) || 100000;
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
  if (backend !== "auto") args.push(`--${backend}`);
  args.push("--host", s.host || "127.0.0.1", "--port", String(port), "-c", String(ctx));
  if (maxTokens > 0) args.push("-n", String(maxTokens)); // default max output tokens
  if (s.kvDiskDir) {
    args.push("--kv-disk-dir", s.kvDiskDir);
    args.push("--kv-disk-space-mb", String(parseInt(s.kvDiskSpaceMb, 10) || 4096));
  }
  if (s.power) args.push("--power", s.power);
  if (dspark) {
    if (dsparkSupportPath) args.push("--mtp", dsparkSupportPath);
    args.push("--dspark");
    if (dsparkConfidence !== null) {
      args.push("--dspark-confidence", String(dsparkConfidence));
    }
  }
  if (s.extraArgs.trim()) args.push(...splitArgs(s.extraArgs));

  const fingerprint = JSON.stringify({
    ds4Dir,
    modelPath,
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
  const backend = cfg.args.find(
    (a) => a === "--metal" || a === "--cuda" || a === "--rocm" || a === "--cpu",
  );
  if (backend) args.push(backend);
  if (cfg.dspark) {
    if (cfg.dsparkSupportPath) args.push("--mtp", cfg.dsparkSupportPath);
    args.push("--dspark");
    if (cfg.dsparkConfidence !== null) {
      args.push("--dspark-confidence", String(cfg.dsparkConfidence));
    }
  }
  args.push("-c", String(cfg.ctx));
  return { bin, args };
}
