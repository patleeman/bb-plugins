// Server-side scene merge for collaborative (multi-writer) Excalidraw editing.
//
// The database stores one scene per drawing. Writers are:
//   - the user's open editor (full-scene autosaves, element `version` fields
//     reflect real edits),
//   - an agent via the `excalidraw_update_drawing` native tool or the
//     `bb excalidraw merge` CLI (explicit element upserts + deletes).
//
// Merge rules (element-level, Excalidraw-style):
//   - Elements are keyed by `id`; both writers' elements survive (union).
//   - For the same id, the higher `version` wins (Excalidraw bumps `version`
//     on every edit); equal versions prefer the tombstone (deleted) so a
//     stale writer can't resurrect a deleted element.
//   - Deleted elements are kept in the stored scene as tombstones
//     (`isDeleted: true`) so deletions propagate to every writer, exactly
//     like Excalidraw's own multiplayer. Rendering/reading surfaces filter
//     them out.
//   - Agent upserts always win for the elements they touch (the server bumps
//     the version), and deletions are explicit (`deletedElementIds`).
//
// This module is pure TypeScript (no DOM, no @excalidraw imports) so it runs
// in the bb server process.
//
// Portions of the fractional-indexing code below are from the
// `fractional-indexing` package (CC0 / public domain, based on
// https://observablehq.com/@dgreensp/implementing-fractional-indexing).

export type SceneElement = Record<string, unknown> & {
  id?: unknown;
  type?: unknown;
  version?: unknown;
  versionNonce?: unknown;
  isDeleted?: unknown;
  index?: unknown;
  updated?: unknown;
};

export type StoredScene = {
  elements: SceneElement[];
  appState: Record<string, unknown>;
  files: Record<string, unknown>;
};

const TOMBSTONE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function emptyScene(): StoredScene {
  return { elements: [], appState: {}, files: {} };
}

/**
 * Keys Excalidraw's own save format keeps in appState. The runtime AppState
 * holds Map-typed fields (`collaborators`, `pointers`, …) that JSON-serialize
 * to `{}` and crash the editor on reload ("collaborators.forEach is not a
 * function"), so we persist only the export-safe subset — matching what
 * Excalidraw itself writes to files.
 */
const EXPORT_APP_STATE_KEYS = [
  "viewBackgroundColor",
  "gridModeEnabled",
  "gridSize",
  "gridStep",
];

/** Keep only the export-safe appState keys (unknowns dropped). */
export function sanitizeAppStateForStorage(
  appState: Record<string, unknown> | undefined | null,
): Record<string, unknown> {
  if (!appState || typeof appState !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const key of EXPORT_APP_STATE_KEYS) {
    if (appState[key] !== undefined) out[key] = appState[key];
  }
  return out;
}

export function parseSceneData(data: string): StoredScene | null {
  try {
    const parsed = JSON.parse(data) as Partial<StoredScene>;
    if (!parsed || !Array.isArray(parsed.elements)) return null;
    return {
      elements: parsed.elements as SceneElement[],
      appState: (parsed.appState ?? {}) as Record<string, unknown>,
      files: (parsed.files ?? {}) as Record<string, unknown>,
    };
  } catch {
    return null;
  }
}

export function serializeSceneData(scene: StoredScene): string {
  return JSON.stringify(
    {
      type: "excalidraw",
      version: 2,
      source: "bb-plugin-excalidraw",
      elements: scene.elements,
      appState: scene.appState,
      files: scene.files,
    },
    null,
    2,
  );
}

export function isDeleted(el: SceneElement | null | undefined): boolean {
  return el?.isDeleted === true;
}

export function getNonDeletedElements(scene: StoredScene | null): SceneElement[] {
  return (scene?.elements ?? []).filter((el) => !isDeleted(el));
}

export function elementCount(scene: StoredScene | null): number {
  return getNonDeletedElements(scene).length;
}

export function elementVersion(el: SceneElement): number {
  return typeof el.version === "number" ? el.version : 0;
}

export function elementNonce(el: SceneElement): number {
  return typeof el.versionNonce === "number" ? el.versionNonce : 0;
}

function randomNonce(): number {
  return Math.floor(Math.random() * 2_147_483_647);
}

/** Plain lexicographic compare of Excalidraw fractional `index` strings. */
export function compareIndex(a: SceneElement, b: SceneElement): number {
  const ia = typeof a.index === "string" ? a.index : "";
  const ib = typeof b.index === "string" ? b.index : "";
  if (ia === ib) return 0;
  return ia < ib ? -1 : 1;
}

function sortByIndex(elements: SceneElement[]): SceneElement[] {
  return [...elements].sort(compareIndex);
}

/**
 * Pick the winning element for the same id between the currently-stored
 * element and an incoming full-scene element (editor autosave path).
 * Higher `version` wins; equal versions prefer the tombstone; then the
 * higher `versionNonce` breaks the tie.
 */
