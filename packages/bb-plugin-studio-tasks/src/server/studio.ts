// Tasks as a Studio add-on: the `studio_*` methods Studio calls to list and
// manage tasks in its collection.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { eachId, type StudioBadge, type StudioItem, type StudioKind, type StudioSchemas } from "@bb-studio/kit/contract";
import { registerStudioProvider } from "@bb-studio/kit/server";
import {
  HANDOFF_SHORT,
  HANDOFF_TONES,
  PLUGIN_ID,
  DEFAULT_COLUMNS,
  type TaskColumn,
  TASK_ICON,
  formatDue,
  isOpenHandoff,
  isOverdue,
  taskHref,
  type TaskStatus,
} from "../shared";
import { firstLine } from "./handoff";
import type { HandoffRow, TaskRow, TaskStore } from "./store";

export const TASK_KIND: StudioKind = {
  id: "task",
  label: "Task",
  plural: "Tasks",
  icon: TASK_ICON,
  columns: [
    { id: "status", label: "Status" },
    { id: "due", label: "Due" },
    { id: "assignee", label: "Assignee" },
  ],
  actions: [
    { id: "mark-done", label: "Mark {count} done", icon: "CircleCheck", result: "toast" },
    { id: "reopen", label: "Move {count} to To do", icon: "RotateCcw", result: "toast" },
  ],
  create: { mode: "rpc" },
  canArchive: true,
  blurb: "Things to do, for you or an agent.",
};

const STATUS_TONES: Record<TaskStatus, StudioBadge["tone"]> = {
  todo: "neutral",
  in_progress: "progress",
  review: "warning",
  done: "success",
};

/** Handoff states worth a badge instead of the status. */
const LOUD = new Set(["working", "needs-input", "failed"]);

export function assigneeLabel(task: Pick<TaskRow, "assignee">): string {
  return task.assignee === "me" ? "Me" : task.assignee === "agent" ? "Agent" : "Unassigned";
}

export function taskBadge(task: TaskRow, handoff: HandoffRow | null, columns: TaskColumn[] = DEFAULT_COLUMNS): StudioBadge {
  if (handoff && task.status !== "done" && isOpenHandoff(handoff.state) && LOUD.has(handoff.state)) {
    return { label: HANDOFF_SHORT[handoff.state], tone: HANDOFF_TONES[handoff.state] };
  }
  if (task.due && isOverdue(task.due, task.status)) return { label: "Overdue", tone: "danger" };
  return { label: columns.find((column) => column.id === task.status)?.label ?? task.status, tone: STATUS_TONES[task.status] ?? "neutral" };
}

export function toStudioItem(task: TaskRow, handoff: HandoffRow | null, columns: TaskColumn[] = DEFAULT_COLUMNS): StudioItem {
  return {
    id: task.id,
    kind: TASK_KIND.id,
    title: task.title,
    icon: null,
    projectId: task.project_id,
    parentId: null,
    createdAt: task.created_at,
    updatedAt: task.updated_at,
    updatedBy: task.updated_by === "user" || task.updated_by === "agent" ? task.updated_by : null,
    preview: firstLine(task.description) ?? handoff?.note ?? null,
    facts: [
      { id: "status", value: columns.find((column) => column.id === task.status)?.label ?? task.status, sort: columns.findIndex((column) => column.id === task.status) },
      { id: "due", value: task.due ? formatDue(task.due) : "", sort: task.due ? Date.parse(`${task.due}T00:00:00Z`) : null },
      { id: "assignee", value: assigneeLabel(task), sort: task.assignee === "me" ? 0 : task.assignee === "agent" ? 1 : null },
    ],
    badge: taskBadge(task, handoff, columns),
    thumbnailUrl: null,
    href: taskHref(task.id),
    archived: task.archived_at !== null,
  };
}

export function registerStudio(
  bb: Pick<BbPluginApi, "rpc">,
  schemas: StudioSchemas,
  deps: {
    store: TaskStore;
    changed(id: string): void;
    /** Moves a task the way the board does, archiving its threads on Done when that's on. */
    move(id: string, status: TaskStatus): Promise<void>;
  },
): void {
  const { store } = deps;
  const mustGet = (id: string) => {
    const task = store.get(id);
    if (!task) throw new Error("Task not found.");
    return task;
  };

  registerStudioProvider(bb, schemas, {
    studio_describe: () => ({ pluginId: PLUGIN_ID, version: 1, panel: "tasks", kinds: [TASK_KIND] }),
    studio_list: () => ({
      items: store.list({ includeArchived: true }).map((task) => toStudioItem(task, store.latestHandoff(task.id), store.boardConfig().columns)),
    }),
    // Studio matches titles itself; this finds descriptions and handoff notes.
    studio_search: ({ query }) => {
      const needle = query.toLowerCase();
      return {
        ids: store
          .list()
          .filter(
            (task) =>
              task.description.toLowerCase().includes(needle) ||
              store.handoffs(task.id).some((handoff) => handoff.note?.toLowerCase().includes(needle)),
          )
          .slice(0, 200)
          .map((task) => task.id),
      };
    },
    studio_create: ({ kind, projectId }) => {
      if (kind !== TASK_KIND.id) throw new Error(`Tasks can't make a "${kind}".`);
      const task = store.create({ title: "", projectId, by: "user" });
      deps.changed(task.id);
      return { item: toStudioItem(task, null, store.boardConfig().columns) };
    },
    studio_move: ({ ids, projectId }) =>
      eachId(ids, (id) => {
        mustGet(id);
        store.update(id, { projectId }, "user");
        deps.changed(id);
      }),
    studio_archive: ({ ids, archived }) =>
      eachId(ids, (id) => {
        store.setArchived(id, archived);
        deps.changed(id);
      }),
    studio_delete: ({ ids }) =>
      eachId(ids, (id) => {
        mustGet(id);
        store.delete(id);
        deps.changed(id);
      }),
    studio_action: async ({ action, ids }) => {
      if (action !== "mark-done" && action !== "reopen") throw new Error(`Unknown action "${action}".`);
      const status: TaskStatus = action === "mark-done" ? "done" : "todo";
      const { done } = await eachId(ids, async (id) => {
        mustGet(id);
        await deps.move(id, status);
      });
      const count = done.length === 1 ? "1 task" : `${done.length} tasks`;
      return { message: action === "mark-done" ? `Marked ${count} done` : `Moved ${count} to To do`, text: null };
    },
  });
}
