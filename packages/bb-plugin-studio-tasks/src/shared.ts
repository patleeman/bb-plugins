// Names, statuses and labels the server and the app share.
import type { StudioTone } from "@bb-studio/kit/contract";

export const PLUGIN_ID = "studio-tasks";
/** The nav panel: /plugins/studio-tasks/tasks, and tasks/<id> for one task. */
export const PANEL_PATH = "tasks";
export const TASK_ICON = "studio-tasks/task";
export const BOARD_ICON = "studio-tasks/board";
/** Realtime channel: the server says when a task changed. */
export const REALTIME_CHANNEL = "tasks";
export const TASK_UPDATE_TYPE = "task:updated";

export const STATUSES = ["todo", "in_progress", "review", "done"] as const;
export type TaskStatus = string;
export type TaskColumn = { id: string; label: string };

export const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  review: "Review",
  done: "Done",
};

export function isStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && /^(todo|in_progress|review|done|col_[0-9a-z]{16})$/.test(value);
}

export const DEFAULT_COLUMNS: TaskColumn[] = STATUSES.map((id) => ({ id, label: STATUS_LABELS[id]! }));
export const COLUMNS_UPDATE_TYPE = "columns:updated";

/** Who a task is for: you, an agent (through a handoff), or nobody yet. */
export type Assignee = "me" | "agent" | null;

/**
 * Where a handed-off thread stands. The task's status follows it, and the
 * card shows its label so it's clear who acts next.
 */
export const HANDOFF_STATES = ["starting", "working", "needs-input", "replied", "ready", "failed", "archived", "deleted"] as const;
export type HandoffState = (typeof HANDOFF_STATES)[number];

export const HANDOFF_LABELS: Record<HandoffState, string> = {
  starting: "Starting agent",
  working: "Agent working",
  "needs-input": "Agent needs your input",
  replied: "Agent replied, check its answer",
  ready: "Agent says it's ready for review",
  failed: "Agent failed",
  archived: "Thread archived",
  deleted: "Thread deleted",
};

/** The short form for cards. */
export const HANDOFF_SHORT: Record<HandoffState, string> = {
  starting: "Starting",
  working: "Agent working",
  "needs-input": "Needs your input",
  replied: "Agent replied",
  ready: "Ready for review",
  failed: "Agent failed",
  archived: "Thread archived",
  deleted: "Thread deleted",
};

export const HANDOFF_TONES: Record<HandoffState, StudioTone> = {
  starting: "progress",
  working: "live",
  "needs-input": "warning",
  replied: "success",
  ready: "success",
  failed: "danger",
  archived: "neutral",
  deleted: "neutral",
};

/** A handoff whose thread still exists and can change the task. */
export function isOpenHandoff(state: HandoffState): boolean {
  return state !== "archived" && state !== "deleted";
}

export function taskHref(id: string): string {
  return `/plugins/${PLUGIN_ID}/${PANEL_PATH}/${id}`;
}

/** Where each Studio add-on shows an item, for links an agent adds by id. */
const ITEM_PANELS: Record<string, string> = { pages: "pages", talk: "recordings", excalidraw: "drawings", artifacts: "artifacts" };

export function studioHref(pluginId: string, itemId: string): string | null {
  const panel = ITEM_PANELS[pluginId];
  return panel ? `/plugins/${pluginId}/${panel}/${encodeURIComponent(itemId)}` : null;
}

const ID = /^tsk_[0-9a-z]{16}$/;

export function isTaskId(value: string): boolean {
  return ID.test(value);
}

/** A due date is a day, "2026-10-01". */
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function isDay(value: string): boolean {
  if (!DAY.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

/** Today in local time, as a day. */
export function today(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** "Today", "Tomorrow", "Yesterday", "Oct 3", or "Oct 3, 2027" in another year. */
export function formatDue(day: string, now = new Date()): string {
  const current = today(now);
  const offset = dayNumber(day) - dayNumber(current);
  if (offset === 0) return "Today";
  if (offset === 1) return "Tomorrow";
  if (offset === -1) return "Yesterday";
  const date = new Date(`${day}T12:00:00`);
  const sameYear = day.slice(0, 4) === current.slice(0, 4);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

/** Past due and not done. */
export function isOverdue(day: string | null, status: TaskStatus, now = new Date()): boolean {
  return day !== null && status !== "done" && day < today(now);
}

function dayNumber(day: string): number {
  return Math.round(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
}