function pickVersionWinner(cur: SceneElement, inc: SceneElement): SceneElement {
  const cv = elementVersion(cur);
  const iv = elementVersion(inc);
  if (iv > cv) return inc;
  if (iv < cv) return cur;
  if (isDeleted(inc) !== isDeleted(cur)) return isDeleted(inc) ? inc : cur;
  return elementNonce(inc) > elementNonce(cur) ? inc : cur;
}

/**
 * Merge a full-scene save (the editor's autosave) into the stored scene.
 * Union by element id with version-based conflict resolution. appState and
 * files merge shallowly (incoming keys win).
 */
export function mergeFullScene(
  currentData: string,
  incomingData: string,
): StoredScene {
  const cur = parseSceneData(currentData) ?? emptyScene();
  const inc = parseSceneData(incomingData) ?? emptyScene();
  const byId = new Map<string, SceneElement>();
  for (const el of cur.elements) {
    if (el && typeof el.id === "string" && el.id) byId.set(el.id, el);
  }
  for (const el of inc.elements) {
    if (!el || typeof el.id !== "string" || !el.id) continue;
    const existing = byId.get(el.id);
    byId.set(el.id, existing ? pickVersionWinner(existing, el) : el);
  }
  const scene: StoredScene = {
    elements: sortByIndex([...byId.values()]),
    appState: sanitizeAppStateForStorage({ ...cur.appState, ...inc.appState }),
    files: { ...cur.files, ...inc.files },
  };
  return pruneTombstones(scene);
}

/**
 * Apply explicit element upserts + deletions (agent tool / CLI path).
 * Upserts merge into the stored element (partial updates keep the other
 * properties) and always win: their version is bumped above whatever is
 * stored, so they override any concurrent stale copy. `deletedElementIds`
 * mark elements deleted (tombstone with a bumped version).
 */
export function applyElementUpserts(
  currentData: string,
  upserts: SceneElement[],
  options: {
    deletedElementIds?: string[];
    appState?: Record<string, unknown>;
    files?: Record<string, unknown>;
  } = {},
): StoredScene {
  const cur = parseSceneData(currentData) ?? emptyScene();
  const byId = new Map<string, SceneElement>();
  for (const el of cur.elements) {
    if (el && typeof el.id === "string" && el.id) byId.set(el.id, el);
  }

  const now = Date.now();
  for (const el of upserts) {
    if (!el || typeof el.id !== "string" || !el.id) continue;
    const existing = byId.get(el.id);
    const incVersion = typeof el.version === "number" ? el.version : 1;
    if (existing && isDeleted(existing) && incVersion <= elementVersion(existing)) {
      // Stale re-add of an element the other writer deleted: keep the
      // tombstone (the deletion happened at a higher version). Only an
      // explicitly newer version (undo/re-add intent) resurrects it.
      continue;
    }
    const version = existing
      ? Math.max(elementVersion(existing), incVersion) + 1
      : incVersion;
    const index =
      typeof el.index === "string" && el.index.length > 0
        ? el.index
        : typeof existing?.index === "string" && existing.index.length > 0
          ? existing.index
          : nextIndexAfter([...byId.values()]);
    // Merge into the stored element: agents often send only the properties
    // they change (`{ id, type, x }`), which must not wipe the rest.
    byId.set(el.id, {
      ...existing,
      ...el,
      version,
      versionNonce: randomNonce(),
      updated: now,
      isDeleted: false,
      index,
    });
  }

  for (const id of options.deletedElementIds ?? []) {
    const existing = byId.get(id);
    if (!existing) continue;
    byId.set(id, {
      ...existing,
      isDeleted: true,
      version: elementVersion(existing) + 1,
      versionNonce: randomNonce(),
      updated: now,
    });
  }

  const scene: StoredScene = {
    elements: sortByIndex([...byId.values()]),
    appState: sanitizeAppStateForStorage({
      ...cur.appState,
      ...(options.appState ?? {}),
    }),
    files: { ...cur.files, ...(options.files ?? {}) },
  };
  return pruneTombstones(scene);
}

/**
 * True when `next` differs from `current` in membership or in any element's
 * `version`/`versionNonce` — i.e. applying it would change the editor.
 */
export function elementsChanged(
  current: readonly SceneElement[],
  next: readonly SceneElement[],
): boolean {
  if (current.length !== next.length) return true;
  const byId = new Map<unknown, SceneElement>();
  for (const el of current) byId.set(el.id, el);
  return next.some((el) => {
    const cur = byId.get(el.id);
    return (
      !cur ||
      elementVersion(cur) !== elementVersion(el) ||
      elementNonce(cur) !== elementNonce(el)
    );
  });
}

/** Files in `remote` whose ids aren't loaded in `local` yet. */
export function missingFiles(
  local: Record<string, unknown>,
  remote: Record<string, unknown> | undefined,
): unknown[] {
  return Object.entries(remote ?? {})
    .filter(([id, file]) => !(id in local) && file && typeof file === "object")
    .map(([, file]) => file);
}

