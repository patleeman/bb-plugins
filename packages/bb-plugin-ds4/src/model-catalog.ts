// Pure model-catalog logic: discover downloaded DwarfStar GGUFs in a DS4
// checkout so the plugin can register every locally available model in the
// agent pickers and switch the server to the selected one on demand.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_GLM53_VISION_FILE } from "./run-config.ts";
import {
  CANONICAL_MODEL_ORDER,
  inferDwarfStarModelId,
  type CanonicalDwarfStarModelId,
} from "./model-selection.ts";

export interface CatalogEntry {
  id: CanonicalDwarfStarModelId;
  /** Absolute path of the GGUF backing this entry. */
  path: string;
  sizeBytes: number;
}

/**
 * Scan a DS4 checkout for downloaded supported model files. Looks at the
 * checkout root and its gguf/ directory; ignores partial downloads. When
 * several files map to the same canonical model the largest wins (bigger
 * files are usually the higher-quality quants).
 */
export function scanModelCatalog(ds4Dir: string | null): CatalogEntry[] {
  if (!ds4Dir) return [];
  const dirs = [ds4Dir, join(ds4Dir, "gguf")];
  const best = new Map<CanonicalDwarfStarModelId, CatalogEntry>();
  for (const dir of dirs) {
    let names: string[];
    try {
      if (!statSync(dir).isDirectory()) continue;
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const normalizedName = name.toLowerCase();
      if (!normalizedName.endsWith(".gguf")) continue;
      if (normalizedName === DEFAULT_GLM53_VISION_FILE.toLowerCase()) continue;
      if (name.endsWith(".part")) continue;
      const full = join(dir, name);
      let size = 0;
      try {
        size = statSync(full).size;
      } catch {
        continue;
      }
      if (size <= 0) continue;
      const id = inferDwarfStarModelId(name);
      if (!id) continue;
      const current = best.get(id);
      if (!current || size > current.sizeBytes) {
        best.set(id, { id, path: full, sizeBytes: size });
      }
    }
  }
  return CANONICAL_MODEL_ORDER
    .filter((id) => best.has(id))
    .map((id) => best.get(id) as CatalogEntry);
}

/**
 * Pick the catalog entry for a canonical id, preferring an exact path match,
 * then falling back to any downloaded entry for that id.
 */
export function catalogPathFor(
  catalog: CatalogEntry[],
  id: CanonicalDwarfStarModelId,
): string | null {
  return catalog.find((e) => e.id === id)?.path ?? null;
}

/**
 * The model id list to advertise: downloaded catalog ids first (stable
 * order), plus the configured id when its file is not recognizable, so the
 * current model always appears even with a custom filename.
 */
export function advertisedModelIds(
  catalog: CatalogEntry[],
  configuredModelPath: string | null,
  configuredModelId: CanonicalDwarfStarModelId | null = null,
): string[] {
  const ids = catalog.map((e) => e.id);
  const configured = configuredModelId ?? inferDwarfStarModelId(configuredModelPath);
  if (configured && !ids.includes(configured)) ids.push(configured);
  return ids.length ? ids : configured ? [configured] : ["deepseek-v4-flash"];
}
