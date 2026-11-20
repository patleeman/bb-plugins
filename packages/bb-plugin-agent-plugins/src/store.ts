import type Database from "better-sqlite3";
import type { ApprovalRequestRecord, PluginRecord, PluginSkillRecord, McpServerRecord } from "./types.js";

export class AgentPluginsStore {
  constructor(
    readonly db: Database.Database,
    migrate: (db: Database.Database, statements: string[]) => void,
  ) {
    // Enable foreign_keys for ON DELETE CASCADE
    try { db.exec("PRAGMA foreign_keys = ON"); } catch {}
    migrate(db, [
      `PRAGMA foreign_keys = ON`,
      `CREATE TABLE IF NOT EXISTS plugins (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        version TEXT,
        description TEXT,
        specVersion TEXT NOT NULL,
        sourceType TEXT NOT NULL CHECK(sourceType IN ('path','git','npm')),
        sourceIntent TEXT NOT NULL,
        sourceResolved TEXT,
        sourceRef TEXT,
        tagPrefix TEXT,
        pluginRoot TEXT NOT NULL,
        pluginData TEXT NOT NULL,
        activeGen INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL CHECK(status IN ('active','error','needs-approval')),
        approval TEXT NOT NULL CHECK(approval IN ('pending','approved','disabled')),
        lastError TEXT,
        contentHash TEXT,
        installedAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS plugin_skills (
        pluginId TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
        skillName TEXT NOT NULL,
        skillDir TEXT NOT NULL,
        frontmatterJson TEXT NOT NULL,
        bodyHash TEXT NOT NULL,
        materializedPath TEXT,
        status TEXT NOT NULL,
        lastError TEXT,
        PRIMARY KEY (pluginId, skillName)
      )`,
      `CREATE TABLE IF NOT EXISTS mcp_servers (
        pluginId TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
        serverId TEXT NOT NULL,
        type TEXT NOT NULL,
        configJson TEXT NOT NULL,
        status TEXT NOT NULL,
        lastError TEXT,
        approved INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (pluginId, serverId)
      )`,
      `CREATE TABLE IF NOT EXISTS generations (
        pluginId TEXT NOT NULL,
        gen INTEGER NOT NULL,
        pluginRoot TEXT NOT NULL,
        contentHash TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        PRIMARY KEY (pluginId, gen),
        FOREIGN KEY (pluginId) REFERENCES plugins(id) ON DELETE CASCADE
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_plugins_name ON plugins(name)`,
      // Keep migrations append-only. These columns were added after the
      // initial marketplace schema shipped, so existing installs default to
      // enabled without rewriting their rows.
      `ALTER TABLE plugin_skills ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1`,
      `ALTER TABLE mcp_servers ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1`,
      // Pending asks from agents or the CLI for a person to approve a server.
      // New table only: existing approvals in mcp_servers are untouched.
      `CREATE TABLE IF NOT EXISTS approval_requests (
        id TEXT PRIMARY KEY,
        pluginId TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
        serverId TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('cli','agent','update')),
        threadId TEXT,
        reason TEXT,
        createdAt INTEGER NOT NULL,
        UNIQUE (pluginId, serverId)
      )`,
    ]);
  }

  listPlugins(): PluginRecord[] {
    return this.db.prepare(`SELECT * FROM plugins ORDER BY installedAt DESC`).all() as PluginRecord[];
  }

  getPlugin(id: string): PluginRecord | undefined {
    return this.db.prepare(`SELECT * FROM plugins WHERE id = ?`).get(id) as PluginRecord | undefined;
  }

  getPluginByName(name: string): PluginRecord | undefined {
    return this.db.prepare(`SELECT * FROM plugins WHERE name = ?`).get(name) as PluginRecord | undefined;
  }

  upsertPlugin(record: PluginRecord): void {
    this.db
      .prepare(
        `INSERT INTO plugins (id, name, version, description, specVersion, sourceType, sourceIntent, sourceResolved, sourceRef, tagPrefix, pluginRoot, pluginData, activeGen, status, approval, lastError, contentHash, installedAt, updatedAt)
         VALUES (@id, @name, @version, @description, @specVersion, @sourceType, @sourceIntent, @sourceResolved, @sourceRef, @tagPrefix, @pluginRoot, @pluginData, @activeGen, @status, @approval, @lastError, @contentHash, @installedAt, @updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name, version=excluded.version, description=excluded.description, specVersion=excluded.specVersion,
           sourceType=excluded.sourceType, sourceIntent=excluded.sourceIntent, sourceResolved=excluded.sourceResolved, sourceRef=excluded.sourceRef, tagPrefix=excluded.tagPrefix,
           pluginRoot=excluded.pluginRoot, pluginData=excluded.pluginData, activeGen=excluded.activeGen, status=excluded.status, approval=excluded.approval,
           lastError=excluded.lastError, contentHash=excluded.contentHash, updatedAt=excluded.updatedAt`,
      )
      .run(record as unknown as Record<string, unknown>);
  }

