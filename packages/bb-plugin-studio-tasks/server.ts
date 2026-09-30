// Studio Tasks (plugin id `studio-tasks`): a board of tasks you can hand to agents.
//
// Backend entry. Tasks live in the plugin's SQLite database
// (src/server/store.ts). Handing a task off spawns a thread with the task as
// its first message (src/server/prompt.ts); BB's thread events then move the
// handoff and its task between In progress and Review
// (src/server/handoff.ts). With BB Studio installed, tasks list in Studio's
// collection (src/server/studio.ts).
import { studioSchemas } from "@bb-studio/kit/contract";
import { createStudioNotifier } from "@bb-studio/kit/server";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { mentionContext } from "./lib/mention";
import { firstLine, nextHandoff, type ThreadSignal } from "./src/server/handoff";
import { handoffInput } from "./src/server/prompt";
import { assigneeLabel, registerStudio } from "./src/server/studio";
import { MIGRATIONS, TaskStore, type HandoffRow, type LinkRow, type TaskRow, type Writer } from "./src/server/store";
import {
  HANDOFF_LABELS,
  HANDOFF_STATES,
  PLUGIN_ID,
  REALTIME_CHANNEL,
  STATUSES,
  STATUS_LABELS,
  TASK_UPDATE_TYPE,
  formatDue,
  isDay,
  isOpenHandoff,
  isStatus,
  studioHref,
  taskHref,
  type TaskStatus,
} from "./src/shared";

/** The other Studio add-ons whose items a task can link to. */
const LINKABLE_PLUGINS = ["pages", "talk", "excalidraw", "artifacts"];

const idSchema = z.string().min(1).max(100);
const threadIdSchema = z.string().min(1).max(200);
const projectIdSchema = z.string().min(1).max(200);
const statusSchema = z.enum(STATUSES);
const assigneeSchema = z.enum(["me", "agent"]).nullable();
const daySchema = z.string().refine(isDay, "Use a day like 2026-10-01.").nullable();

/** A new worktree keeps the agent's changes apart; "folder" works in the project's folder. */
const workspaceSchema = z.enum(["worktree", "folder"]);

const handoffSchema = z.object({
  threadId: z.string(),
  state: z.enum(HANDOFF_STATES),
  note: z.string().nullable(),
  agent: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const taskSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  status: statusSchema,
  projectId: z.string().nullable(),
  due: z.string().nullable(),
  assignee: assigneeSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
  updatedBy: z.string().nullable(),
  doneAt: z.number().nullable(),
  archived: z.boolean(),
  /** The newest handoff, which is the one that moves the task. */
  handoff: handoffSchema.nullable(),
  /** Handoffs whose thread is still around (not archived or deleted). */
  openThreads: z.number(),
  links: z.number(),
});

const linkSchema = z.object({
  target: z.enum(["thread", "item"]),
  pluginId: z.string().nullable(),
  itemId: z.string(),
  label: z.string(),
  href: z.string().nullable(),
});

const linkableSchema = linkSchema.extend({ kind: z.string(), icon: z.string().nullable() });

