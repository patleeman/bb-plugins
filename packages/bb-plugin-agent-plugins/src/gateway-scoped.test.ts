import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpGateway, type McpStdioCatalog, type McpStdioHost } from "./gateway.js";
import { AgentPluginsStore } from "./store.js";
import { describeTools, searchTools } from "./tool-search.js";
import type { PluginRecord } from "./types.js";

const databases: Database.Database[] = [];
const gateways: McpGateway[] = [];
const log = { info() {}, warn() {}, error() {} };

function catalog(name = "echo"): McpStdioCatalog {
  return {
    tools: [{
      name,
      description: "Echo a value. More detail.",
      inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
      outputSchema: { type: "object", properties: { value: { type: "string" } } },
      annotations: { readOnlyHint: true },
      _meta: { fixture: true },
    }],
    prompts: [], resources: [], resourceTemplates: [],
  };
}

function fixture() {
  const database = new Database(":memory:");
  databases.push(database);
  const store = new AgentPluginsStore(database, (db, statements) => {
    for (const statement of statements) db.exec(statement);
  });
  const plugin: PluginRecord = {
    id: "fixture-plugin", name: "Fixture", version: "1.0.0", description: null,
    specVersion: "1.0.0", sourceType: "path", sourceIntent: "path:/fixture",
    sourceResolved: null, sourceRef: null, tagPrefix: null,
    pluginRoot: "/fixture", pluginData: "/fixture/data", activeGen: 1,
    status: "active", approval: "approved", lastError: null, contentHash: null,
    installedAt: 1, updatedAt: 1,
  };
  store.upsertPlugin(plugin);
  const add = (serverId: string, pluginId = plugin.id) => {
    if (pluginId !== plugin.id) store.upsertPlugin({ ...plugin, id: pluginId, name: pluginId });
    const record = {
      pluginId, serverId, type: "stdio" as const,
      configJson: JSON.stringify({ type: "stdio", command: "fixture-only-never-spawned" }),
      status: "idle" as const, lastError: null, approved: 1, enabled: 1,
    };
    store.upsertMcpServer(record);
    return record;
  };
  const catalogs = new Map<string, McpStdioCatalog>();
  const failures = new Set<string>();
  const stalls = new Set<string>();
  const current = (key: string) => catalogs.get(key) ?? catalog();
  let changed: Parameters<NonNullable<McpStdioHost["onCatalogChanged"]>>[0] | undefined;
  const host = {
    start: vi.fn<McpStdioHost["start"]>(async ({ key }, signal) => {
      if (failures.has(key)) throw new Error(`fixture failure: ${key}`);
      if (stalls.has(key)) return new Promise((_resolve, reject) => {
        if (signal?.aborted) reject(signal.reason);
        else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      return current(key);
    }),
    refresh: vi.fn<McpStdioHost["refresh"]>(async (key) => current(key)),
    close: vi.fn<McpStdioHost["close"]>(async () => {}),
    callTool: vi.fn<McpStdioHost["callTool"]>(async (_key, _name, args) => ({
      content: [{ type: "text", text: "echoed" }], structuredContent: args, _meta: { fixture: true },
    })),
    getPrompt: async () => ({}), readResource: async () => ({}), complete: async () => ({}),
    subscribeResource: async () => {}, unsubscribeResource: async () => {}, setLoggingLevel: async () => {},
    onCatalogChanged(handler) { changed = handler; return () => { changed = undefined; }; },
  } satisfies McpStdioHost;
  const createGateway = () => {
    const gateway = new McpGateway(store, log, { stdioHost: host });
    gateways.push(gateway);
    return gateway;
  };
  const starts = () => host.start.mock.calls.map(([config]) => config.key);
  return { store, plugin, add, host, catalogs, failures, stalls, createGateway, starts,
    changed: (key: string) => changed?.(key, "tools", null) };
}

afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.close()));
  for (const database of databases.splice(0)) database.close();
  vi.useRealTimers();
});

