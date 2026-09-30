// Tasks in the plugin's SQLite database: the tasks, what they link to, and
// the threads they were handed to.
import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { DEFAULT_COLUMNS, STATUSES, isStatus, type TaskColumn, type Assignee, type HandoffState, type TaskStatus } from "../shared";

/**
 * Append-only: statement index is the migration id, and BB checks each
 * statement against the hash it recorded, so never edit one (not even its
 * whitespace).
 */
export const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS tasks (
       id TEXT PRIMARY KEY,
       title TEXT NOT NULL,
       description TEXT NOT NULL DEFAULT '',
       status TEXT NOT NULL,
       rank REAL NOT NULL,
       project_id TEXT,
       due TEXT,
       assignee TEXT,
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL,
       updated_by TEXT,
       done_at INTEGER,
       archived_at INTEGER
     );
   CREATE INDEX IF NOT EXISTS tasks_board ON tasks (status, rank);
   CREATE TABLE IF NOT EXISTS task_links (
       task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
       target TEXT NOT NULL,
       plugin_id TEXT,
       item_id TEXT NOT NULL,
       label TEXT NOT NULL,
       href TEXT,
       created_at INTEGER NOT NULL,
       PRIMARY KEY (task_id, target, item_id)
     );
   CREATE TABLE IF NOT EXISTS task_handoffs (
       thread_id TEXT PRIMARY KEY,
       task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
       state TEXT NOT NULL,
       note TEXT,
       agent TEXT,
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL
     );
   CREATE INDEX IF NOT EXISTS task_handoffs_task ON task_handoffs (task_id, created_at);`,
  `CREATE TABLE task_board_config (id INTEGER PRIMARY KEY CHECK (id = 1), columns_json TEXT NOT NULL, revision INTEGER NOT NULL);`,
];

export type TaskRow = {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  rank: number;
  project_id: string | null;
  /** A day, "2026-10-01". */
  due: string | null;
  assignee: Assignee;
  created_at: number;
  updated_at: number;
  /** "user" or "agent". */
  updated_by: string | null;
  done_at: number | null;
  archived_at: number | null;
};

/** A link to a thread, or to another Studio item (a page, an artifact…). */
export type LinkRow = {
  task_id: string;
  target: "thread" | "item";
  /** The Studio add-on for an item; null for a thread. */
  plugin_id: string | null;
  item_id: string;
  label: string;
  href: string | null;
  created_at: number;
};

export type HandoffRow = {
  thread_id: string;
  task_id: string;
  state: HandoffState;
  /** The last reply's first line, the agent's own note, or the error. */
  note: string | null;
  /** "Claude · Opus 5.5", for the handoff list. */
  agent: string | null;
  created_at: number;
  updated_at: number;
};

/** The CLI counts as an agent: agents are its main users. */
export type Writer = "user" | "agent";

export interface NewTask {
  title: string;
  description?: string;
  status?: TaskStatus;
  projectId?: string | null;
  due?: string | null;
  assignee?: Assignee;
  by: Writer;
}

export interface TaskPatch {
  title?: string;
  description?: string;
  projectId?: string | null;
  due?: string | null;
  assignee?: Assignee;
}

/** Ranks closer than this are spread out again. */
const MIN_GAP = 1e-6;

export function newTaskId(): string {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  return `tsk_${[...randomBytes(16)].map((byte) => alphabet[byte % 36]).join("")}`;
}

export class TaskStore {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number = Date.now,
  ) {
    db.pragma("foreign_keys = ON");
  }

  boardConfig(): { columns: TaskColumn[]; revision: number } {
    const row = this.db.prepare("SELECT columns_json, revision FROM task_board_config WHERE id = 1").get() as
      { columns_json: string; revision: number } | undefined;
    return row ? { columns: JSON.parse(row.columns_json), revision: row.revision } :
      { columns: DEFAULT_COLUMNS.map((column) => ({ ...column })), revision: 0 };
  }

  statusLabel(status: TaskStatus): string {
    return this.boardConfig().columns.find((column) => column.id === status)?.label ?? status;
  }

  statusOrder(status: TaskStatus): number {
    return this.boardConfig().columns.findIndex((column) => column.id === status);
  }

  hasStatus(status: unknown): status is TaskStatus {
    return this.boardConfig().columns.some((column) => column.id === status);
  }

  /** Save atomically; never orphan tasks or overwrite another open editor. */
  saveColumns(columns: TaskColumn[], revision: number): void {
    this.db.transaction(() => {
      const current = this.boardConfig();
      if (current.revision !== revision) throw new Error("Columns changed elsewhere. Close this editor and try again.");
      if (columns.length < 4 || columns.length > 20 || new Set(columns.map((column) => column.id)).size !== columns.length ||
          columns.some((column) => !isStatus(column.id) || !column.label.trim() || column.label.trim().length > 60) ||
          STATUSES.some((id) => !columns.some((column) => column.id === id))) {
        throw new Error("Keep the four workflow columns, use unique column IDs, and names of 1 to 60 characters (20 columns maximum).");
      }
      const labels = columns.map((column) => column.label.trim().toLowerCase());
      if (new Set(labels).size !== labels.length) throw new Error("Use a different name for each column.");
      for (const column of current.columns) {
        if (!columns.some((next) => next.id === column.id) &&
            this.db.prepare("SELECT 1 FROM tasks WHERE status = ? LIMIT 1").get(column.id)) {
          throw new Error(`Move all tasks out of "${column.label}" before removing it, including archived tasks.`);
        }
      }
      this.db.prepare(`INSERT INTO task_board_config (id, columns_json, revision) VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET columns_json = excluded.columns_json, revision = excluded.revision`)
        .run(JSON.stringify(columns.map((column) => ({ id: column.id, label: column.label.trim() }))), revision + 1);
    })();
  }

  private requireStatus(status: TaskStatus): void {
    if (!this.hasStatus(status)) throw new Error("Column not found. Refresh the board and try again.");
  }

  get(id: string): TaskRow | null {
    return (this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined) ?? null;
  }

  /** Board order: by status, then rank. */
  list(options: { includeArchived?: boolean } = {}): TaskRow[] {
    return this.db
      .prepare(`SELECT * FROM tasks ${options.includeArchived ? "" : "WHERE archived_at IS NULL"} ORDER BY rank, created_at`)
      .all() as TaskRow[];
  }

  /** New tasks go to the top of their column. */
  create(input: NewTask): TaskRow {
    const at = this.now();
    const status = input.status ?? "todo";
    this.requireStatus(status);
    const task: TaskRow = {
      id: newTaskId(),
      title: input.title.trim(),
      description: input.description?.trim() ?? "",
      status,
      rank: this.edgeRank(status, "top"),
      project_id: input.projectId ?? null,
      due: input.due ?? null,
      assignee: input.assignee ?? null,
      created_at: at,
      updated_at: at,
      updated_by: input.by,
      done_at: status === "done" ? at : null,
      archived_at: null,
    };
    this.db
      .prepare(
        `INSERT INTO tasks (id, title, description, status, rank, project_id, due, assignee, created_at, updated_at, updated_by, done_at, archived_at)
         VALUES (@id, @title, @description, @status, @rank, @project_id, @due, @assignee, @created_at, @updated_at, @updated_by, @done_at, @archived_at)`,
      )
      .run(task);
    return task;
  }

  update(id: string, patch: TaskPatch, by: Writer): TaskRow {
    const task = this.mustGet(id);
    const next = {
      title: patch.title !== undefined ? patch.title.trim() : task.title,
      description: patch.description !== undefined ? patch.description.trim() : task.description,
      project_id: patch.projectId !== undefined ? patch.projectId : task.project_id,
      due: patch.due !== undefined ? patch.due : task.due,
      assignee: patch.assignee !== undefined ? patch.assignee : task.assignee,
    };
    this.db
      .prepare(
        `UPDATE tasks SET title = @title, description = @description, project_id = @project_id, due = @due,
           assignee = @assignee, updated_at = @at, updated_by = @by WHERE id = @id`,
      )
      .run({ ...next, id, at: this.now(), by });
    return this.mustGet(id);
  }

  /**
   * Puts a task in a column. With `index`, at that position among the
   * column's other tasks (0 is the top); without, at the top, or where it is
   * when the status doesn't change.
   */
  move(id: string, status: TaskStatus, by: Writer, index?: number): TaskRow {
    this.requireStatus(status);
    const task = this.mustGet(id);
    return this.db.transaction(() => {
      let rank = task.rank;
      if (index !== undefined) rank = this.rankAt(status, index, id);
      else if (status !== task.status) rank = this.edgeRank(status, "top");
      const doneAt = status === "done" ? (task.status === "done" ? task.done_at : this.now()) : null;
      this.db
        .prepare("UPDATE tasks SET status = ?, rank = ?, done_at = ?, updated_at = ?, updated_by = ? WHERE id = ?")
        .run(status, rank, doneAt, this.now(), by, id);
      return this.mustGet(id);
    })();
  }

  setArchived(id: string, archived: boolean): void {
    this.mustGet(id);
    this.db.prepare("UPDATE tasks SET archived_at = ?, updated_at = ? WHERE id = ?").run(archived ? this.now() : null, this.now(), id);
  }

  delete(id: string): boolean {
    return this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id).changes > 0;
  }

  // Links -------------------------------------------------------------

  links(taskId: string): LinkRow[] {
    return this.db.prepare("SELECT * FROM task_links WHERE task_id = ? ORDER BY created_at").all(taskId) as LinkRow[];
  }

  /** Adds a link, or relabels it when it's already there. */
  link(taskId: string, link: Omit<LinkRow, "task_id" | "created_at">): void {
    this.mustGet(taskId);
    this.db
      .prepare(
        `INSERT INTO task_links (task_id, target, plugin_id, item_id, label, href, created_at)
         VALUES (@task_id, @target, @plugin_id, @item_id, @label, @href, @created_at)
         ON CONFLICT (task_id, target, item_id) DO UPDATE SET label = excluded.label, href = excluded.href`,
      )
      .run({ ...link, task_id: taskId, created_at: this.now() });
  }

  unlink(taskId: string, target: LinkRow["target"], itemId: string): boolean {
    return this.db.prepare("DELETE FROM task_links WHERE task_id = ? AND target = ? AND item_id = ?").run(taskId, target, itemId).changes > 0;
  }

  /** Keeps a thread link's label in step with the thread's title. Returns the tasks it changed. */
  relabelThread(threadId: string, label: string): string[] {
    const rows = this.db
      .prepare("SELECT task_id FROM task_links WHERE target = 'thread' AND item_id = ? AND label != ?")
      .all(threadId, label) as { task_id: string }[];
    if (rows.length) this.db.prepare("UPDATE task_links SET label = ? WHERE target = 'thread' AND item_id = ?").run(label, threadId);
    return rows.map((row) => row.task_id);
  }

  // Handoffs ------------------------------------------------------------

  handoffs(taskId: string): HandoffRow[] {
    return this.db.prepare("SELECT * FROM task_handoffs WHERE task_id = ? ORDER BY created_at DESC, rowid DESC").all(taskId) as HandoffRow[];
  }

  handoff(threadId: string): HandoffRow | null {
    return (this.db.prepare("SELECT * FROM task_handoffs WHERE thread_id = ?").get(threadId) as HandoffRow | undefined) ?? null;
  }

  latestHandoff(taskId: string): HandoffRow | null {
    return this.handoffs(taskId)[0] ?? null;
  }

  /** Every handoff whose thread may still change: for reconciling after a restart. */
  openHandoffs(): HandoffRow[] {
    return this.db.prepare("SELECT * FROM task_handoffs WHERE state NOT IN ('archived', 'deleted')").all() as HandoffRow[];
  }

  addHandoff(taskId: string, threadId: string, agent: string | null): HandoffRow {
    this.mustGet(taskId);
    const at = this.now();
    this.db
      .prepare(
        `INSERT INTO task_handoffs (thread_id, task_id, state, note, agent, created_at, updated_at)
         VALUES (?, ?, 'starting', NULL, ?, ?, ?)`,
      )
      .run(threadId, taskId, agent, at, at);
    return this.handoff(threadId)!;
  }

  setHandoff(threadId: string, state: HandoffState, note: string | null): void {
    this.db.prepare("UPDATE task_handoffs SET state = ?, note = ?, updated_at = ? WHERE thread_id = ?").run(state, note, this.now(), threadId);
  }

  // Ranks ---------------------------------------------------------------

  private mustGet(id: string): TaskRow {
    const task = this.get(id);
    if (!task) throw new Error(`Task ${id} not found.`);
    return task;
  }

  private column(status: TaskStatus, except?: string): { id: string; rank: number }[] {
    return this.db
      .prepare("SELECT id, rank FROM tasks WHERE status = ? AND id != ? AND archived_at IS NULL ORDER BY rank, created_at")
      .all(status, except ?? "") as { id: string; rank: number }[];
  }

  private edgeRank(status: TaskStatus, edge: "top" | "bottom"): number {
    const column = this.column(status);
    if (!column.length) return 0;
    return edge === "top" ? column[0]!.rank - 1 : column[column.length - 1]!.rank + 1;
  }

  /** The rank that puts a task at `index` among the column's other tasks. */
  private rankAt(status: TaskStatus, index: number, except: string): number {
    let column = this.column(status, except);
    const at = Math.max(0, Math.min(index, column.length));
    const between = () => {
      const before = column[at - 1];
      const after = column[at];
      if (!before && !after) return 0;
      if (!before) return after!.rank - 1;
      if (!after) return before.rank + 1;
      return after.rank - before.rank < MIN_GAP ? null : (before.rank + after.rank) / 2;
    };
    const rank = between();
    if (rank !== null) return rank;
    // Too close to split: spread the column out and try again.
    const spread = this.db.prepare("UPDATE tasks SET rank = ? WHERE id = ?");
    column.forEach((row, position) => spread.run(position, row.id));
    column = this.column(status, except);
    return between()!;
  }
}