export const rpcContract = defineRpcContract({
  board: {
    input: z.object({ includeArchived: z.boolean().optional() }),
    output: z.object({ tasks: z.array(taskSchema) }),
  },
  get: {
    input: z.object({ id: idSchema }),
    output: z.object({ task: taskSchema.nullable(), links: z.array(linkSchema), handoffs: z.array(handoffSchema) }),
  },
  create: {
    input: z.object({
      title: z.string().trim().max(300),
      description: z.string().max(20_000).optional(),
      status: statusSchema.optional(),
      projectId: projectIdSchema.nullable().optional(),
      due: daySchema.optional(),
      assignee: assigneeSchema.optional(),
    }),
    output: z.object({ task: taskSchema }),
  },
  update: {
    input: z.object({
      id: idSchema,
      title: z.string().trim().max(300).optional(),
      description: z.string().max(20_000).optional(),
      projectId: projectIdSchema.nullable().optional(),
      due: daySchema.optional(),
      assignee: assigneeSchema.optional(),
    }),
    output: z.object({ ok: z.boolean() }),
  },
  /** Puts a task in a column; `index` is its position among the column's other tasks. */
  move: {
    input: z.object({ id: idSchema, status: statusSchema, index: z.number().int().nonnegative().optional() }),
    output: z.object({ ok: z.boolean(), archivedThreads: z.number() }),
  },
  archive: {
    input: z.object({ id: idSchema, archived: z.boolean() }),
    output: z.object({ ok: z.boolean() }),
  },
  delete: {
    input: z.object({ id: idSchema }),
    output: z.object({ ok: z.boolean() }),
  },
  link: {
    input: z.object({ id: idSchema, link: linkSchema }),
    output: z.object({ ok: z.boolean() }),
  },
  unlink: {
    input: z.object({ id: idSchema, target: z.enum(["thread", "item"]), itemId: z.string().min(1).max(200) }),
    output: z.object({ ok: z.boolean() }),
  },
  /** Studio items and recent threads a task can link to. */
  linkables: {
    input: z.object({ projectId: projectIdSchema.nullable() }),
    output: z.object({ items: z.array(linkableSchema), errors: z.array(z.string()) }),
  },
  /** The project's default agent, to preselect in the handoff picker. */
  handoffDefaults: {
    input: z.object({ projectId: projectIdSchema }),
    output: z.object({
      providerId: z.string().nullable(),
      model: z.string().nullable(),
      reasoningLevel: z.string().nullable(),
    }),
  },
  handOff: {
    input: z.object({
      id: idSchema,
      projectId: projectIdSchema.nullable(),
      providerId: z.string().min(1).max(200).nullable(),
      model: z.string().min(1).max(200).nullable(),
      reasoningLevel: z.string().min(1).max(50).nullable(),
      note: z.string().max(20_000).nullable(),
      workspace: workspaceSchema,
    }),
    output: z.object({ threadId: z.string() }),
  },
  /** Sends the latest handoff's thread a follow-up, e.g. review feedback. */
  sendBack: {
    input: z.object({ id: idSchema, message: z.string().trim().min(1).max(20_000) }),
    output: z.object({ threadId: z.string() }),
  },
  archiveThreads: {
    input: z.object({ id: idSchema }),
    output: z.object({ archived: z.number(), failed: z.number() }),
  },
  settings: {
    input: z.null(),
    output: z.object({ archiveThreadsOnDone: z.boolean() }),
  },
});

type TaskDto = z.infer<typeof taskSchema>;

function toHandoffDto(handoff: HandoffRow) {
  return {
    threadId: handoff.thread_id,
    state: handoff.state,
    note: handoff.note,
    agent: handoff.agent,
    createdAt: handoff.created_at,
    updatedAt: handoff.updated_at,
  };
}

function toLinkDto(link: LinkRow) {
  return { target: link.target, pluginId: link.plugin_id, itemId: link.item_id, label: link.label, href: link.href };
}

/** The line an agent puts in its reply to show a task as a card. */
function directive(id: string): string {
  return `::task{id="${id}"}`;
}