describe("scoped MCP tool discovery", () => {
  it.each(["error", "hang"])("cold and warm server scopes never start an unrelated %s server", async (mode) => {
    const f = fixture();
    f.add("a-broken"); f.add("healthy");
    (mode === "error" ? f.failures : f.stalls).add("fixture-plugin:a-broken");
    const gateway = f.createGateway();
    expect(await gateway.listTools("missing")).toEqual([]);
    const cold = await gateway.listTools(" healthy ");
    expect(cold.map((tool) => tool.name)).toEqual(["echo"]);
    expect(await gateway.listTools("healthy")).toEqual(cold);
    expect(f.starts()).toEqual(["fixture-plugin:healthy"]);
    expect(f.host.refresh).not.toHaveBeenCalled();
    expect(searchTools(cold, { serverId: " healthy ", query: "echo", limit: 1 })).toEqual({
      total: 1, offset: 0,
      tools: [{ opaqueId: cold[0]!.opaqueId, pluginName: "Fixture", serverId: "healthy", name: "echo", summary: "Echo a value.", status: "ready" }],
      servers: [{ pluginName: "Fixture", serverId: "healthy", tools: 1 }],
    });
  });

  it.each(["describe", "call"])("resolves a previous gateway's opaque ID for cold %s without a global walk", async (operation) => {
    const f = fixture(); f.add("healthy__server");
    f.catalogs.set("fixture-plugin:healthy__server", catalog("echo__value"));
    const old = f.createGateway();
    const [definition] = await old.listTools("healthy__server");
    await old.close();
    f.add("a-broken"); f.stalls.add("fixture-plugin:a-broken");
    f.host.start.mockClear();
    const gateway = f.createGateway();
    if (operation === "describe") {
      const ids = [definition!.opaqueId, "unknown", definition!.opaqueId];
      expect(describeTools(await gateway.resolveTools(ids), ids)).toEqual({ tools: [definition], notFound: ["unknown"] });
    } else {
      const signal = new AbortController().signal;
      expect(await gateway.call(definition!.opaqueId, { value: "hello" }, signal)).toEqual({
        content: [{ type: "text", text: "echoed" }], structuredContent: { value: "hello" }, _meta: { fixture: true },
      });
      expect(f.host.callTool).toHaveBeenCalledExactlyOnceWith("fixture-plugin:healthy__server", "echo__value", { value: "hello" }, catalog("echo__value").tools[0], signal);
    }
    expect(f.starts()).toEqual(["fixture-plugin:healthy__server"]);
  });

  it("keeps targeted discovery and calls responsive while a broad cold discovery is stalled", async () => {
    vi.useFakeTimers();
    const f = fixture(); f.add("a-broken"); f.add("healthy");
    f.stalls.add("fixture-plugin:a-broken");
    const gateway = f.createGateway();
    let finished = false;
    const broad = gateway.listTools().then((tools) => { finished = true; return tools; });
    const [healthy] = await gateway.listTools("healthy");
    await gateway.call(healthy!.opaqueId, { value: "hello" });
    expect(finished).toBe(false);
    expect(f.starts().filter((key) => key.endsWith(":healthy"))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await broad).map((tool) => [tool.serverId, tool.status])).toEqual([["a-broken", "error"], ["healthy", "ready"]]);
    // A timeout is cached per server, even though a targeted healthy call is free to proceed.
    await gateway.listTools();
    expect(f.starts().filter((key) => key.endsWith(":a-broken"))).toHaveLength(1);
  });

  it("bounds broad discovery concurrency and preserves catalog order despite out-of-order responses", async () => {
    vi.useFakeTimers();
    const f = fixture();
    for (let i = 0; i < 7; i++) f.add(`server-${i}`);
    let active = 0; let peak = 0;
    f.host.start.mockImplementation(async ({ key }) => {
      active++; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, key.endsWith("0") ? 50 : 10));
      active--;
      return catalog(key);
    });
    const result = f.createGateway().listTools();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.host.start).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(50);
    expect((await result).map((tool) => tool.serverId)).toEqual(Array.from({ length: 7 }, (_, i) => `server-${i}`));
    expect(peak).toBe(4);
  });

  it("backs off only the failed server; healthy lookups never retry it, even after its backoff expires", async () => {
    vi.useFakeTimers();
    const f = fixture(); f.add("a-broken"); f.add("healthy");
    f.failures.add("fixture-plugin:a-broken");
    const gateway = f.createGateway();
    const tools = await gateway.listTools();
    const broken = tools.find((tool) => tool.status === "error")!;
    const healthy = tools.find((tool) => tool.status === "ready")!;
    expect(describeTools(await gateway.resolveTools([broken.opaqueId]), [broken.opaqueId]).tools).toEqual([broken]);
    await expect(gateway.call(broken.opaqueId, {})).rejects.toThrow("fixture failure");
    await gateway.listTools();
    expect(f.starts()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(5_000);
    await gateway.resolveTools([healthy.opaqueId]);
    await gateway.call(healthy.opaqueId, {});
    expect(f.starts()).toHaveLength(2);
    await gateway.listTools("a-broken");
    expect(f.starts().filter((key) => key.endsWith(":a-broken"))).toHaveLength(2);
    expect(f.host.callTool).toHaveBeenCalledTimes(1);
  });

  it("refreshes only the owning stale catalog, rejects removed tools, and honors list-changed updates", async () => {
    vi.useFakeTimers();
    const f = fixture(); f.add("healthy"); f.add("other");
    const gateway = f.createGateway();
    const tools = await gateway.listTools();
    const old = tools.find((tool) => tool.serverId === "healthy")!;
    f.catalogs.set("fixture-plugin:healthy", catalog("replacement"));
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(await gateway.resolveTools([old.opaqueId])).toEqual([]);
    await expect(gateway.call(old.opaqueId, {})).rejects.toThrow("Tool not found");
    expect(f.host.refresh).toHaveBeenCalledExactlyOnceWith("fixture-plugin:healthy", expect.any(AbortSignal));
    const [replacement] = await gateway.listTools("healthy");
    f.catalogs.set("fixture-plugin:healthy", catalog("notified"));
    await f.changed("fixture-plugin:healthy");
    await vi.advanceTimersByTimeAsync(0);
    expect(await gateway.resolveTools([replacement!.opaqueId])).toEqual([]);
    expect((await gateway.listTools("healthy"))[0]!.name).toBe("notified");
    expect(f.host.callTool).not.toHaveBeenCalled();
  });

  it("rejects unknown, forged, wrong-owner and wrong-kind IDs without executing any tool", async () => {
    const f = fixture(); f.add("healthy"); f.add("other");
    f.catalogs.set("fixture-plugin:healthy", { ...catalog(), prompts: [{ name: "echo" }] });
    const gateway = f.createGateway();
    expect(await gateway.resolveTools(["unknown", "fixture-plugin__healthy__echo"])).toEqual([]);
    expect(f.host.start).not.toHaveBeenCalled();
    const [tool] = await gateway.listTools("healthy");
    const forged = tool!.opaqueId.slice(0, -10) + "0000000000";
    const wrongOwner = tool!.opaqueId.replace("__healthy__", "__other__");
    // Prompt/resource IDs have a different hash; identical readable names confer no authority.
    const wrongKind = (await gateway.listPrompts())[0]!.opaqueId;
    for (const id of [forged, wrongOwner, wrongKind]) {
      await expect(gateway.call(id, {})).rejects.toThrow("Tool not found");
    }
    expect(f.host.callTool).not.toHaveBeenCalled();
  });

  it.each(["disabled", "unapproved", "removed"])("rejects a known ID after its owner is %s", async (state) => {
    const f = fixture(); const record = f.add("healthy");
    const gateway = f.createGateway();
    const [tool] = await gateway.listTools("healthy");
    if (state === "removed") f.store.deletePlugin(f.plugin.id);
    else f.store.upsertMcpServer({ ...record, enabled: state === "disabled" ? 0 : 1, approved: state === "unapproved" ? 0 : 1 });
    expect(await gateway.resolveTools([tool!.opaqueId])).toEqual([]);
    await expect(gateway.call(tool!.opaqueId, {})).rejects.toThrow("Tool not found");
    expect(f.host.callTool).not.toHaveBeenCalled();
    expect(f.host.start).toHaveBeenCalledTimes(1);
  });

  it("does not guess between colliding slug prefixes; scoped discovery supplies exact ownership", async () => {
    const f = fixture(); f.add("healthy.one");
    const old = f.createGateway();
    const [tool] = await old.listTools("healthy.one");
    await old.close();
    f.add("healthy_one"); f.stalls.add("fixture-plugin:healthy_one");
    f.host.start.mockClear();
    const gateway = f.createGateway();
    expect(await gateway.resolveTools([tool!.opaqueId])).toEqual([]);
    expect(f.host.start).not.toHaveBeenCalled();
    expect(await gateway.listTools("healthy.one")).toEqual([tool]);
    await gateway.call(tool!.opaqueId, {});
    expect(f.starts()).toEqual(["fixture-plugin:healthy.one"]);
  });

  it("revalidates known IDs after an explicit server reset", async () => {
    const f = fixture(); f.add("healthy");
    const gateway = f.createGateway();
    const [old] = await gateway.listTools("healthy");
    await gateway.resetServer(f.plugin.id, "healthy");
    f.catalogs.set("fixture-plugin:healthy", catalog("replacement"));
    expect(await gateway.resolveTools([old!.opaqueId])).toEqual([]);
    expect(f.host.start).toHaveBeenCalledTimes(2);
    expect(f.host.callTool).not.toHaveBeenCalled();
  });

  it("rechecks approval after discovery before using an already-connected server", async () => {
    const f = fixture(); const record = f.add("healthy");
    const gateway = f.createGateway();
    const [tool] = await gateway.listTools("healthy");
    await gateway.closeServer(f.plugin.id, "healthy");
    f.host.start.mockImplementation(async () => {
      f.store.upsertMcpServer({ ...record, approved: 0 });
      return catalog();
    });
    await expect(gateway.call(tool!.opaqueId, {})).rejects.toThrow("not approved");
    expect(f.host.callTool).not.toHaveBeenCalled();
  });

  it("scopes by serverId across plugins and retains describe ordering, deduplication, and metadata", async () => {
    const f = fixture(); f.add("shared"); f.add("shared", "second-plugin"); f.add("unrelated");
    const gateway = f.createGateway();
    const tools = await gateway.listTools("shared");
    expect(tools).toHaveLength(2);
    expect(new Set(tools.map((tool) => tool.opaqueId)).size).toBe(2);
    const ids = [tools[1]!.opaqueId, "missing", tools[0]!.opaqueId, tools[1]!.opaqueId, "missing"];
    const result = describeTools(await gateway.resolveTools(ids), ids);
    expect(result).toEqual({ tools: [tools[1], tools[0]], notFound: ["missing"] });
    expect(result.tools[0]).toMatchObject({ inputSchema: catalog().tools[0]!.inputSchema, outputSchema: catalog().tools[0]!.outputSchema, annotations: { readOnlyHint: true }, _meta: { fixture: true } });
    expect(searchTools(tools).servers).toHaveLength(2);
    expect(f.starts()).toHaveLength(2);
  });

  it("coalesces concurrent owning-server discovery without retrying a failed mutation", async () => {
    const f = fixture(); f.add("healthy");
    const gateway = f.createGateway();
    const [first, second] = await Promise.all([gateway.listTools("healthy"), gateway.listTools("healthy")]);
    expect(second).toEqual(first);
    expect(f.host.start).toHaveBeenCalledTimes(1);
    f.host.callTool.mockRejectedValue(new Error("fixture mutation failed"));
    await expect(gateway.call(first[0]!.opaqueId, {})).rejects.toThrow("fixture mutation failed");
    expect(f.host.callTool).toHaveBeenCalledTimes(1);
  });
});