  deletePlugin(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM plugins WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  listSkills(pluginId?: string): PluginSkillRecord[] {
    if (pluginId) {
      return this.db.prepare(`SELECT * FROM plugin_skills WHERE pluginId = ?`).all(pluginId) as PluginSkillRecord[];
    }
    return this.db.prepare(`SELECT * FROM plugin_skills`).all() as PluginSkillRecord[];
  }

  upsertSkill(record: PluginSkillRecord): void {
    this.db
      .prepare(
        `INSERT INTO plugin_skills (pluginId, skillName, skillDir, frontmatterJson, bodyHash, materializedPath, status, lastError, enabled)
         VALUES (@pluginId, @skillName, @skillDir, @frontmatterJson, @bodyHash, @materializedPath, @status, @lastError, @enabled)
         ON CONFLICT(pluginId, skillName) DO UPDATE SET
           skillDir=excluded.skillDir, frontmatterJson=excluded.frontmatterJson, bodyHash=excluded.bodyHash,
           materializedPath=excluded.materializedPath, status=excluded.status, lastError=excluded.lastError,
           enabled=excluded.enabled`,
      )
      .run(record as unknown as Record<string, unknown>);
  }

  setSkillEnabled(pluginId: string, skillName: string, enabled: boolean): PluginSkillRecord | undefined {
    this.db
      .prepare(`UPDATE plugin_skills SET enabled = ? WHERE pluginId = ? AND skillName = ?`)
      .run(enabled ? 1 : 0, pluginId, skillName);
    return this.db
      .prepare(`SELECT * FROM plugin_skills WHERE pluginId = ? AND skillName = ?`)
      .get(pluginId, skillName) as PluginSkillRecord | undefined;
  }

  deleteSkill(pluginId: string, skillName: string): boolean {
    const result = this.db
      .prepare(`DELETE FROM plugin_skills WHERE pluginId = ? AND skillName = ?`)
      .run(pluginId, skillName);
    return result.changes > 0;
  }

  listMcpServers(pluginId?: string): McpServerRecord[] {
    if (pluginId) {
      return this.db.prepare(`SELECT * FROM mcp_servers WHERE pluginId = ?`).all(pluginId) as McpServerRecord[];
    }
    return this.db.prepare(`SELECT * FROM mcp_servers`).all() as McpServerRecord[];
  }

  upsertMcpServer(record: McpServerRecord): void {
    this.db
      .prepare(
        `INSERT INTO mcp_servers (pluginId, serverId, type, configJson, status, lastError, approved, enabled)
         VALUES (@pluginId, @serverId, @type, @configJson, @status, @lastError, @approved, @enabled)
         ON CONFLICT(pluginId, serverId) DO UPDATE SET
           type=excluded.type, configJson=excluded.configJson, status=excluded.status, lastError=excluded.lastError,
           approved=excluded.approved, enabled=excluded.enabled`,
      )
      .run(record as unknown as Record<string, unknown>);
  }

  setMcpEnabled(pluginId: string, serverId: string, enabled: boolean): McpServerRecord | undefined {
    this.db
      .prepare(`UPDATE mcp_servers SET enabled = ? WHERE pluginId = ? AND serverId = ?`)
      .run(enabled ? 1 : 0, pluginId, serverId);
    return this.db
      .prepare(`SELECT * FROM mcp_servers WHERE pluginId = ? AND serverId = ?`)
      .get(pluginId, serverId) as McpServerRecord | undefined;
  }

  deleteMcpServer(pluginId: string, serverId: string): boolean {
    this.deleteApprovalRequests(pluginId, serverId);
    const result = this.db
      .prepare(`DELETE FROM mcp_servers WHERE pluginId = ? AND serverId = ?`)
      .run(pluginId, serverId);
    return result.changes > 0;
  }

  listApprovalRequests(): ApprovalRequestRecord[] {
    return this.db.prepare(`SELECT * FROM approval_requests ORDER BY createdAt ASC`).all() as ApprovalRequestRecord[];
  }

  getApprovalRequest(id: string): ApprovalRequestRecord | undefined {
    return this.db.prepare(`SELECT * FROM approval_requests WHERE id = ?`).get(id) as ApprovalRequestRecord | undefined;
  }

  /** One pending request per server: a repeat ask refreshes who asked and why. */
  upsertApprovalRequest(record: ApprovalRequestRecord): ApprovalRequestRecord {
    this.db
      .prepare(
        `INSERT INTO approval_requests (id, pluginId, serverId, source, threadId, reason, createdAt)
         VALUES (@id, @pluginId, @serverId, @source, @threadId, @reason, @createdAt)
         ON CONFLICT(pluginId, serverId) DO UPDATE SET
           source=excluded.source, threadId=excluded.threadId, reason=excluded.reason, createdAt=excluded.createdAt`,
      )
      .run(record as unknown as Record<string, unknown>);
    return this.db
      .prepare(`SELECT * FROM approval_requests WHERE pluginId = ? AND serverId = ?`)
      .get(record.pluginId, record.serverId) as ApprovalRequestRecord;
  }

  deleteApprovalRequests(pluginId: string, serverId?: string): number {
    const result = serverId === undefined
      ? this.db.prepare(`DELETE FROM approval_requests WHERE pluginId = ?`).run(pluginId)
      : this.db.prepare(`DELETE FROM approval_requests WHERE pluginId = ? AND serverId = ?`).run(pluginId, serverId);
    return result.changes;
  }

  snapshot() {
    return {
      plugins: this.listPlugins(),
      skills: this.listSkills(),
      mcpServers: this.listMcpServers(),
      requests: this.listApprovalRequests(),
    };
  }

  transaction<T>(fn: () => T): T {
    const tx = this.db.transaction(fn);
    return tx();
  }
}