export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const store = new TaskStore(db);

  const settings = bb.settings.define({
    archiveThreadsOnDone: {
      type: "boolean",
      label: "Archive threads when a task is done",
      description: "When you move a task to Done, archive the threads it was handed to.",
      default: false,
    },
  });

  const studio = studioSchemas(z);
  const studioNotifier = createStudioNotifier({ plugins: bb.sdk.plugins, pluginId: PLUGIN_ID, schemas: studio });

  /** Tells open boards, task views and Studio that a task changed. */
  function changed(id: string) {
    try {
      bb.realtime.publish(REALTIME_CHANNEL, { type: TASK_UPDATE_TYPE, taskId: id });
    } catch {
      // publishing is best-effort
    }
    studioNotifier.changed();
  }

  function mustGet(id: string): TaskRow {
    const task = store.get(id);
    if (!task) throw new Error(`Task ${id} not found.`);
    return task;
  }

  function toDto(task: TaskRow): TaskDto {
    const handoffs = store.handoffs(task.id);
    return {
      id: task.id,
      title: task.title,
      description: task.description,
      status: task.status,
      projectId: task.project_id,
      due: task.due,
      assignee: task.assignee,
      createdAt: task.created_at,
      updatedAt: task.updated_at,
      updatedBy: task.updated_by,
      doneAt: task.done_at,
      archived: task.archived_at !== null,
      handoff: handoffs[0] ? toHandoffDto(handoffs[0]) : null,
      openThreads: handoffs.filter((handoff) => isOpenHandoff(handoff.state)).length,
      links: store.links(task.id).length,
    };
  }

  // -------------------------------------------------------------------
  // Handoffs: thread events move the handoff, and its task
  // -------------------------------------------------------------------

  function apply(threadId: string, signal: ThreadSignal) {
    const handoff = store.handoff(threadId);
    if (!handoff) return;
    const task = store.get(handoff.task_id);
    if (!task) return;
    const latest = store.latestHandoff(task.id)?.thread_id === threadId;
    const next = nextHandoff(handoff, task, latest, signal);
    if (!next) return;
    store.setHandoff(threadId, next.state, next.note);
    if (next.status) store.move(task.id, next.status, "agent");
    changed(task.id);
  }

  /** Thread links follow the thread's title. */
  function relabel(thread: { id: string; title: string | null; titleFallback: string | null }) {
    const label = thread.title ?? thread.titleFallback;
    if (!label) return;
    for (const taskId of store.relabelThread(thread.id, label)) changed(taskId);
  }

  async function hasPendingInput(threadId: string): Promise<boolean> {
    const interactions = await bb.sdk.threads.interactions.list({ threadId });
    return interactions.some((interaction) => interaction.status === "pending");
  }

  // BB drops these listeners when the plugin unloads.
  bb.events.on("thread.active", ({ thread }) => {
    relabel(thread);
    apply(thread.id, { type: "active" });
  });
  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => {
    relabel(thread);
    apply(thread.id, { type: "idle", text: lastAssistantText });
  });
  bb.events.on("thread.failed", ({ thread, error }) => apply(thread.id, { type: "failed", error }));
  bb.events.on("thread.archived", ({ thread }) => apply(thread.id, { type: "archived" }));
  bb.events.on("thread.unarchived", ({ thread }) => apply(thread.id, { type: "unarchived" }));
  bb.events.on("thread.deleted", ({ thread }) => apply(thread.id, { type: "deleted" }));
  bb.events.on("interaction.pending", ({ thread }) => apply(thread.id, { type: "needs-input" }));
  // BB has no event for an answered question, so watch the thread while
  // it's waiting on one.
  bb.events.on("experimental_thread.events", async ({ thread }) => {
    if (store.handoff(thread.id)?.state !== "needs-input") return;
    try {
      if (!(await hasPendingInput(thread.id))) apply(thread.id, { type: "input-resolved" });
    } catch (error) {
      bb.log.warn(`couldn't check ${thread.id} for pending input: ${String(error)}`);
    }
  });

  /**
   * Moves a handoff to its thread's current state, for events it missed. A
   * thread just spawned may read idle before its first turn starts, so `fresh`
   * doesn't count idle as finished.
   */
  async function catchUp(handoff: { thread_id: string; state: string }, fresh = false) {
    try {
      const thread = await bb.sdk.threads.get({ threadId: handoff.thread_id });
      if (thread.deletedAt !== null) apply(thread.id, { type: "deleted" });
      else if (thread.archivedAt !== null) apply(thread.id, { type: "archived" });
      else if (thread.status === "error") apply(thread.id, { type: "failed", error: null });
      else if (thread.status === "active" || thread.status === "starting" || thread.status === "pending") {
        apply(thread.id, { type: "active" });
        if (await hasPendingInput(thread.id)) apply(thread.id, { type: "needs-input" });
      } else if (!fresh && thread.status === "idle" && (handoff.state === "working" || handoff.state === "needs-input" || handoff.state === "starting")) {
        apply(thread.id, { type: "idle", text: null });
      }
      relabel(thread);
    } catch (error) {
      if (/not found|404/i.test(String(error))) apply(handoff.thread_id, { type: "deleted" });
      else bb.log.warn(`couldn't reconcile handoff ${handoff.thread_id}: ${String(error)}`);
    }
  }

  /** Events aren't replayed while the plugin is off: catch up on every open handoff. */
  async function reconcile() {
    for (const handoff of store.openHandoffs()) await catchUp(handoff);
  }
  void reconcile();

  async function agentLabel(providerId: string, model: string | null): Promise<string> {
    let name = providerId;
    try {
      name = (await bb.sdk.providers.list()).find((provider) => provider.id === providerId)?.displayName ?? providerId;
    } catch {
      // the id will do
    }
    return model ? `${name} · ${model}` : name;
  }

  async function handOff(input: {
    id: string;
    projectId: string | null;
    providerId?: string | null;
    model?: string | null;
    reasoningLevel?: string | null;
    note?: string | null;
    workspace: "worktree" | "folder";
    by: Writer;
  }): Promise<{ threadId: string }> {
    let task = mustGet(input.id);
    const projectId = input.projectId ?? task.project_id;
    if (!projectId) throw new Error("Pick a project for the agent to work in.");
    if (task.project_id !== projectId) task = store.update(task.id, { projectId }, input.by);
    const thread = await bb.sdk.threads.spawn({
      projectId,
      input: [handoffInput(task, store.links(task.id), input.note ?? null)],
      ...(input.providerId ? { providerId: input.providerId } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.reasoningLevel ? { reasoningLevel: input.reasoningLevel as never } : {}),
      ...(task.title ? { title: task.title } : {}),
      environment: {
        type: "host",
        workspace: input.workspace === "worktree" ? { type: "managed-worktree", baseBranch: { kind: "default" } } : { type: "unmanaged", path: null },
      },
      pluginMetadata: { taskId: task.id },
    });
    store.addHandoff(task.id, thread.id, await agentLabel(thread.providerId, input.model ?? null));
    // The thread may have started, or failed, before the handoff was recorded.
    const recorded = store.handoff(thread.id);
    if (recorded) void catchUp(recorded, true);
    store.link(task.id, { target: "thread", plugin_id: null, item_id: thread.id, label: thread.title ?? (task.title || "Thread"), href: `/threads/${thread.id}` });
    if (task.status !== "in_progress") store.move(task.id, "in_progress", input.by);
    store.update(task.id, { assignee: "agent" }, input.by);
    changed(task.id);
    return { threadId: thread.id };
  }

  async function archiveThreads(id: string): Promise<{ archived: number; failed: number }> {
    let archived = 0;
    let failed = 0;
    for (const handoff of store.handoffs(id).filter((each) => isOpenHandoff(each.state))) {
      try {
        await bb.sdk.threads.archive({ threadId: handoff.thread_id });
        store.setHandoff(handoff.thread_id, "archived", handoff.note);
        archived += 1;
      } catch (error) {
        bb.log.warn(`couldn't archive ${handoff.thread_id}: ${String(error)}`);
        failed += 1;
      }
    }
    if (archived) changed(id);
    return { archived, failed };
  }

  /** Moves a task, and archives its threads when it's done and the setting is on. */
  async function move(id: string, status: TaskStatus, by: Writer, index?: number): Promise<{ archivedThreads: number }> {
    const before = mustGet(id);
    store.move(id, status, by, index);
    changed(id);
    if (status !== "done" || before.status === "done" || !(await settings.get()).archiveThreadsOnDone) return { archivedThreads: 0 };
    return { archivedThreads: (await archiveThreads(id)).archived };
  }

  /** The task a thread is working on: from its handoff. */
  function threadTask(threadId: string): TaskRow | null {
    const handoff = store.handoff(threadId);
    return handoff ? store.get(handoff.task_id) : null;
  }

  function taskLine(task: TaskRow): string {
    const handoff = store.latestHandoff(task.id);
    const parts = [STATUS_LABELS[task.status], assigneeLabel(task)];
    if (task.due) parts.push(`due ${formatDue(task.due)} (${task.due})`);
    if (handoff) parts.push(HANDOFF_LABELS[handoff.state]);
    return `${task.title || "Untitled"} (id ${task.id}): ${parts.join(", ")}. Link ${taskHref(task.id)}`;
  }

  function taskDetails(task: TaskRow): string {
    const lines = [taskLine(task)];
    if (task.description) lines.push(`\n${task.description}`);
    const links = store.links(task.id);
    if (links.length) lines.push(`\nLinked:\n${links.map((link) => `- ${link.label} (${link.target === "thread" ? "thread" : link.plugin_id}${link.href ? `, ${link.href}` : ""})`).join("\n")}`);
    const handoffs = store.handoffs(task.id);
    if (handoffs.length) {
      lines.push(
        `\nHanded to:\n${handoffs
          .map((handoff) => `- thread ${handoff.thread_id}${handoff.agent ? ` (${handoff.agent})` : ""}: ${HANDOFF_LABELS[handoff.state]}${handoff.note ? `. ${handoff.note}` : ""}`)
          .join("\n")}`,
      );
    }
    return lines.join("\n");
  }

  bb.log.info("loaded");

  bb.rpc.register(rpcContract, {
    board({ includeArchived }) {
      return { tasks: store.list({ includeArchived }).map(toDto) };
    },
    get({ id }) {
      const task = store.get(id);
      if (!task) return { task: null, links: [], handoffs: [] };
      return { task: toDto(task), links: store.links(id).map(toLinkDto), handoffs: store.handoffs(id).map(toHandoffDto) };
    },
    create({ title, description, status, projectId, due, assignee }) {
      const task = store.create({ title, description, status, projectId, due, assignee, by: "user" });
      changed(task.id);
      return { task: toDto(task) };
    },
    update({ id, ...patch }) {
      store.update(id, patch, "user");
      changed(id);
      return { ok: true };
    },
    async move({ id, status, index }) {
      const { archivedThreads } = await move(id, status, "user", index);
      return { ok: true, archivedThreads };
    },
    archive({ id, archived }) {
      store.setArchived(id, archived);
      changed(id);
      return { ok: true };
    },
    delete({ id }) {
      if (store.delete(id)) changed(id);
      return { ok: true };
    },
    link({ id, link }) {
      store.link(id, { target: link.target, plugin_id: link.pluginId, item_id: link.itemId, label: link.label, href: link.href });
      changed(id);
      return { ok: true };
    },
    unlink({ id, target, itemId }) {
      if (store.unlink(id, target, itemId)) changed(id);
      return { ok: true };
    },
    async linkables({ projectId }) {
      const errors: string[] = [];
      const lists = await Promise.all(
        LINKABLE_PLUGINS.map(async (pluginId) => {
          try {
            const [{ items }, info] = await Promise.all([
              bb.sdk.plugins.callRpc({ pluginId, method: "studio_list", input: null as never, outputSchema: studio.provider.studio_list.output }),
              bb.sdk.plugins.callRpc({ pluginId, method: "studio_describe", input: null as never, outputSchema: studio.info }),
            ]);
            return items
              .filter((item) => !item.archived)
              .map((item) => {
                const kind = info.kinds.find((each) => each.id === item.kind);
                return {
                  target: "item" as const,
                  pluginId,
                  itemId: item.id,
                  label: item.title || "Untitled",
                  href: item.href,
                  kind: kind?.label ?? item.kind,
                  icon: item.icon ?? kind?.icon ?? null,
                  updatedAt: item.updatedAt,
                };
              });
          } catch (error) {
            // Not installed, or not a Studio add-on yet.
            if (!/not found|not installed|no rpc|unknown plugin|404/i.test(String(error))) errors.push(`${pluginId}: ${String(error)}`);
            return [];
          }
        }),
      );
      let threads: z.infer<typeof linkableSchema>[] = [];
      try {
        threads = (await bb.sdk.threads.list({ ...(projectId ? { projectId } : {}), limit: 50 })).map((thread) => ({
          target: "thread" as const,
          pluginId: null,
          itemId: thread.id,
          label: thread.title ?? thread.titleFallback ?? "Untitled thread",
          href: `/threads/${thread.id}`,
          kind: "Thread",
          icon: "MessageSquare",
        }));
      } catch (error) {
        errors.push(`threads: ${String(error)}`);
      }
      const items = lists
        .flat()
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 300)
        .map(({ updatedAt: _, ...item }) => item);
      return { items: [...items, ...threads], errors };
    },
    async handoffDefaults({ projectId }) {
      const defaults = await bb.sdk.projects.defaultExecutionOptions({ projectId });
      return { providerId: defaults?.providerId ?? null, model: defaults?.model ?? null, reasoningLevel: defaults?.reasoningLevel ?? null };
    },
    handOff(input) {
      return handOff({ ...input, by: "user" });
    },
    async sendBack({ id, message }) {
      const handoff = store.latestHandoff(id);
      if (!handoff || !isOpenHandoff(handoff.state)) throw new Error("This task has no thread to send to. Hand it off again.");
      await bb.sdk.threads.send({ threadId: handoff.thread_id, input: [{ type: "text", text: message, mentions: [] }], mode: "auto" });
      const task = mustGet(id);
      if (task.status !== "in_progress") store.move(id, "in_progress", "user");
      changed(id);
      return { threadId: handoff.thread_id };
    },
    archiveThreads({ id }) {
      mustGet(id);
      return archiveThreads(id);
    },
    async settings() {
      return { archiveThreadsOnDone: (await settings.get()).archiveThreadsOnDone };
    },
  });

  registerStudio(bb, studio, {
    store,
    changed,
    move: (id, status) => move(id, status, "user").then(() => undefined),
  });

  // ---------------------------------------------------------------------
  // Agent tools
  // ---------------------------------------------------------------------

  const linkInput = z.object({
    pluginId: z.string().min(1).max(100).describe('The Studio add-on: "pages", "artifacts", "talk" or "excalidraw".'),
    itemId: z.string().min(1).max(200),
    label: z.string().min(1).max(200),
  });

  bb.agents.registerTool({
    name: "tasks_list",
    description:
      "List tasks on the user's Studio Tasks board: id, title, status (To do, In progress, Review, Done), assignee, due date, and the handed-off thread's state.",
    parameters: z.object({ status: statusSchema.optional(), query: z.string().max(200).optional() }),
    execute({ status, query }) {
      const needle = query?.trim().toLowerCase();
      const rows = store
        .list()
        .filter((task) => !status || task.status === status)
        .filter((task) => !needle || `${task.title} ${task.description}`.toLowerCase().includes(needle))
        .sort((a, b) => STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status) || a.rank - b.rank)
        .slice(0, 100);
      return rows.length ? rows.map((task) => `- ${taskLine(task)}`).join("\n") : "No tasks match.";
    },
  });

  bb.agents.registerTool({
    name: "tasks_get",
    description: "Read a task: its description, links, and the threads it was handed to. Without an id, reads the task this thread is working on.",
    parameters: z.object({ id: idSchema.optional() }),
    execute({ id }, context) {
      const task = id ? store.get(id) : threadTask(context.threadId);
      if (!task) return { content: [{ type: "text", text: id ? `Task ${id} not found.` : "This thread isn't working on a task. Pass an id." }], isError: true };
      return taskDetails(task);
    },
  });

  bb.agents.registerTool({
    name: "tasks_create",
    description:
      "Add a task to the user's Studio Tasks board, in To do unless you pass a status. Use it when the user asks you to track something, " +
      "not for your own step-by-step plan. The result includes a line to put in your reply so the task shows as a card.",
    parameters: z.object({
      title: z.string().trim().min(1).max(300),
      description: z.string().max(20_000).optional(),
      status: z.enum(["todo", "in_progress", "review"]).optional(),
      due: z.string().optional().describe("A day, like 2026-10-01."),
      assignee: z.enum(["me", "agent"]).optional().describe('"me" is the user.'),
    }),
    execute({ title, description, status, due: rawDue, assignee }, context) {
      const due = rawDue?.trim() || undefined;
      if (due && !isDay(due)) return { content: [{ type: "text", text: "Give `due` as a day, like 2026-10-01." }], isError: true };
      const task = store.create({ title, description, status, due: due ?? null, assignee: assignee ?? null, projectId: context.projectId ?? null, by: "agent" });
      changed(task.id);
      return `Added ${taskLine(task)}\n\nTo show it in your reply, put this on its own line:\n${directive(task.id)}`;
    },
  });

  bb.agents.registerTool({
    name: "tasks_update",
    description:
      "Update a task. Without an id, updates the task this thread was handed. When the work is ready for the user to review, " +
      'set status "review" with a one-line `note` saying what you did. Link what you made for it with `addLinks` ' +
      "(Studio items, e.g. an artifact's id with pluginId \"artifacts\"). Only the user marks a task done.",
    parameters: z.object({
      id: idSchema.optional(),
      status: z.enum(["todo", "in_progress", "review"]).optional(),
      note: z.string().max(2000).optional(),
      title: z.string().trim().min(1).max(300).optional(),
      description: z.string().max(20_000).optional(),
      due: z.string().nullable().optional(),
      addLinks: z.array(linkInput).max(20).optional(),
    }),
    async execute({ id, status, note, title, description, due: rawDue, addLinks }, context) {
      // An empty day clears the due date.
      const due = rawDue === undefined ? undefined : rawDue?.trim() || null;
      const task = id ? store.get(id) : threadTask(context.threadId);
      if (!task) return { content: [{ type: "text", text: id ? `Task ${id} not found.` : "This thread isn't working on a task. Pass an id." }], isError: true };
      if (due && !isDay(due)) return { content: [{ type: "text", text: "Give `due` as a day, like 2026-10-01." }], isError: true };
      if (title !== undefined || description !== undefined || due !== undefined) store.update(task.id, { title, description, due }, "agent");
      for (const link of addLinks ?? []) {
        store.link(task.id, { target: "item", plugin_id: link.pluginId, item_id: link.itemId, label: link.label, href: studioHref(link.pluginId, link.itemId) });
      }
      const handoff = store.handoff(context.threadId);
      const own = handoff?.task_id === task.id;
      if (status === "review" && own) apply(context.threadId, { type: "ready", note: note ?? null });
      else if (status && status !== task.status) await move(task.id, status, "agent");
      else if (note && own) store.setHandoff(context.threadId, handoff.state, firstLine(note));
      changed(task.id);
      return `Updated ${taskLine(mustGet(task.id))}`;
    },
  });

  bb.agents.configure(() => ({ tools: ["tasks_list", "tasks_get", "tasks_create", "tasks_update"], skills: [] }));

  // `@task` in any composer.
  bb.ui.registerMentionProvider({
    id: "task",
    label: "Tasks",
    search({ query }) {
      const needle = query.trim().toLowerCase();
      return store
        .list()
        .filter((task) => task.status !== "done")
        .filter((task) => !needle || task.title.toLowerCase().includes(needle))
        .slice(0, 50)
        .map((task) => ({ id: task.id, title: task.title || "Untitled", subtitle: `${STATUS_LABELS[task.status]} · ${assigneeLabel(task)}` }));
    },
    resolve(itemId) {
      const task = mustGet(itemId);
      const handoff = store.latestHandoff(task.id);
      return {
        context: mentionContext({
          id: task.id,
          title: task.title,
          description: task.description,
          status: task.status,
          due: task.due,
          assignee: task.assignee,
          handoff: handoff ? { state: handoff.state, note: handoff.note } : null,
          links: store.links(task.id).map((link) => link.label),
        }),
      };
    },
  });

  // CLI: `bb studio-tasks …`
  const usage = {
    list: "bb studio-tasks list [--status todo|in_progress|review|done]",
    add: "bb studio-tasks add <title> [--description <text>] [--due <YYYY-MM-DD>] [--me]",
    show: "bb studio-tasks show <id>",
    move: "bb studio-tasks move <id> <todo|in_progress|review|done>",
    hand: "bb studio-tasks hand <id> [--note <text>] [--folder]",
    done: "bb studio-tasks done <id>",
  };
  bb.cli.register({
    name: "studio-tasks",
    summary: "Studio Tasks: a board of tasks you can hand to agents",
    commands: [
      { name: "list", summary: "List tasks", usage: usage.list },
      { name: "add", summary: "Add a task to To do", usage: usage.add },
      { name: "show", summary: "Show a task, its links and handoffs", usage: usage.show },
      { name: "move", summary: "Move a task to another column", usage: usage.move },
      { name: "hand", summary: "Hand a task to an agent in a new thread, with the project's default agent", usage: usage.hand },
      { name: "done", summary: "Mark a task done", usage: usage.done },
    ],
    async run(argv, ctx) {
      const [cmd, ...rest] = argv;
      const flags = parseFlags(rest, ["me", "folder"]);
      const fail = (message: string) => ({ exitCode: 1, stderr: `${message}\n` });
      try {
        switch (cmd) {
          case "list": {
            const status = flags.values.status;
            if (status !== undefined && !isStatus(status)) return fail(`usage: ${usage.list}`);
            const rows = store.list().filter((task) => !status || task.status === status);
            if (!rows.length) return { exitCode: 0, stdout: "No tasks.\n" };
            const lines = rows
              .sort((a, b) => STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status) || a.rank - b.rank)
              .map((task) => {
                const handoff = store.latestHandoff(task.id);
                return [task.id, STATUS_LABELS[task.status], task.title || "Untitled", task.due ?? "", handoff ? HANDOFF_LABELS[handoff.state] : ""].join("\t");
              });
            return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
          }
          case "add": {
            const title = flags.positional.join(" ").trim();
            const due = flags.values.due || null;
            if (!title) return fail(`usage: ${usage.add}`);
            if (due && !isDay(due)) return fail("Give --due as a day, like 2026-10-01.");
            const task = store.create({
              title,
              description: flags.values.description,
              due,
              assignee: flags.values.me !== undefined ? "me" : null,
              projectId: ctx.projectId ?? null,
              by: "agent",
            });
            changed(task.id);
            return { exitCode: 0, stdout: `${task.id}\n` };
          }
          case "show": {
            const task = store.get(flags.positional[0] ?? "");
            if (!task) return fail(`usage: ${usage.show}`);
            return { exitCode: 0, stdout: `${taskDetails(task)}\n` };
          }
          case "move":
          case "done": {
            const [id, target] = flags.positional;
            const status = cmd === "done" ? "done" : target;
            if (!id || !store.get(id) || !isStatus(status)) return fail(`usage: ${usage[cmd]}`);
            const { archivedThreads } = await move(id, status, "agent");
            return { exitCode: 0, stdout: `${id}\t${STATUS_LABELS[status]}${archivedThreads ? `\tarchived ${archivedThreads} thread(s)` : ""}\n` };
          }
          case "hand": {
            const id = flags.positional[0];
            if (!id || !store.get(id)) return fail(`usage: ${usage.hand}`);
            const { threadId } = await handOff({ id, projectId: store.get(id)!.project_id ?? ctx.projectId ?? null, note: flags.values.note || null, workspace: flags.values.folder !== undefined ? "folder" : "worktree", by: "agent" });
            return { exitCode: 0, stdout: `${threadId}\n` };
          }
          default:
            return fail("unknown command — try: list | add <title> | show <id> | move <id> <status> | hand <id> | done <id>");
        }
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  });

  bb.onDispose(() => {
    studioNotifier.dispose();
    bb.log.info("disposed");
  });
}

/** `--name value` flags and positional arguments. A flag with no value is "". */
/** `booleans` name the flags that take no value, so the word after them stays positional. */
export function parseFlags(
  argv: readonly string[],
  booleans: readonly string[] = [],
): { positional: string[]; values: Record<string, string | undefined> } {
  const positional: string[] = [];
  const values: Record<string, string | undefined> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg.startsWith("--")) {
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("--") && !booleans.includes(arg.slice(2))) {
        values[arg.slice(2)] = next;
        index += 1;
      } else {
        values[arg.slice(2)] = "";
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, values };
}
