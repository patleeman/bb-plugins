// Explore: names, directive parsing and job stages the server and the app
// share. Runtime-free (only constants), so it's bundled into both.
import { PLUGIN_ID } from "../constants";

/** The directive: `::explore{items="🐛 Retry backoff disagrees in billing|🏗️ How the job queue works"}`. */
export const DIRECTIVE = "explore";
/** Pages' thread panel tab; `{ explainerId }` params open an explainer in it. */
export const PAGE_PANEL_ACTION = "page";
/** The Studio tag every explainer page gets. */
export const EXPLORE_TAG = "Explore";
/** Who explainer pages are written by: an agent-style key, shown as "an agent". */
export const EXPLORE_ACTOR = "agent:explore";
/**
 * `pluginMetadata` key on an Explore worker thread (a hidden fork of the
 * thread): it gets neither the Explore instructions nor the tool.
 */
export const WORKER_METADATA_KEY = "exploreExplainerId";

/** A reply lists at most this many findings; an explainer's own follow-ups are fewer. */
export const MAX_ITEMS = 4;
export const MAX_FOLLOW_UPS = 3;
/** Longer labels are cut: a finding is a line, not a paragraph. */
export const MAX_LABEL_LENGTH = 80;
/** A finding the model wrote without an emoji gets this one. */
export const DEFAULT_EMOJI = "🔎";

export interface ExploreItem {
  emoji: string;
  /** The finding without its emoji, e.g. "How the job queue works". */
  label: string;
}

const EMOJI = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[#*0-9]️?⃣)/u;

/** Case- and space-insensitive identity of a label, for dedupe and lookups. */
export function labelKey(label: string): string {
  return label.replace(/\s+/g, " ").trim().toLowerCase();
}

function cut(label: string): string {
  if (label.length <= MAX_LABEL_LENGTH) return label;
  const room = label.slice(0, MAX_LABEL_LENGTH - 1);
  const space = room.lastIndexOf(" ");
  return `${(space > MAX_LABEL_LENGTH / 2 ? room.slice(0, space) : room).trimEnd()}…`;
}

/** One `emoji label` item. The emoji is optional; the label isn't. */
export function parseExploreItem(raw: string): ExploreItem | null {
  // Attributes come from the model: drop quotes, braces and control characters.
  const text = raw.replace(/[\u0000-\u001f"{}]/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (EMOJI.test(text)) {
    // The first grapheme, so "🐛Retry" (no space) splits too and 🏗️ keeps its variation selector.
    const first = new Intl.Segmenter().segment(text)[Symbol.iterator]().next().value?.segment ?? "";
    const label = cut(text.slice(first.length).trim());
    return label ? { emoji: first.slice(0, 16), label } : null;
  }
  return { emoji: DEFAULT_EMOJI, label: cut(text) };
}

/** The directive's `items` attribute: `|`-separated, capped, deduped. */
export function parseExploreItems(raw: string | undefined | null, max = MAX_ITEMS): ExploreItem[] {
  if (typeof raw !== "string") return [];
  const seen = new Set<string>();
  const items: ExploreItem[] = [];
  for (const part of raw.slice(0, 4_000).split("|")) {
    const item = parseExploreItem(part);
    if (!item) continue;
    const key = labelKey(item.label);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
    if (items.length >= max) break;
  }
  return items;
}

/** Back into the attribute form. */
export function formatExploreItems(items: readonly ExploreItem[]): string {
  return items.map((item) => `${item.emoji} ${item.label}`).join("|");
}

export const JOB_STATUSES = ["queued", "collecting", "starting", "writing", "saving", "ready", "error", "cancelled", "interrupted"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const ACTIVE_JOB_STATUSES: readonly JobStatus[] = ["queued", "collecting", "starting", "writing", "saving"];

export function isActiveJob(status: JobStatus): boolean {
  return ACTIVE_JOB_STATUSES.includes(status);
}

/** The stages a job goes through, with where each one starts on the bar. */
export const STAGES: Record<JobStatus, { label: string; progress: number }> = {
  queued: { label: "Queued", progress: 2 },
  collecting: { label: "Collecting context", progress: 8 },
  starting: { label: "Starting worker", progress: 15 },
  writing: { label: "Writing", progress: 22 },
  saving: { label: "Saving", progress: 92 },
  ready: { label: "Ready", progress: 100 },
  error: { label: "Failed", progress: 0 },
  cancelled: { label: "Stopped", progress: 0 },
  interrupted: { label: "Interrupted", progress: 0 },
};

/** What a finding's row shows. */
export type RowState = "idle" | "running" | "ready" | "error";

export function explainerHref(pageId: string): string {
  return `/plugins/${PLUGIN_ID}/pages/${pageId}`;
}

export function threadHref(threadId: string): string {
  return `/threads/${threadId}`;
}
