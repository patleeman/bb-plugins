/** DwarfStar model identity and runtime helpers. */

const DWARFSTAR_MODEL_IDS = new Set([
  "deepseek-v4-flash",
  "deepseek-v4-flash-vision-exp",
  "deepseek-v4-pro",
  "glm-5.2",
  "glm-5.2-chat",
  "glm-5.2-no-think",
  "glm-5.2-nothink",
  "glm-5.2-reasoner",
  "zai/glm-5.2",
  "zai/glm-5.2-chat",
  "zai/glm-5.2-reasoner",
  "glm-5.3-flash",
  "glm-5.3-flash-chat",
  "glm-5.3-flash-no-think",
  "glm-5.3-flash-nothink",
  "glm-5.3-flash-reasoner",
  "zai/glm-5.3-flash",
  "zai/glm-5.3-flash-chat",
  "zai/glm-5.3-flash-reasoner",
]);

export type CanonicalDwarfStarModelId =
  | "deepseek-v4-flash"
  | "deepseek-v4-flash-vision-exp"
  | "deepseek-v4-pro"
  | "glm-5.2"
  | "glm-5.3-flash";

/** Known model selections exposed by the DS4 plugin settings. */
export const DWARFSTAR_MODEL_PRESET_OPTIONS = [
  "auto",
  "DeepSeek V4 Flash",
  "DeepSeek V4 Flash Vision Experimental",
  "GLM 5.3 Flash",
] as const;

export type DwarfStarModelPreset =
  | "auto"
  | "deepseek-v4-flash"
  | "deepseek-v4-flash-vision-exp"
  | "glm-5.3-flash";

/** Wire id used when settings point at a custom, unrecognizable GGUF name. */
export const CONFIGURED_DWARFSTAR_MODEL_ID = "dwarfstar-configured";

/** Return true for model ids advertised by the current DwarfStar server. */
export function isDwarfStarModel(model: string): boolean {
  return DWARFSTAR_MODEL_IDS.has(model.trim().toLowerCase());
}

/** Return true when the model family supports DwarfStar's vision sidecar. */
export function isDwarfStarVisionModel(model: string): boolean {
  const id = canonicalModelId(model);
  return id === "glm-5.3-flash" || id === "deepseek-v4-flash-vision-exp";
}

/** Normalize persisted settings values while retaining a safe auto default. */
export function normalizeDwarfStarModelPreset(
  value: string | undefined,
): DwarfStarModelPreset {
  switch (value?.trim().toLowerCase()) {
    case "deepseek-v4-flash":
    case "deepseek v4 flash":
      return "deepseek-v4-flash";
    case "deepseek-v4-flash-vision-exp":
    case "deepseek v4 flash vision experimental":
      return "deepseek-v4-flash-vision-exp";
    case "glm-5.3-flash":
    case "glm 5.3 flash":
      return "glm-5.3-flash";
    default:
      return "auto";
  }
}

/** Return the model id accepted by DwarfStar's OpenAI-compatible server. */
export function wireDwarfStarModelId(model: string): string {
  return canonicalModelId(model) === "deepseek-v4-flash-vision-exp"
    ? "deepseek-v4-flash"
    : model;
}

/** Infer the canonical engine family from a supported model filename. */
export function inferDwarfStarModelId(
  modelPath: string | null,
): CanonicalDwarfStarModelId | null {
  if (!modelPath) return null;
  const normalized = modelPath.replaceAll("\\", "/").toLowerCase();
  const filename = normalized.slice(normalized.lastIndexOf("/") + 1);
  if (
    /(?:^|[/._-])glm-5\.3(?:[/._-]|$)/.test(filename) ||
    /(?:^|[/._-])glm5-next(?:[/._-]|$)/.test(filename)
  ) {
    return "glm-5.3-flash";
  }
  if (/(?:^|[/._-])glm-5\.2(?:[/._-]|$)/.test(filename)) return "glm-5.2";
  if (
    /(?:^|[/._-])deepseek-v4-flash-vision-(?:exp|experimental)(?:[/._-]|$)/.test(
      filename,
    )
  ) {
    return "deepseek-v4-flash-vision-exp";
  }
  if (/(?:^|[/._-])deepseek-v4-pro(?:[/._-]|$)/.test(filename)) {
    return "deepseek-v4-pro";
  }
  if (
    /(?:^|[/._-])ds4flash(?:[/._-]|$)/.test(filename) ||
    /(?:^|[/._-])deepseek-v4-flash(?:[/._-]|$)/.test(filename)
  ) {
    return "deepseek-v4-flash";
  }
  return null;
}

/**
 * Reduce a picker/served model id (possibly provider-prefixed, possibly an
 * alias such as `glm-5.3-flash-chat`) to its canonical engine family.
 */
export function canonicalModelId(
  model: string,
): CanonicalDwarfStarModelId | null {
  const tail = (model.trim().toLowerCase().split("/").pop() ?? "").trim();
  if (
    /^deepseek-v4-flash-vision-(?:exp|experimental)(?:[-._]|$)/.test(tail)
  ) {
    return "deepseek-v4-flash-vision-exp";
  }
  if (tail.startsWith("deepseek-v4-pro")) return "deepseek-v4-pro";
  if (tail.startsWith("glm-5.3")) return "glm-5.3-flash";
  if (tail.startsWith("glm-5.2")) return "glm-5.2";
  if (tail.startsWith("deepseek-v4-flash")) return "deepseek-v4-flash";
  return null;
}

/** Parse a user-facing idle timeout in seconds, with a safe bounded default. */
export function parseIdleTimeoutMs(
  raw: string,
  defaultMs = 5 * 60 * 1000,
): number {
  const seconds = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(seconds) || seconds < 0) return defaultMs;
  return Math.min(seconds * 1000, 24 * 60 * 60 * 1000);
}