/** Drop tombstones older than TOMBSTONE_MAX_AGE_MS (they've long propagated). */
export function pruneTombstones(scene: StoredScene): StoredScene {
  const now = Date.now();
  return {
    ...scene,
    elements: scene.elements.filter(
      (el) =>
        !isDeleted(el) ||
        typeof el.updated !== "number" ||
        now - el.updated < TOMBSTONE_MAX_AGE_MS,
    ),
  };
}

// ---------------------------------------------------------------------------
// Fractional indexing (z-order for new elements). Ported from
// `fractional-indexing` (CC0), which is based on David Greenspan's
// "Implementing Fractional Indexing".
// ---------------------------------------------------------------------------

const BASE_62_DIGITS =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function midpoint(
  a: string,
  b: string | null | undefined,
  digits: string,
): string {
  const zero = digits[0];
  if (b != null && a >= b) throw new Error(a + " >= " + b);
  if (a.slice(-1) === zero || (b && b.slice(-1) === zero)) {
    throw new Error("trailing zero");
  }
  if (b) {
    let n = 0;
    while ((a[n] || zero) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n), digits);
  }
  const digitA = a ? digits.indexOf(a[0]) : 0;
  const digitB = b != null ? digits.indexOf(b[0]) : digits.length;
  if (digitB - digitA > 1) {
    return digits[Math.round(0.5 * (digitA + digitB))];
  }
  if (b && b.length > 1) {
    return b.slice(0, 1);
  }
  return digits[digitA] + midpoint(a.slice(1), null, digits);
}

function getIntegerLength(head: string): number {
  if (head >= "a" && head <= "z") {
    return head.charCodeAt(0) - "a".charCodeAt(0) + 2;
  } else if (head >= "A" && head <= "Z") {
    return "Z".charCodeAt(0) - head.charCodeAt(0) + 2;
  }
  throw new Error("invalid order key head: " + head);
}

function getIntegerPart(key: string): string {
  const integerPartLength = getIntegerLength(key[0]);
  if (integerPartLength > key.length) throw new Error("invalid order key: " + key);
  return key.slice(0, integerPartLength);
}

function validateOrderKey(key: string, digits: string): void {
  if (key === "A" + digits[0].repeat(26)) {
    throw new Error("invalid order key: " + key);
  }
  const i = getIntegerPart(key);
  const f = key.slice(i.length);
  if (f.slice(-1) === digits[0]) throw new Error("invalid order key: " + key);
}

function incrementInteger(x: string, digits: string): string | null {
  const [head, ...digs] = x.split("");
  let carry = true;
  for (let i = digs.length - 1; carry && i >= 0; i--) {
    const d = digits.indexOf(digs[i]) + 1;
    if (d === digits.length) {
      digs[i] = digits[0];
    } else {
      digs[i] = digits[d];
      carry = false;
    }
  }
  if (carry) {
    if (head === "Z") return "a" + digits[0];
    if (head === "z") return null;
    const h = String.fromCharCode(head.charCodeAt(0) + 1);
    if (h > "a") digs.push(digits[0]);
    else digs.pop();
    return h + digs.join("");
  }
  return head + digs.join("");
}

/** Generate a fractional index between `a` and `b` (either may be null). */
export function generateKeyBetween(
  a: string | null | undefined,
  b: string | null | undefined,
  digits: string = BASE_62_DIGITS,
): string {
  if (a != null) validateOrderKey(a, digits);
  if (b != null) validateOrderKey(b, digits);
  if (a != null && b != null && a >= b) throw new Error(a + " >= " + b);
  if (a == null) {
    if (b == null) return "a" + digits[0];
    const ib = getIntegerPart(b);
    const fb = b.slice(ib.length);
    if (ib === "A" + digits[0].repeat(26)) return ib + midpoint("", fb, digits);
    if (ib < b) return ib;
    return incrementInteger(ib, digits) ?? ib + midpoint(fb, null, digits);
  }
  if (b == null) {
    const ia = getIntegerPart(a);
    const fa = a.slice(ia.length);
    const i = incrementInteger(ia, digits);
    return i == null ? ia + midpoint(fa, null, digits) : i;
  }
  const ia = getIntegerPart(a);
  const fa = a.slice(ia.length);
  const ib = getIntegerPart(b);
  const fb = b.slice(ib.length);
  if (ia === ib) return ia + midpoint(fa, fb, digits);
  const i = incrementInteger(ia, digits);
  if (i == null) throw new Error("cannot increment any more");
  if (i < b) return i;
  return ia + midpoint(fa, null, digits);
}

/** Index for a brand-new element: after the last existing index (top layer). */
export function nextIndexAfter(elements: SceneElement[]): string {
  const nonDeleted = elements.filter((el) => !isDeleted(el));
  let maxIndex: string | null = null;
  for (const el of nonDeleted) {
    if (typeof el.index === "string" && el.index.length > 0) {
      if (maxIndex === null || el.index > maxIndex) maxIndex = el.index;
    }
  }
  try {
    return generateKeyBetween(maxIndex, null);
  } catch {
    // Extremely deep index chains — fall back to a deterministic suffix.
    return `${maxIndex ?? "a0"}.${Date.now().toString(36)}`;
  }
}
