import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";

// SQLite persistence. A page's content is its Yjs state (`state`); `markdown`
// is a derived cache for search, mentions and previews, refreshed on save.
// MIGRATIONS is append-only: BB records each statement's hash by index.

export const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS pages (
     id TEXT PRIMARY KEY,
     project_id TEXT,
     parent_id TEXT,
     title TEXT NOT NULL DEFAULT '',
     icon TEXT NOT NULL DEFAULT '',
     position REAL NOT NULL DEFAULT 0,
     state BLOB,
     markdown TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     updated_by TEXT NOT NULL DEFAULT '',
     archived_at INTEGER,
     refresh_bot_id TEXT,
     refresh_cron TEXT,
     refresh_instructions TEXT NOT NULL DEFAULT '',
     refresh_last_at INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS pages_parent ON pages (project_id, parent_id, position)`,
  `CREATE TABLE IF NOT EXISTS snapshots (
     id TEXT PRIMARY KEY,
     page_id TEXT NOT NULL,
     state BLOB NOT NULL,
     label TEXT NOT NULL,
     actor TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS snapshots_page ON snapshots (page_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS files (
     id TEXT PRIMARY KEY,
     page_id TEXT NOT NULL,
     name TEXT NOT NULL,
     mime TEXT NOT NULL,
     size INTEGER NOT NULL,
     data BLOB NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS requests (
     id TEXT PRIMARY KEY,
     page_id TEXT NOT NULL,
     bot_id TEXT NOT NULL,
     bot_name TEXT NOT NULL,
     thread_id TEXT,
     kind TEXT NOT NULL,
     block_id TEXT,
     comment_thread_id TEXT,
     summary TEXT NOT NULL,
     status TEXT NOT NULL,
     error TEXT,
     result TEXT,
     dedupe_key TEXT NOT NULL UNIQUE,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS requests_page ON requests (page_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS requests_thread ON requests (thread_id, status)`,
  // Agent threads started from a page's composer.
  `CREATE TABLE IF NOT EXISTS chats (
     thread_id TEXT PRIMARY KEY,
     page_id TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS chats_page ON chats (page_id, created_at)`,
  // Explore: explainers written from what agents noticed along the way (explore/store.ts).
  `CREATE TABLE IF NOT EXISTS explore_explainers (
     id TEXT PRIMARY KEY,
     key TEXT NOT NULL UNIQUE,
     parent_id TEXT,
     thread_id TEXT NOT NULL,
     message_id TEXT NOT NULL,
     turn_id TEXT,
     emoji TEXT NOT NULL,
     label TEXT NOT NULL,
     page_id TEXT,
     project_id TEXT,
     status TEXT NOT NULL,
     follow_ups TEXT NOT NULL DEFAULT '[]',
     generated_at INTEGER,
     regenerated_at INTEGER,
     error TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS explore_explainers_message ON explore_explainers (thread_id, message_id)`,
  `CREATE INDEX IF NOT EXISTS explore_explainers_page ON explore_explainers (page_id)`,
  `CREATE TABLE IF NOT EXISTS explore_jobs (
     id TEXT PRIMARY KEY,
     explainer_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     status TEXT NOT NULL,
     label TEXT NOT NULL,
     detail TEXT NOT NULL,
     progress INTEGER NOT NULL,
     worker_thread_id TEXT,
     error TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS explore_jobs_explainer ON explore_jobs (explainer_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS explore_parents (
     project_key TEXT PRIMARY KEY,
     page_id TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
];

export const newId = (prefix: string) => `${prefix}_${randomBytes(6).toString("hex")}`;

export interface PageRow {
  id: string;
  project_id: string | null;
  parent_id: string | null;
  title: string;
  icon: string;
  position: number;
  state: Buffer | null;
  markdown: string;
  created_at: number;
  updated_at: number;
  updated_by: string;
  archived_at: number | null;
  refresh_bot_id: string | null;
  refresh_cron: string | null;
  refresh_instructions: string;
  refresh_last_at: number | null;
}

export type PageMeta = Omit<PageRow, "state" | "markdown">;

export interface RequestRow {
  id: string;
  page_id: string;
  bot_id: string;
  bot_name: string;
  thread_id: string | null;
  kind: "mention" | "comment" | "refresh";
  block_id: string | null;
  comment_thread_id: string | null;
  summary: string;
  status: "queued" | "working" | "done" | "failed";
  error: string | null;
  result: string | null;
  dedupe_key: string;
  created_at: number;
  updated_at: number;
}

export interface SnapshotMeta {
  id: string;
  page_id: string;
  label: string;
  actor: string;
  created_at: number;
}

const META_COLUMNS =
  "id, project_id, parent_id, title, icon, position, created_at, updated_at, updated_by, archived_at, refresh_bot_id, refresh_cron, refresh_instructions, refresh_last_at";
const SNAPSHOTS_PER_PAGE = 50;

export class PageStore {
  constructor(private readonly db: Database.Database) {}

  // Pages -------------------------------------------------------------------

  list(options: { projectId?: string | null; includeArchived?: boolean } = {}): PageMeta[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (options.projectId !== undefined) {
      // A project's pages plus global pages; `null` means global only.
      where.push(options.projectId === null ? "project_id IS NULL" : "(project_id IS NULL OR project_id = ?)");
      if (options.projectId !== null) args.push(options.projectId);
    }
    if (!options.includeArchived) where.push("archived_at IS NULL");
    const sql = `SELECT ${META_COLUMNS} FROM pages ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY position, created_at`;
    return this.db.prepare(sql).all(...args) as PageMeta[];
  }

  get(id: string): PageRow | null {
    return (this.db.prepare("SELECT * FROM pages WHERE id = ?").get(id) as PageRow | undefined) ?? null;
  }

  meta(id: string): PageMeta | null {
    return (this.db.prepare(`SELECT ${META_COLUMNS} FROM pages WHERE id = ?`).get(id) as PageMeta | undefined) ?? null;
  }

  create(input: { projectId: string | null; parentId: string | null; title: string; icon?: string; actor: string }): PageMeta {
    const id = newId("pg");
    const now = Date.now();
    const last = this.db
      .prepare("SELECT MAX(position) AS max FROM pages WHERE parent_id IS ? AND project_id IS ?")
      .get(input.parentId, input.projectId) as { max: number | null };
    this.db
      .prepare(
        "INSERT INTO pages (id, project_id, parent_id, title, icon, position, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, input.projectId, input.parentId, input.title, input.icon ?? "", (last.max ?? 0) + 1, now, now, input.actor);
    return this.meta(id)!;
  }

  update(
    id: string,
    patch: Partial<Pick<PageRow, "title" | "icon" | "parent_id" | "project_id" | "position" | "archived_at">>,
    actor: string,
  ): PageMeta | null {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
    if (entries.length) {
      const sets = entries.map(([key]) => `${key} = ?`).join(", ");
      this.db
        .prepare(`UPDATE pages SET ${sets}, updated_at = ?, updated_by = ? WHERE id = ?`)
        .run(...entries.map(([, value]) => value), Date.now(), actor, id);
    }
    return this.meta(id);
  }

  saveContent(id: string, state: Uint8Array, markdown: string, actor: string | null): void {
    if (actor === null) {
      this.db.prepare("UPDATE pages SET state = ?, markdown = ? WHERE id = ?").run(Buffer.from(state), markdown, id);
    } else {
      this.db
        .prepare("UPDATE pages SET state = ?, markdown = ?, updated_at = ?, updated_by = ? WHERE id = ?")
        .run(Buffer.from(state), markdown, Date.now(), actor, id);
    }
  }

  setRefresh(id: string, config: { botId: string; cron: string; instructions: string } | null): void {
    this.db
      .prepare("UPDATE pages SET refresh_bot_id = ?, refresh_cron = ?, refresh_instructions = ? WHERE id = ?")
      .run(config?.botId ?? null, config?.cron ?? null, config?.instructions ?? "", id);
  }

  markRefreshed(id: string, at: number): void {
    this.db.prepare("UPDATE pages SET refresh_last_at = ? WHERE id = ?").run(at, id);
  }

  refreshable(): PageMeta[] {
    return this.db
      .prepare(`SELECT ${META_COLUMNS} FROM pages WHERE refresh_bot_id IS NOT NULL AND refresh_cron IS NOT NULL AND archived_at IS NULL`)
      .all() as PageMeta[];
  }

  descendants(id: string): string[] {
    const rows = this.db
      .prepare(
        `WITH RECURSIVE tree(id) AS (SELECT id FROM pages WHERE parent_id = ? UNION ALL SELECT p.id FROM pages p JOIN tree t ON p.parent_id = t.id) SELECT id FROM tree`,
      )
      .all(id) as { id: string }[];
    return rows.map((row) => row.id);
  }

  /** The start of every page's saved Markdown, for previews. */
  markdownHeads(chars = 2000): Map<string, string> {
    const rows = this.db.prepare("SELECT id, substr(markdown, 1, ?) AS head FROM pages").all(chars) as { id: string; head: string | null }[];
    return new Map(rows.map((row) => [row.id, row.head ?? ""]));
  }

  delete(ids: string[]): void {
    const tx = this.db.transaction((all: string[]) => {
      for (const id of all) {
        this.db.prepare("DELETE FROM pages WHERE id = ?").run(id);
        this.db.prepare("DELETE FROM snapshots WHERE page_id = ?").run(id);
        this.db.prepare("DELETE FROM files WHERE page_id = ?").run(id);
        this.db.prepare("DELETE FROM requests WHERE page_id = ?").run(id);
        this.db.prepare("DELETE FROM chats WHERE page_id = ?").run(id);
      }
    });
    tx(ids);
  }

  search(query: string, projectId: string | null | undefined, limit = 20): PageMeta[] {
    const like = `%${query.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    const scope = projectId === undefined ? "" : projectId === null ? "AND project_id IS NULL" : "AND (project_id IS NULL OR project_id = ?)";
    const args: unknown[] = [like, like];
    if (projectId) args.push(projectId);
    args.push(limit);
    return this.db
      .prepare(
        `SELECT ${META_COLUMNS} FROM pages WHERE archived_at IS NULL AND (title LIKE ? ESCAPE '\\' OR markdown LIKE ? ESCAPE '\\') ${scope} ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(...args) as PageMeta[];
  }

  // Snapshots ---------------------------------------------------------------

  addSnapshot(pageId: string, state: Uint8Array, label: string, actor: string): SnapshotMeta {
    const id = newId("snap");
    const now = Date.now();
    this.db
      .prepare("INSERT INTO snapshots (id, page_id, state, label, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, pageId, Buffer.from(state), label, actor, now);
    this.db
      .prepare(
        "DELETE FROM snapshots WHERE page_id = ? AND id NOT IN (SELECT id FROM snapshots WHERE page_id = ? ORDER BY created_at DESC LIMIT ?)",
      )
      .run(pageId, pageId, SNAPSHOTS_PER_PAGE);
    return { id, page_id: pageId, label, actor, created_at: now };
  }

  snapshots(pageId: string): SnapshotMeta[] {
    return this.db
      .prepare("SELECT id, page_id, label, actor, created_at FROM snapshots WHERE page_id = ? ORDER BY created_at DESC")
      .all(pageId) as SnapshotMeta[];
  }

  latestSnapshot(pageId: string): SnapshotMeta | null {
    return this.snapshots(pageId)[0] ?? null;
  }

  snapshotState(id: string): { page_id: string; state: Buffer } | null {
    return (
      (this.db.prepare("SELECT page_id, state FROM snapshots WHERE id = ?").get(id) as
        | { page_id: string; state: Buffer }
        | undefined) ?? null
    );
  }

  // Files -------------------------------------------------------------------

  addFile(pageId: string, name: string, mime: string, data: Uint8Array): string {
    const id = newId("file");
    this.db
      .prepare("INSERT INTO files (id, page_id, name, mime, size, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, pageId, name, mime, data.byteLength, Buffer.from(data), Date.now());
    return id;
  }

  file(id: string): { name: string; mime: string; data: Buffer } | null {
    return (
      (this.db.prepare("SELECT name, mime, data FROM files WHERE id = ?").get(id) as
        | { name: string; mime: string; data: Buffer }
        | undefined) ?? null
    );
  }

  // Bot requests ------------------------------------------------------------

  addRequest(input: Omit<RequestRow, "id" | "created_at" | "updated_at" | "status" | "error" | "result" | "thread_id">): RequestRow | null {
    const id = newId("req");
    const now = Date.now();
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO requests (id, page_id, bot_id, bot_name, kind, block_id, comment_thread_id, summary, status, dedupe_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
      )
      .run(
        id,
        input.page_id,
        input.bot_id,
        input.bot_name,
        input.kind,
        input.block_id,
        input.comment_thread_id,
        input.summary,
        input.dedupe_key,
        now,
        now,
      );
    return result.changes ? this.request(id) : null;
  }

  hasRequest(dedupeKey: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM requests WHERE dedupe_key = ?").get(dedupeKey);
  }

  request(id: string): RequestRow | null {
    return (this.db.prepare("SELECT * FROM requests WHERE id = ?").get(id) as RequestRow | undefined) ?? null;
  }

  updateRequest(id: string, patch: Partial<Pick<RequestRow, "status" | "thread_id" | "error" | "result">>): void {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
    if (!entries.length) return;
    this.db
      .prepare(`UPDATE requests SET ${entries.map(([key]) => `${key} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
      .run(...entries.map(([, value]) => value), Date.now(), id);
  }

  requests(pageId: string, limit = 20): RequestRow[] {
    return this.db
      .prepare("SELECT * FROM requests WHERE page_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(pageId, limit) as RequestRow[];
  }

  addChat(pageId: string, threadId: string): void {
    this.db.prepare("INSERT OR IGNORE INTO chats VALUES (?,?,?)").run(threadId, pageId, Date.now());
  }

  chats(pageId: string, limit = 10): { thread_id: string; created_at: number }[] {
    return this.db
      .prepare("SELECT thread_id, created_at FROM chats WHERE page_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(pageId, limit) as { thread_id: string; created_at: number }[];
  }

  chatPageId(threadId: string): string | null {
    const row = this.db.prepare("SELECT page_id FROM chats WHERE thread_id = ?").get(threadId) as { page_id: string } | undefined;
    return row?.page_id ?? null;
  }

  openRequestsForThread(threadId: string): RequestRow[] {
    return this.db
      .prepare("SELECT * FROM requests WHERE thread_id = ? AND status IN ('queued', 'working') ORDER BY created_at")
      .all(threadId) as RequestRow[];
  }

  openRequestsForPage(pageId: string, botId: string): RequestRow[] {
    return this.db
      .prepare("SELECT * FROM requests WHERE page_id = ? AND bot_id = ? AND status IN ('queued', 'working')")
      .all(pageId, botId) as RequestRow[];
  }
}
