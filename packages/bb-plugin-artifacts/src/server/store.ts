// Artifacts in the plugin's SQLite database. An artifact is a titled item with
// one or more versions; each version points at bytes stored once per sha256,
// so saving an unchanged file again costs nothing.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { MAX_ARTIFACT_BYTES, artifactType, formatBytes, type ArtifactType } from "../shared";

/**
 * Append-only: statement index is the migration id, and BB checks each
 * statement against the hash it recorded, so never edit one (not even its
 * whitespace).
 */
export const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS artifacts (
       id TEXT PRIMARY KEY,
       title TEXT NOT NULL,
       description TEXT NOT NULL DEFAULT '',
       project_id TEXT,
       source_thread_id TEXT,
       source_path TEXT,
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL,
       updated_by TEXT,
       archived_at INTEGER
     );
   CREATE UNIQUE INDEX IF NOT EXISTS artifacts_source ON artifacts (source_thread_id, source_path)
     WHERE source_thread_id IS NOT NULL AND source_path IS NOT NULL;
   CREATE TABLE IF NOT EXISTS artifact_versions (
       id TEXT PRIMARY KEY,
       artifact_id TEXT NOT NULL REFERENCES artifacts (id) ON DELETE CASCADE,
       number INTEGER NOT NULL,
       name TEXT NOT NULL,
       mime TEXT NOT NULL,
       size INTEGER NOT NULL,
       sha256 TEXT NOT NULL,
       created_at INTEGER NOT NULL,
       UNIQUE (artifact_id, number)
     );
   CREATE TABLE IF NOT EXISTS artifact_blobs (
       sha256 TEXT PRIMARY KEY,
       bytes BLOB NOT NULL
     );`,
];

export type ArtifactRow = {
  id: string;
  title: string;
  description: string;
  project_id: string | null;
  source_thread_id: string | null;
  source_path: string | null;
  created_at: number;
  updated_at: number;
  /** "user" or "agent". */
  updated_by: string | null;
  archived_at: number | null;
};

export type VersionRow = {
  id: string;
  artifact_id: string;
  number: number;
  /** The file name, which decides the type the viewer shows. */
  name: string;
  mime: string;
  size: number;
  sha256: string;
  created_at: number;
};

/** An artifact with its newest version and version count. */
export type ArtifactWithVersion = ArtifactRow & { version: VersionRow; versions: number };

/** Who saved. The CLI counts as an agent: agents are its main users. */
export type Writer = "agent" | "cli" | "app";

export function writerKind(by: Writer): "user" | "agent" {
  return by === "app" ? "user" : "agent";
}

export interface SaveInput {
  title?: string | null;
  description?: string | null;
  /** The file name; its extension picks the viewer. */
  name: string;
  mime: string;
  bytes: Uint8Array;
  projectId: string | null;
  /** With `sourcePath`, identifies the file so saving it again adds a version. */
  sourceThreadId?: string | null;
  sourcePath?: string | null;
  /** Adds a version to this artifact instead. */
  artifactId?: string | null;
  by: Writer;
}

export interface SaveResult {
  artifact: ArtifactWithVersion;
  /** "created": a new artifact; "versioned": a new version; "unchanged": same bytes as the newest version. */
  outcome: "created" | "versioned" | "unchanged";
  /** The artifact was archived; saving to it brought it back. */
  restored?: boolean;
}

export class ArtifactStore {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number = Date.now,
  ) {
    db.pragma("foreign_keys = ON");
  }

  get(id: string): ArtifactWithVersion | null {
    const row = this.db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as ArtifactRow | undefined;
    return row ? this.withVersion(row) : null;
  }

  list(options: { includeArchived?: boolean; limit?: number; threadId?: string } = {}): ArtifactWithVersion[] {
    const where = [
      options.includeArchived ? null : "archived_at IS NULL",
      options.threadId ? "source_thread_id = @threadId" : null,
    ].filter(Boolean);
    const rows = this.db
      .prepare(
        `SELECT * FROM artifacts ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY updated_at DESC LIMIT @limit`,
      )
      .all({ threadId: options.threadId ?? null, limit: options.limit ?? -1 }) as ArtifactRow[];
    return rows.map((row) => this.withVersion(row));
  }

  /** The artifact saved from this file in this thread, if any. */
  findBySource(threadId: string, path: string): ArtifactWithVersion | null {
    const row = this.db
      .prepare("SELECT * FROM artifacts WHERE source_thread_id = ? AND source_path = ?")
      .get(threadId, path) as ArtifactRow | undefined;
    return row ? this.withVersion(row) : null;
  }

  versions(id: string): VersionRow[] {
    return this.db
      .prepare("SELECT * FROM artifact_versions WHERE artifact_id = ? ORDER BY number DESC")
      .all(id) as VersionRow[];
  }

  version(artifactId: string, versionId: string): VersionRow | null {
    return (
      (this.db
        .prepare("SELECT * FROM artifact_versions WHERE artifact_id = ? AND id = ?")
        .get(artifactId, versionId) as VersionRow | undefined) ?? null
    );
  }

  bytes(sha256: string): Buffer | null {
    const row = this.db.prepare("SELECT bytes FROM artifact_blobs WHERE sha256 = ?").get(sha256) as { bytes: Buffer } | undefined;
    return row?.bytes ?? null;
  }

  /**
   * Saves a file. The same source file from the same thread becomes a new
   * version of its artifact, unless the bytes haven't changed. Saving to an
   * archived artifact brings it back, whether or not the bytes changed.
   */
  save(input: SaveInput): SaveResult {
    if (input.bytes.byteLength > MAX_ARTIFACT_BYTES) {
      throw new Error(
        `${input.name} is ${formatBytes(input.bytes.byteLength)}; artifacts can be at most ${formatBytes(MAX_ARTIFACT_BYTES)}.`,
      );
    }
    const sha256 = createHash("sha256").update(input.bytes).digest("hex");
    const title = input.title?.trim() || null;
    const description = input.description?.trim() ?? null;
    const source = input.sourceThreadId && input.sourcePath ? { thread: input.sourceThreadId, path: input.sourcePath } : null;

    return this.db.transaction((): SaveResult => {
      const existing = input.artifactId
        ? this.get(input.artifactId)
        : source
          ? this.findBySource(source.thread, source.path)
          : null;
      if (input.artifactId && !existing) throw new Error(`Artifact ${input.artifactId} not found.`);
      const at = this.nextRevision(existing?.updated_at ?? 0);
      const restored = existing ? existing.archived_at !== null : false;
      if (existing && existing.version.sha256 === sha256 && existing.version.name === input.name) {
        if (restored || (title && title !== existing.title) || (description !== null && description !== existing.description)) {
          this.db
            .prepare("UPDATE artifacts SET title = ?, description = ?, updated_at = ?, updated_by = ?, archived_at = NULL WHERE id = ?")
            .run(title ?? existing.title, description ?? existing.description, at, writerKind(input.by), existing.id);
        }
        return { artifact: this.get(existing.id)!, outcome: "unchanged", ...(restored ? { restored } : {}) };
      }

      this.db.prepare("INSERT OR IGNORE INTO artifact_blobs (sha256, bytes) VALUES (?, ?)").run(sha256, Buffer.from(input.bytes));
      let id: string;
      if (existing) {
        id = existing.id;
        this.db
          .prepare(
            `UPDATE artifacts SET title = ?, description = ?, updated_at = ?, updated_by = ?, archived_at = NULL WHERE id = ?`,
          )
          .run(title ?? existing.title, description ?? existing.description, at, writerKind(input.by), id);
      } else {
        id = newArtifactId();
        this.db
          .prepare(
            `INSERT INTO artifacts (id, title, description, project_id, source_thread_id, source_path, created_at, updated_at, updated_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(id, title ?? "", description ?? "", input.projectId, source?.thread ?? null, source?.path ?? null, at, at, writerKind(input.by));
      }
      this.db
        .prepare(
          `INSERT INTO artifact_versions (id, artifact_id, number, name, mime, size, sha256, created_at)
           VALUES (?, ?, (SELECT COALESCE(MAX(number), 0) + 1 FROM artifact_versions WHERE artifact_id = ?), ?, ?, ?, ?, ?)`,
        )
        .run(randomUUID(), id, id, input.name, input.mime, input.bytes.byteLength, sha256, at);
      return { artifact: this.get(id)!, outcome: existing ? "versioned" : "created", ...(restored ? { restored } : {}) };
    })();
  }

  update(id: string, changes: { title?: string; description?: string }, by: Writer): number {
    const current = this.get(id);
    if (!current) throw new Error("Artifact not found.");
    const at = this.nextRevision(current.updated_at);
    this.db
      .prepare("UPDATE artifacts SET title = ?, description = ?, updated_at = ?, updated_by = ? WHERE id = ?")
      .run(changes.title ?? current.title, changes.description ?? current.description, at, writerKind(by), id);
    return at;
  }

  setProject(id: string, projectId: string | null): void {
    this.db.prepare("UPDATE artifacts SET project_id = ? WHERE id = ?").run(projectId, id);
  }

  setArchived(id: string, archived: boolean): void {
    this.db.prepare("UPDATE artifacts SET archived_at = ? WHERE id = ?").run(archived ? this.now() : null, id);
  }

  /** Deletes an artifact, its versions, and any bytes nothing else uses. */
  delete(id: string): boolean {
    return this.db.transaction(() => {
      const removed = this.db.prepare("DELETE FROM artifacts WHERE id = ?").run(id).changes > 0;
      if (removed) {
        this.db.prepare("DELETE FROM artifact_versions WHERE artifact_id = ?").run(id);
        this.db
          .prepare("DELETE FROM artifact_blobs WHERE sha256 NOT IN (SELECT DISTINCT sha256 FROM artifact_versions)")
          .run();
      }
      return removed;
    })();
  }

  private withVersion(row: ArtifactRow): ArtifactWithVersion {
    const version = this.db
      .prepare("SELECT * FROM artifact_versions WHERE artifact_id = ? ORDER BY number DESC LIMIT 1")
      .get(row.id) as VersionRow;
    const { versions } = this.db
      .prepare("SELECT COUNT(*) AS versions FROM artifact_versions WHERE artifact_id = ?")
      .get(row.id) as { versions: number };
    return { ...row, version, versions };
  }

  /** Two saves in the same millisecond still get distinct revisions. */
  private nextRevision(current: number): number {
    return Math.max(this.now(), current + 1);
  }
}

function newArtifactId(): string {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  const bytes = randomBytes(16);
  let id = "art_";
  for (const byte of bytes) id += alphabet[byte % alphabet.length];
  return id;
}

/** The type a version shows as. */
export function versionType(version: Pick<VersionRow, "name" | "mime">): ArtifactType {
  return artifactType(version.name, version.mime);
}

/** The title to show; saves without one use the file name. */
export function displayTitle(artifact: Pick<ArtifactWithVersion, "title" | "version">): string {
  return artifact.title.trim() || artifact.version.name;
}
