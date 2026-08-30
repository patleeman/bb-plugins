/** Matching and parsing helpers for demand-driven DS4 lifecycle settings. */

export interface ModelSelection {
  providerId: string;
  model: string;
}

const DWARFSTAR_MODEL_IDS = new Set([
  "deepseek-v4-flash",
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
  | "deepseek-v4-pro"
  | "glm-5.2"
  | "glm-5.3-flash";

/** Stable display order for canonical ids in pickers and catalogs. */
export const CANONICAL_MODEL_ORDER: CanonicalDwarfStarModelId[] = [
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "glm-5.2",
  "glm-5.3-flash",
];

/** Return true for model ids advertised by the current DwarfStar server. */
export function isDwarfStarModel(model: string): boolean {
  return DWARFSTAR_MODEL_IDS.has(model.trim().toLowerCase());
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
  if (tail.startsWith("deepseek-v4-pro")) return "deepseek-v4-pro";
  if (tail.startsWith("glm-5.3")) return "glm-5.3-flash";
  if (tail.startsWith("glm-5.2")) return "glm-5.2";
  if (tail.startsWith("deepseek-v4-flash")) return "deepseek-v4-flash";
  return null;
}

/**
 * Return true when a model-picker selection belongs to this DS4 installation.
 *
 * BB commonly exposes the local model as `ds4/deepseek-v4-flash`, while some
 * provider integrations expose only the model tail. Treat a configured value
 * as either an exact model id or a namespace/prefix, so both forms can be
 * configured without coupling this plugin to one provider.
 */
export function matchesModelSelection(
  selection: ModelSelection,
  configuredProviderId: string,
  configuredModelSelector: string,
): boolean {
  const providerId = configuredProviderId.trim();
  if (providerId && selection.providerId.trim() !== providerId) return false;

  const model = selection.model.trim();
  const selector = configuredModelSelector.trim();
  if (!model || !selector) return false;

  return (
    model === selector ||
    model.startsWith(selector.endsWith("/") ? selector : `${selector}/`)
  );
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
