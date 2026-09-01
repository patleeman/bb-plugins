import { readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import {
  DEFAULT_DEEPSEEK_VISION_FILE,
  DEFAULT_DEEPSEEK_VISION_MODEL_FILE,
  DEFAULT_DSPARK_VISION_SUPPORT_FILE,
  DEFAULT_GLM53_VISION_FILE,
  DEFAULT_GLM53_MODEL_FILE,
  DEFAULT_DEEPSEEK_FLASH_MODEL_FILE,
  dwarfStarGgufFileCandidates,
  resolvedDwarfStarModelId,
} from "./run-config.ts";
import {
  normalizeDwarfStarModelPreset,
  type CanonicalDwarfStarModelId,
  type DwarfStarModelPreset,
} from "./model-selection.ts";

/** Targets implemented by the current DS4 download_model.sh script. */
export type ModelDownloadTarget =
  | "ds4f-q2"
  | "ds4f-vision-q2"
  | "ds4f-vision-encoder"
  | "ds4f-dspark"
  | "ds4f-vision-dspark"
  | "glm53-q2"
  | "glm53-vision";

export type ModelDownloadFileKind = "model" | "vision" | "dspark";

export type ModelFileState = "present" | "missing" | "partial" | "unavailable";

export interface PlannedModelFile {
  kind: ModelDownloadFileKind;
  label: string;
  path: string | null;
  required: boolean;
  target: ModelDownloadTarget | null;
}

export interface ModelDownloadPlan {
  preset: DwarfStarModelPreset;
  modelId: CanonicalDwarfStarModelId | null;
  displayName: string;
  files: PlannedModelFile[];
  targets: ModelDownloadTarget[];
  /** Automatic downloads are intentionally available only for named presets. */
  downloadable: boolean;
  error: string | null;
}

export interface ModelDownloadPlanInput {
  ds4Dir: string | null;
  modelPreset?: string;
  modelPath: string | null;
  visionSetting?: string;
  visionPath: string | null;
  dspark: boolean;
  dsparkSupportPath: string | null;
}

/** A zero-byte placeholder is not a downloaded model artifact. */
export function isUsableModelFile(path: string): boolean {
  try {
    const stat = statSync(path);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

/** Detect the partial-file markers used by both curl and Hugging Face CLI. */
export function hasModelFilePartial(path: string): boolean {
  const candidates = [
    `${path}.part`,
    `${path}.aria2`,
  ];
  if (candidates.some((candidate) => {
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  })) return true;

  const downloadDir = join(dirname(path), ".cache", "huggingface", "download");
  const metadataName = `${basename(path)}.metadata`;
  const hash = createHash("sha1")
    .update(metadataName)
    .digest("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_");
  try {
    return readdirSync(downloadDir, { withFileTypes: true }).some(
      (entry) =>
        entry.isFile() &&
        entry.name.startsWith(`${hash}.`) &&
        entry.name.endsWith(".incomplete"),
    );
  } catch {
    return false;
  }
}

function standardCandidates(ds4Dir: string | null, file: string): string[] {
  if (!ds4Dir) return [];
  return dwarfStarGgufFileCandidates(ds4Dir, file);
}

function standardPath(
  ds4Dir: string | null,
  file: string,
): string | null {
  return standardCandidates(ds4Dir, file)[0] ?? null;
}

function standardModelFile(
  modelId: CanonicalDwarfStarModelId | null,
): string | null {
  switch (modelId) {
    case "deepseek-v4-flash":
      return DEFAULT_DEEPSEEK_FLASH_MODEL_FILE;
    case "deepseek-v4-flash-vision-exp":
      return DEFAULT_DEEPSEEK_VISION_MODEL_FILE;
    case "glm-5.3-flash":
      return DEFAULT_GLM53_MODEL_FILE;
    default:
      return null;
  }
}

function isStandardPath(path: string | null, candidates: readonly string[]): boolean {
  if (!path) return true;
  const resolved = resolve(path);
  return candidates.some((candidate) => resolve(candidate) === resolved);
}

function modelDisplayName(modelId: CanonicalDwarfStarModelId | null): string {
  switch (modelId) {
    case "deepseek-v4-flash":
      return "DeepSeek V4 Flash";
    case "deepseek-v4-flash-vision-exp":
      return "DeepSeek V4 Flash Vision Experimental";
    case "glm-5.3-flash":
      return "GLM 5.3 Flash";
    default:
      return "DwarfStar model";
  }
}

function targetForModel(
  modelId: CanonicalDwarfStarModelId | null,
): ModelDownloadTarget | null {
  switch (modelId) {
    case "deepseek-v4-flash":
      return "ds4f-q2";
    case "deepseek-v4-flash-vision-exp":
      return "ds4f-vision-q2";
    case "glm-5.3-flash":
      return "glm53-q2";
    default:
      return null;
  }
}

function visionFile(
  input: ModelDownloadPlanInput,
  preset: DwarfStarModelPreset,
  modelId: CanonicalDwarfStarModelId | null,
): PlannedModelFile | null {
  const visionEnabled = (input.visionSetting ?? "auto").trim() !== "";
  if (!visionEnabled || (modelId !== "deepseek-v4-flash-vision-exp" && modelId !== "glm-5.3-flash")) {
    return null;
  }

  const encoderFile =
    modelId === "deepseek-v4-flash-vision-exp"
      ? DEFAULT_DEEPSEEK_VISION_FILE
      : DEFAULT_GLM53_VISION_FILE;
  const candidates = standardCandidates(input.ds4Dir, encoderFile);
  const target =
    isStandardPath(input.visionPath, candidates)
      ? modelId === "deepseek-v4-flash-vision-exp"
        ? "ds4f-vision-q2"
        : "glm53-vision"
      : null;
  return {
    kind: "vision",
    label: "Vision encoder",
    path: input.visionPath ?? standardPath(input.ds4Dir, encoderFile),
    required: true,
    // A custom path can still be checked, but the upstream downloader cannot
    // place its standard encoder at that arbitrary path.
    target: preset === "auto" && target !== null ? null : target,
  };
}

function dsparkFile(
  input: ModelDownloadPlanInput,
  preset: DwarfStarModelPreset,
  modelId: CanonicalDwarfStarModelId | null,
): PlannedModelFile | null {
  if (!input.dspark) return null;
  const isVision = modelId === "deepseek-v4-flash-vision-exp";
  if (modelId !== "deepseek-v4-flash" && !isVision) {
    return {
      kind: "dspark",
      label: "DSpark support",
      path: input.dsparkSupportPath,
      required: true,
      target: null,
    };
  }
  const file = isVision
    ? DEFAULT_DSPARK_VISION_SUPPORT_FILE
    : "DeepSeek-V4-Flash-DSpark-support-0731.gguf";
  const candidates = standardCandidates(input.ds4Dir, file);
  return {
    kind: "dspark",
    label: "DSpark support",
    path: input.dsparkSupportPath ?? standardPath(input.ds4Dir, file),
    required: true,
    target:
      preset === "auto" || !isStandardPath(input.dsparkSupportPath, candidates)
        ? null
        : isVision
          ? "ds4f-vision-dspark"
          : "ds4f-dspark",
  };
}

/** Build the expected selected-model artifacts and safe downloader targets. */
export function createModelDownloadPlan(
  input: ModelDownloadPlanInput,
): ModelDownloadPlan {
  const preset = normalizeDwarfStarModelPreset(input.modelPreset);
  const modelId =
    preset === "auto"
      ? resolvedDwarfStarModelId(input.modelPath)
      : preset;
  const displayName = modelDisplayName(modelId);
  const modelTarget = targetForModel(modelId);
  const configuredModelPath =
    input.modelPath ??
    (preset === "auto"
      ? null
      : standardPath(input.ds4Dir, standardModelFile(modelId) ?? ""));
  const files: PlannedModelFile[] = [
    {
      kind: "model",
      label: "Language model GGUF",
      path: configuredModelPath,
      required: true,
      target: preset === "auto" ? null : modelTarget,
    },
  ];
  const encoder = visionFile(input, preset, modelId);
  if (encoder) files.push(encoder);
  const support = dsparkFile(input, preset, modelId);
  if (support) files.push(support);

  const targets = [...new Set(
    files
      .map((file) => file.target)
      .filter((target): target is ModelDownloadTarget => target !== null),
  )];
  let error: string | null = null;
  if (!input.ds4Dir) {
    error = "DS4 checkout directory was not found.";
  } else if (preset === "auto") {
    error = "Select a named model before downloading automatically.";
  } else if (!modelTarget) {
    error = "The selected model is not supported by DS4's downloader.";
  }

  return {
    preset,
    modelId,
    displayName,
    files,
    targets,
    downloadable: error === null && targets.length > 0,
    error,
  };
}

/** Classify a file without making filesystem access part of the plan logic. */
export function classifyModelFile(
  exists: boolean,
  hasPartialDownload: boolean,
): ModelFileState {
  if (exists) return "present";
  if (hasPartialDownload) return "partial";
  return "missing";
}
