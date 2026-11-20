import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { AgentPluginsStore } from "./store.js";
import type { PluginRecord } from "./types.js";

const databases: Database.Database[] = [];

function createStore(): AgentPluginsStore {
  const database = new Database(":memory:");
  databases.push(database);
  return new AgentPluginsStore(database, (db, statements) => {
    for (const statement of statements) db.exec(statement);
  });
}

function addPlugin(store: AgentPluginsStore): PluginRecord {
  const plugin: PluginRecord = {
    id: "plugin-1",
    name: "Example Plugin",
    version: "1.0.0",
    description: "A test plugin.",
    specVersion: "1.0.0",
    sourceType: "path",
    sourceIntent: "path:/tmp/example-plugin",
    sourceResolved: "path:/tmp/example-plugin#hash",
    sourceRef: null,
    tagPrefix: null,
    pluginRoot: "/tmp/example-plugin-root",
    pluginData: "/tmp/example-plugin-data",
    activeGen: 1,
    status: "active",
    approval: "approved",
    lastError: null,
    contentHash: "hash",
    installedAt: 1,
    updatedAt: 1,
  };
  store.upsertPlugin(plugin);
  return plugin;
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("AgentPluginsStore resource settings", () => {
  it("defaults new skills and MCP servers to enabled and persists independent toggles", () => {
    const store = createStore();
    const plugin = addPlugin(store);

    store.upsertSkill({
      pluginId: plugin.id,
      skillName: "research",
      skillDir: "skills/research",
      frontmatterJson: "{}",
      bodyHash: "skill-hash",
      materializedPath: "/tmp/skills/research",
      status: "active",
      lastError: null,
      enabled: 1,
    });
    store.upsertMcpServer({
      pluginId: plugin.id,
      serverId: "docs",
      type: "stdio",
      configJson: JSON.stringify({ type: "stdio", command: "node" }),
      status: "idle",
      lastError: null,
      approved: 0,
      enabled: 1,
    });

    expect(store.listSkills(plugin.id)[0]?.enabled).toBe(1);
    expect(store.listMcpServers(plugin.id)[0]?.enabled).toBe(1);

    expect(store.setSkillEnabled(plugin.id, "research", false)?.enabled).toBe(0);
    expect(store.setMcpEnabled(plugin.id, "docs", false)?.enabled).toBe(0);
    expect(store.listSkills(plugin.id)[0]?.enabled).toBe(0);
    expect(store.listMcpServers(plugin.id)[0]?.enabled).toBe(0);

    expect(store.setSkillEnabled(plugin.id, "research", true)?.enabled).toBe(1);
    expect(store.setMcpEnabled(plugin.id, "docs", true)?.enabled).toBe(1);
  });
});

describe("AgentPluginsStore approval requests migration", () => {
  // Mirrors bb.storage.migrate: each statement runs once, tracked by index.
  function versionedMigrate(db: Database.Database, statements: string[]): void {
    const applied = db.pragma("user_version", { simple: true }) as number;
    for (let i = applied; i < statements.length; i++) db.exec(statements[i]!);
    db.pragma(`user_version = ${statements.length}`);
  }

  it("keeps servers approved before the upgrade approved and adds an empty request queue", () => {
    const database = new Database(":memory:");
    databases.push(database);
    // The previous release's statements end with the `mcp_servers.enabled` column.
    new AgentPluginsStore(database, (db, statements) => {
      const previous = statements.slice(0, statements.findIndex((statement) => statement.includes("approval_requests")));
      versionedMigrate(db, previous);
    });
    expect(database.prepare(`SELECT name FROM sqlite_master WHERE name = 'approval_requests'`).get()).toBeUndefined();
    const before = new AgentPluginsStore(database, () => {});
    const plugin = addPlugin(before);
    before.upsertMcpServer({
      pluginId: plugin.id, serverId: "docs", type: "stdio", configJson: JSON.stringify({ type: "stdio", command: "node" }),
      status: "idle", lastError: null, approved: 1, enabled: 1,
    });

    const after = new AgentPluginsStore(database, versionedMigrate);
    expect(after.listMcpServers(plugin.id)).toEqual([expect.objectContaining({ serverId: "docs", approved: 1, enabled: 1 })]);
    expect(after.listApprovalRequests()).toEqual([]);

    const request = after.upsertApprovalRequest({ id: "r1", pluginId: plugin.id, serverId: "docs", source: "cli", threadId: null, reason: null, createdAt: 1 });
    // A repeat ask for the same server refreshes the one request.
    after.upsertApprovalRequest({ id: "r2", pluginId: plugin.id, serverId: "docs", source: "agent", threadId: "t", reason: "why", createdAt: 2 });
    expect(after.listApprovalRequests()).toEqual([expect.objectContaining({ id: request.id, source: "agent", reason: "why" })]);
    after.deleteMcpServer(plugin.id, "docs");
    expect(after.listApprovalRequests()).toEqual([]);
  });
});
