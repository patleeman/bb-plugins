// bb-plugin-agent-plugins — backend entry (full activation)
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as yaml from "js-yaml";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { AgentPluginsStore } from "./src/store.js";
import { validateManifest, validateMcpEnvelope, validateMcpServer, validateSkillFrontmatter } from "./src/loader.js";
import { McpGateway, type McpStdioCatalog, type McpStdioHost } from "./src/gateway.js";
import { mcpHostContract, mcpHostSignals } from "./src/host-contract.js";
import { DEFAULT_TOOL_SEARCH_LIMIT, MAX_DESCRIBE_TOOLS, MAX_TOOL_SEARCH_LIMIT, describeTools, searchTools } from "./src/tool-search.js";
import { DeferredOAuthCredentialStore, McpOAuthProvider, type OAuthCredentialRecord } from "./src/oauth.js";
import { oauthCallbackUrl, validatePastedCallback } from "./src/callback-url.js";
import { parseSource, fetchSource, probeSource } from "./src/source.js";
import { materializeSkill, unmaterializeSkill } from "./src/skills-impl.js";
import { ensureDir, hashDirectory, rimraf, atomicRename, LIMITS } from "./src/safe-fs.js";
import type { CatalogPrompt, CatalogResource, CatalogResourceTemplate, CatalogTool, McpServerRecord, PluginRecord, PluginSkillRecord } from "./src/types.js";

const jsonRecordSchema = z.record(z.string(), z.unknown());

const updateResultSchema = z.object({
  id: z.string(),
  currentVersion: z.string().nullable(),
  latestVersion: z.string().nullable(),
  available: z.boolean(),
  checkedAt: z.number().int(),
  error: z.string().nullable(),
}).strict();
type UpdateResult = z.infer<typeof updateResultSchema>;

const snapshotSchema = z.object({
  plugins: z.array(z.record(z.string(), z.unknown())),
  skills: z.array(z.record(z.string(), z.unknown())),
  mcpServers: z.array(z.record(z.string(), z.unknown())),
  updates: z.array(updateResultSchema),
  dataDir: z.string().nullable(),
}).strict();

const toolSchema = z.object({
  opaqueId: z.string(),
  pluginId: z.string(),
  pluginName: z.string(),
  serverId: z.string(),
  serverType: z.string(),
  name: z.string(),
  description: z.string(),
  inputSchema: jsonRecordSchema,
  outputSchema: jsonRecordSchema.optional(),
  annotations: jsonRecordSchema.optional(),
  execution: jsonRecordSchema.optional(),
  icons: z.array(jsonRecordSchema).optional(),
  _meta: jsonRecordSchema.optional(),
  status: z.enum(["ready", "error"]),
  error: z.string().optional(),
}).strict();

const promptSchema = z.object({
  opaqueId: z.string(), pluginId: z.string(), pluginName: z.string(), serverId: z.string(), serverType: z.string(),
  name: z.string(), title: z.string().optional(), description: z.string().optional(), arguments: z.array(jsonRecordSchema).optional(),
  icons: z.array(jsonRecordSchema).optional(), _meta: jsonRecordSchema.optional(), status: z.enum(["ready", "error"]), error: z.string().optional(),
}).strict();

const resourceSchema = z.object({
  opaqueId: z.string(), pluginId: z.string(), pluginName: z.string(), serverId: z.string(), serverType: z.string(),
  uri: z.string(), name: z.string(), title: z.string().optional(), description: z.string().optional(), mimeType: z.string().optional(),
  icons: z.array(jsonRecordSchema).optional(), _meta: jsonRecordSchema.optional(), status: z.enum(["ready", "error"]), error: z.string().optional(),
}).strict();

const resourceTemplateSchema = z.object({
  opaqueId: z.string(), pluginId: z.string(), pluginName: z.string(), serverId: z.string(), serverType: z.string(),
  uriTemplate: z.string(), name: z.string(), title: z.string().optional(), description: z.string().optional(), mimeType: z.string().optional(),
  icons: z.array(jsonRecordSchema).optional(), _meta: jsonRecordSchema.optional(), status: z.enum(["ready", "error"]), error: z.string().optional(),
}).strict();

const authActionOutput = z.object({ url: z.string().nullable(), status: z.string() }).strict();
export const rpcContract = defineRpcContract({
  snapshot: { input: z.null(), output: snapshotSchema },
  listTools: { input: z.null(), output: z.object({ tools: z.array(toolSchema) }).strict() },
  callTool: { input: z.object({ opaqueId: z.string().min(1), args: jsonRecordSchema.default({}) }).strict(), output: z.object({ content: z.array(jsonRecordSchema), isError: z.boolean().optional(), structuredContent: z.unknown().optional(), _meta: jsonRecordSchema.optional() }).strict() },
  listPrompts: { input: z.null(), output: z.object({ prompts: z.array(promptSchema) }).strict() },
  getPrompt: { input: z.object({ opaqueId: z.string().min(1), args: jsonRecordSchema.default({}) }).strict(), output: jsonRecordSchema },
  listResources: { input: z.null(), output: z.object({ resources: z.array(resourceSchema) }).strict() },
  listResourceTemplates: { input: z.null(), output: z.object({ resourceTemplates: z.array(resourceTemplateSchema) }).strict() },
  readResource: { input: z.object({ opaqueId: z.string().min(1) }).strict(), output: jsonRecordSchema },
  complete: { input: z.object({ ref: jsonRecordSchema, argument: jsonRecordSchema }).strict(), output: jsonRecordSchema },
  subscribeResource: { input: z.object({ opaqueId: z.string().min(1) }).strict(), output: z.object({ subscribed: z.boolean() }).strict() },
  unsubscribeResource: { input: z.object({ opaqueId: z.string().min(1) }).strict(), output: z.object({ unsubscribed: z.boolean() }).strict() },
  setLoggingLevel: { input: z.object({ level: z.string().min(1) }).strict(), output: z.object({ updated: z.boolean() }).strict() },
  install: { input: z.object({ source: z.string().min(1), tagPrefix: z.string().optional() }).strict(), output: z.object({ id: z.string(), name: z.string().nullable(), version: z.string().nullable() }).strict() },
  checkUpdates: { input: z.object({ id: z.string().min(1).optional(), refresh: z.boolean().optional() }).strict(), output: z.object({ updates: z.array(updateResultSchema) }).strict() },
  update: { input: z.object({ id: z.string().min(1) }).strict(), output: z.object({ id: z.string(), name: z.string().nullable(), version: z.string().nullable() }).strict() },
  remove: { input: z.object({ id: z.string().min(1), purgeData: z.boolean().optional() }).strict(), output: z.object({ deleted: z.boolean() }).strict() },
  refresh: { input: z.object({ id: z.string().min(1) }).strict(), output: z.object({ id: z.string(), name: z.string().nullable() }).strict() },
  approve: { input: z.object({ id: z.string().min(1), serverId: z.string().min(1) }).strict(), output: z.object({ approved: z.boolean() }).strict() },
  setSkillEnabled: { input: z.object({ id: z.string().min(1), skillName: z.string().min(1), enabled: z.boolean() }).strict(), output: z.object({ enabled: z.boolean(), status: z.string(), lastError: z.string().nullable() }).strict() },
  setMcpEnabled: { input: z.object({ id: z.string().min(1), serverId: z.string().min(1), enabled: z.boolean() }).strict(), output: z.object({ enabled: z.boolean(), status: z.string(), lastError: z.string().nullable() }).strict() },
  authenticate: { input: z.object({ id: z.string().min(1), serverId: z.string().min(1) }).strict(), output: z.object({ url: z.string().nullable(), status: z.string() }).strict() },
  reconnect: { input: z.object({ id: z.string().min(1), serverId: z.string().min(1) }).strict(), output: authActionOutput },
  reauthorize: { input: z.object({ id: z.string().min(1), serverId: z.string().min(1) }).strict(), output: authActionOutput },
  authStatus: { input: z.object({ id: z.string().min(1), serverId: z.string().min(1) }).strict(), output: z.object({ status: z.string() }).strict() },
  finishAuthentication: { input: z.object({ id: z.string().min(1), serverId: z.string().min(1), callbackUrl: z.string().url() }).strict(), output: z.object({ authenticated: z.boolean() }).strict() },
  cancelAuthentication: { input: z.object({ id: z.string().min(1), serverId: z.string().min(1) }).strict(), output: z.object({ canceled: z.boolean() }).strict() },
  clearAuthentication: { input: z.object({ id: z.string().min(1), serverId: z.string().min(1) }).strict(), output: z.object({ cleared: z.boolean() }).strict() },
  pickFolder: { input: z.null(), output: z.object({ path: z.string().nullable() }).strict() },
});

function errorText(e: unknown): string { return e instanceof Error ? e.message : String(e); }

function randomId(): string { return crypto.randomUUID(); }

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sameMcpConfig(previous: McpServerRecord, nextType: string, nextRaw: unknown): boolean {
  if (previous.type !== nextType) return false;
  try { return canonicalJson(JSON.parse(previous.configJson)) === canonicalJson(nextRaw); }
  catch { return false; }
}

async function readJsonLimited(filePath: string): Promise<unknown> {
  const stat = await fsp.stat(filePath);
  if (stat.size > LIMITS.maxJsonBytes) throw new Error(`JSON too large: ${filePath} ${stat.size} > ${LIMITS.maxJsonBytes}`);
  const text = await fsp.readFile(filePath, "utf8");
  if (text.length > LIMITS.maxJsonBytes) throw new Error(`JSON too large`);
  return JSON.parse(text);
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("[agent-plugins] loading");

  // dataDir via system.config()
  let dataDir: string | null = null;
  try {
    const cfg = await bb.sdk.system.config() as unknown as { dataDir?: string };
    if (typeof cfg.dataDir === "string") dataDir = cfg.dataDir;
  } catch {}
  if (!dataDir) {
    // Fallback: try to infer from plugin storage location via env? Use os tmp but still need skillsRoot
    // We'll lazy-resolve inside handlers and error if missing
    bb.log.warn("[agent-plugins] dataDir not resolved at load; will resolve lazily");
  }

  const getDataDir = async (): Promise<string> => {
    if (dataDir) return dataDir;
    const cfg = await bb.sdk.system.config() as unknown as { dataDir?: string };
    if (typeof cfg.dataDir === "string" && cfg.dataDir) {
      dataDir = cfg.dataDir;
      return cfg.dataDir;
    }
    throw new Error("dataDir unavailable");
  };

  async function publishChanged(payload: Record<string, unknown>): Promise<void> {
    try {
      await bb.realtime.publish("agent-plugins-changed", payload);
    } catch (e) {
      // Realtime is an observation channel; it must not turn a committed
      // install or approval into a failed operation.
      bb.log.warn(`[agent-plugins] realtime publish failed: ${errorText(e)}`);
    }
  }

  const store = new AgentPluginsStore(bb.storage.database(), (db, s) => bb.storage.migrate(db, s));
  const oauthSettings = bb.settings.define({
    oauthCredentials: {
      type: "string",
      label: "MCP OAuth credentials",
      description: "Managed automatically by Agent Plugins; stored as a BB secret.",
      secret: true,
      default: "",
    },
  });
  const oauthCredentialStore = new DeferredOAuthCredentialStore({
    async load(): Promise<Record<string, OAuthCredentialRecord>> {
      const settings = await oauthSettings.get();
      const raw = settings.oauthCredentials;
      if (!raw) return {};
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, OAuthCredentialRecord>;
      } catch (e) { bb.log.warn(`[agent-plugins] OAuth secret store is invalid: ${errorText(e)}`); }
      return {};
    },
    async save(next: Record<string, OAuthCredentialRecord>): Promise<void> {
      await bb.sdk.plugins.updateSettings({ pluginId: bb.pluginId, values: { oauthCredentials: JSON.stringify(next) } });
    },
  }, (error) => bb.log.warn(`[agent-plugins] OAuth secret persistence failed: ${errorText(error)}`));
  async function withDeferredOAuthPersistence<T>(operation: () => Promise<T>): Promise<T> {
    const release = oauthCredentialStore.deferPersistence();
    try { return await operation(); }
    finally { release(); }
  }
  async function deleteOAuthCredentials(pluginId: string, serverId: string): Promise<void> {
    try {
      await oauthCredentialStore.delete(`${pluginId}:${serverId}`);
    } catch (e) {
      throw new Error(`Could not delete OAuth credentials for ${pluginId}:${serverId}: ${errorText(e)}`, { cause: e });
    }
  }
  const mcpHostClient = bb.hosts.experimental_client({
    contract: mcpHostContract,
    experimental_signals: mcpHostSignals,
  });
  let mcpHostIdPromise: Promise<string> | null = null;
  async function getMcpHostId(): Promise<string> {
    if (mcpHostIdPromise) return mcpHostIdPromise;
    mcpHostIdPromise = (async () => {
      const cfg = await bb.sdk.system.config() as unknown as { primaryHostId?: string | null };
      if (cfg.primaryHostId) return cfg.primaryHostId;
      const hosts = await bb.sdk.hosts.list();
      const hostId = hosts[0]?.id;
      if (!hostId) throw new Error("No host available for isolated MCP servers");
      return hostId;
    })().catch((error) => {
      mcpHostIdPromise = null;
      throw error;
    });
    return mcpHostIdPromise;
  }
  const hostCall = async (method: string, input: unknown, signal?: AbortSignal): Promise<unknown> => {
    const hostId = await getMcpHostId();
    const client = mcpHostClient as unknown as {
      call(name: string, value: unknown, options: { hostId: string; signal?: AbortSignal }): Promise<unknown>;
    };
    return client.call(method, input, { hostId, ...(signal ? { signal } : {}) });
  };
  const stdioHost: McpStdioHost = {
    async start(config, signal) { return await hostCall("start", config, signal) as McpStdioCatalog; },
    async refresh(key, signal) { return await hostCall("refresh", { key }, signal) as McpStdioCatalog; },
    async close(key, signal) { await hostCall("close", { key }, signal); },
    async callTool(key, name, args, toolDefinition, signal) {
      return hostCall("callTool", { key, name, args, ...(toolDefinition ? { toolDefinition } : {}) }, signal);
    },
    async getPrompt(key, name, args, signal) { return hostCall("getPrompt", { key, name, args }, signal); },
    async readResource(key, uri, signal) { return hostCall("readResource", { key, uri }, signal); },
    async complete(key, ref, argument, signal) { return hostCall("complete", { key, ref, argument }, signal); },
    async subscribeResource(key, uri, signal) { await hostCall("subscribeResource", { key, uri }, signal); },
    async unsubscribeResource(key, uri, signal) { await hostCall("unsubscribeResource", { key, uri }, signal); },
    async setLoggingLevel(key, level, signal) { await hostCall("setLoggingLevel", { key, level }, signal); },
    onWorkerExit(handler) {
      return mcpHostClient.experimental_onWorkerExit(({ hostId }) => handler(hostId));
    },
    onCatalogChanged(handler) {
      return mcpHostClient.experimental_onSignal("catalogChanged", ({ payload }) => handler(payload.key, payload.kind, payload.error));
    },
    onConnectionChanged(handler) {
      return mcpHostClient.experimental_onSignal("connectionChanged", ({ payload }) => handler(payload.key, payload.status, payload.error));
    },
  };
  const gateway = new McpGateway(store, bb.log, {
    onChanged: () => publishChanged({ kind: "mcp-runtime" }),
    stdioHost,
    oauth: {
      async getProvider(pluginId, serverId, serverUrl) {
        const redirect = oauthCallbackUrl(bb.server.loopbackBaseUrl, bb.pluginId, pluginId, serverId);
        return new McpOAuthProvider(`${pluginId}:${serverId}`, serverUrl, redirect, oauthCredentialStore);
      },
    },
  });
  const installLocks = new Set<string>();
  const updateCache = new Map<string, UpdateResult>();
  const updateGenerations = new Map<string, number>();
  const updateQueue: string[] = [];
  const queuedUpdateIds = new Set<string>();
  const updateTasks = new Map<string, {
    promise: Promise<UpdateResult>;
    resolve: (result: UpdateResult) => void;
    reject: (error: unknown) => void;
  }>();
  const UPDATE_CHECK_INTERVAL_MS = 15 * 60_000;
  const UPDATE_CHECK_GAP_MS = 1_000;
  const UPDATE_CHECK_TTL_MS = 15 * 60_000;
  let wakeUpdateWorker: (() => void) | null = null;
  let updateWorkerActive = false;
  let manualUpdateDrain: Promise<void> | null = null;

  function wakeUpdateWorkerIfIdle(): void {
    wakeUpdateWorker?.();
    wakeUpdateWorker = null;
  }

  function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      const onAbort = () => done();
      function done() {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve();
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  function waitForUpdateWork(signal: AbortSignal, timeoutMs: number): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(done, timeoutMs);
      const onAbort = () => done();
      const previousWake = wakeUpdateWorker;
      function done() {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        if (wakeUpdateWorker === done) wakeUpdateWorker = previousWake;
        resolve();
      }
      wakeUpdateWorker = done;
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  function enqueueUpdateCheck(pluginId: string): Promise<UpdateResult> {
    const existing = updateTasks.get(pluginId);
    if (existing) return existing.promise;
    let resolveTask!: (result: UpdateResult) => void;
    let rejectTask!: (error: unknown) => void;
    const promise = new Promise<UpdateResult>((resolve, reject) => {
      resolveTask = resolve;
      rejectTask = reject;
    });
    // Background refreshes normally have no RPC waiter. Keep a rejection
    // from plugin shutdown from becoming an unhandled promise rejection while
    // still returning the same promise to explicit callers.
    void promise.catch(() => {});
    updateTasks.set(pluginId, { promise, resolve: resolveTask, reject: rejectTask });
    if (!queuedUpdateIds.has(pluginId)) {
      queuedUpdateIds.add(pluginId);
      updateQueue.push(pluginId);
      wakeUpdateWorkerIfIdle();
    }
    return promise;
  }

  function duePluginIds(): string[] {
    const now = Date.now();
    return store.listPlugins()
      .filter((plugin) => {
        const cached = updateCache.get(plugin.id);
        return !cached || now - cached.checkedAt >= UPDATE_CHECK_TTL_MS;
      })
      .map((plugin) => plugin.id);
  }

  function invalidateUpdateCheck(pluginId: string): void {
    updateGenerations.set(pluginId, (updateGenerations.get(pluginId) ?? 0) + 1);
    updateCache.delete(pluginId);
    const task = updateTasks.get(pluginId);
    if (task) {
      task.reject(new Error(`update check invalidated for ${pluginId}`));
      if (updateTasks.get(pluginId) === task) updateTasks.delete(pluginId);
    }
    queuedUpdateIds.delete(pluginId);
    for (let index = updateQueue.length - 1; index >= 0; index -= 1) {
      if (updateQueue[index] === pluginId) updateQueue.splice(index, 1);
    }
  }

  // Provider redirects have no BB browser session. OAuth state and PKCE, not
  // route authentication, authorize this one-use callback.
  bb.http.route("GET", "/oauth/callback", async (context) => {
    const url = new URL(context.req.url);
    const pluginId = url.searchParams.get("pluginId");
    const serverId = url.searchParams.get("serverId");
    if (!pluginId || !serverId) return new Response("Missing Agent Plugins OAuth callback context", { status: 400 });
    try {
      await withDeferredOAuthPersistence(() => gateway.finishAuth(pluginId, serverId, url.searchParams));
      await publishChanged({ kind: "oauth", id: pluginId, serverId });
      return new Response("<p>Authentication completed. You can close this window.</p>", { headers: { "content-type": "text/html; charset=utf-8" } });
    } catch (e) {
      bb.log.warn(`[agent-plugins] OAuth callback failed for ${serverId}: ${errorText(e)}`);
      return new Response("<p>Authentication failed. Return to BB and try again.</p>", { status: 400, headers: { "content-type": "text/html; charset=utf-8" } });
    }
  }, { auth: "none" });

  async function approveServer(id: string, serverId: string): Promise<void> {
    const p = store.getPlugin(id) ?? store.getPluginByName(id);
    if (!p) throw new Error(`not found: ${id}`);
    const srv = store.listMcpServers(p.id).find((s) => s.serverId === serverId);
    if (!srv) throw new Error(`server not found: ${serverId}`);
    if (srv.enabled !== 1) throw new Error(`Enable MCP server ${serverId} before approving it`);

    let cfg: Record<string, unknown>;
    try {
      cfg = JSON.parse(srv.configJson) as Record<string, unknown>;
    } catch (e) {
      throw new Error(`Cannot approve invalid server ${serverId}: ${errorText(e)}`);
    }
    const validation = validateMcpServer(serverId, cfg);
    if (!validation.valid) throw new Error(`Cannot approve invalid server ${serverId}: ${validation.errors.join("; ")}`);
    store.transaction(() => {
      store.upsertMcpServer({ ...srv, approved: 1, status: "idle", lastError: null });
      if (p.approval === "pending" || p.status === "needs-approval") {
        store.upsertPlugin({ ...p, status: "active", approval: "approved", updatedAt: Date.now() } as import("./src/types.js").PluginRecord);
      }
    });

    // Approval is durable even when the first connection attempt fails. The
    // gateway records that failure and can retry on a later tools request.
    await gateway.closeServer(p.id, serverId);
    try {
      await gateway.startServer(p.id, serverId);
    } catch (e) {
      const message = errorText(e);
      const failed = store.listMcpServers(p.id).find((s) => s.serverId === serverId);
      // The gateway has already persisted `needs-auth` when the official SDK
      // starts an OAuth flow. Preserve that state so the UI can offer
      // Authenticate instead of turning a normal consent step into a retry
      // error.
      if (failed && failed.status !== "needs-auth") store.upsertMcpServer({ ...failed, status: "error", lastError: message });
      bb.log.warn(`[agent-plugins] approve start failed for ${serverId}: ${message}`);
    }
    await publishChanged({ kind: "approve", id: p.id, serverId });
  }

  async function pathExists(filePath: string): Promise<boolean> {
    try {
      await fsp.stat(filePath);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw e;
    }
  }

  async function setSkillEnabled(id: string, skillName: string, enabled: boolean) {
    const p = store.getPlugin(id) ?? store.getPluginByName(id);
    if (!p) throw new Error(`not found: ${id}`);
    const skill = store.listSkills(p.id).find((s) => s.skillName === skillName);
    if (!skill) throw new Error(`skill not found: ${skillName}`);

    if (!enabled) {
      if (skill.materializedPath) {
        const removed = await unmaterializeSkill({ installId: p.id, skillName, dataDir: await getDataDir() });
        if (!removed && await pathExists(skill.materializedPath)) {
          throw new Error(`Cannot disable skill ${skillName}: it was modified outside Agent Plugins. Resolve the conflict before disabling it.`);
        }
      }
      store.upsertSkill({
        ...skill,
        enabled: 0,
        materializedPath: null,
        status: "skipped",
        lastError: skill.status === "active" ? null : skill.lastError,
      });
    } else {
      const result = await materializeSkill({
        installId: p.id,
        pluginName: p.name,
        skillName,
        srcDir: path.join(p.pluginRoot, skill.skillDir),
        dataDir: await getDataDir(),
        specVersion: p.specVersion,
      });
      store.upsertSkill({
        ...skill,
        enabled: 1,
        materializedPath: result.materializedPath,
        status: result.status,
        lastError: result.error,
      });
    }

    const updated = store.listSkills(p.id).find((s) => s.skillName === skillName);
    if (!updated) throw new Error(`skill disappeared while updating: ${skillName}`);
    await publishChanged({ kind: "skill-toggle", id: p.id, skillName, enabled });
    return { enabled: updated.enabled === 1, status: updated.status, lastError: updated.lastError };
  }

  async function setMcpEnabled(id: string, serverId: string, enabled: boolean) {
    const p = store.getPlugin(id) ?? store.getPluginByName(id);
    if (!p) throw new Error(`not found: ${id}`);
    const srv = store.listMcpServers(p.id).find((s) => s.serverId === serverId);
    if (!srv) throw new Error(`server not found: ${serverId}`);

    if (!enabled) {
      store.upsertMcpServer({ ...srv, enabled: 0, status: "disabled", lastError: null });
      await gateway.closeServer(p.id, serverId);
    } else {
      let cfg: Record<string, unknown>;
      try {
        cfg = JSON.parse(srv.configJson) as Record<string, unknown>;
      } catch (e) {
        throw new Error(`Cannot enable invalid server ${serverId}: ${errorText(e)}`);
      }
      const validation = validateMcpServer(serverId, cfg);
      if (!validation.valid) throw new Error(`Cannot enable invalid server ${serverId}: ${validation.errors.join("; ")}`);
      store.upsertMcpServer({ ...srv, enabled: 1, status: "idle", lastError: null });
      if (srv.approved === 1) {
        try {
          await gateway.startServer(p.id, serverId);
        } catch (e) {
          const message = errorText(e);
          const failed = store.listMcpServers(p.id).find((s) => s.serverId === serverId);
          if (failed && failed.status !== "needs-auth") store.upsertMcpServer({ ...failed, status: "error", lastError: message });
          bb.log.warn(`[agent-plugins] enable start failed for ${serverId}: ${message}`);
        }
      }
    }

    const updated = store.listMcpServers(p.id).find((s) => s.serverId === serverId);
    if (!updated) throw new Error(`server disappeared while updating: ${serverId}`);
    await publishChanged({ kind: "mcp-toggle", id: p.id, serverId, enabled });
    return { enabled: updated.enabled === 1, status: updated.status, lastError: updated.lastError };
  }

  function redactMcpConfigJson(raw: string): string {
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      const redacted: Record<string, unknown> = { ...obj };
      if (obj.headers && typeof obj.headers === "object") {
        const h: Record<string, string> = {};
        for (const k of Object.keys(obj.headers as Record<string, unknown>)) h[k] = "***";
        redacted.headers = h;
      }
      if (obj.env && typeof obj.env === "object") {
        const e: Record<string, string> = {};
        for (const k of Object.keys(obj.env as Record<string, unknown>)) e[k] = "***";
        redacted.env = e;
      }
      return JSON.stringify(redacted);
    } catch { return raw; }
  }

  const buildSnapshot = async () => {
    const s = store.snapshot();
    let dd: string | null = null;
    try { dd = await getDataDir(); } catch {}
    // Redact sensitive config for snapshot (headers/env values)
    const skills = s.skills.map((skill) => ({ ...skill, enabled: skill.enabled === 1 }));
    const redactedMcp = await Promise.all(s.mcpServers.map(async (m) => {
      let authStatus = "not-applicable";
      if (m.type !== "stdio") {
        try { authStatus = await gateway.authStatus(m.pluginId, m.serverId); }
        catch { authStatus = "unknown"; }
      }
      return { ...m, enabled: m.enabled === 1, authStatus, configJson: redactMcpConfigJson(m.configJson) };
    }));
    const installedIds = new Set(s.plugins.map((plugin) => plugin.id));
    const updates = [...updateCache.values()].filter((update) => installedIds.has(update.id));
    return { plugins: s.plugins as unknown as Record<string, unknown>[], skills: skills as unknown as Record<string, unknown>[], mcpServers: redactedMcp as unknown as Record<string, unknown>[], updates, dataDir: dd };
  };

  // Static bridge
  bb.agents.registerTool({
    name: "agent_plugins_list_tools",
    description: "Search MCP tools exposed by installed Agent Plugins (provider-neutral bridge). Returns compact entries (opaqueId, server, name, one-line summary) without input schemas, plus per-server tool counts.",
    instructions: "Search with a query (e.g. {\"query\":\"slack search messages\"}) and/or serverId instead of listing everything; page with offset. Then call agent_plugins_describe_tool for the input schema of the tools you pick before calling them.",
    presentation: { label: { pending: "Searching Agent Plugins tools", completed: "Tools found" } },
    parameters: z.object({
      query: z.string().optional().describe("Words to match against tool name, server, and description. Omit to list in catalog order."),
      serverId: z.string().optional().describe("Only tools from this MCP server (see `servers` in the result)."),
      limit: z.number().int().min(1).max(MAX_TOOL_SEARCH_LIMIT).optional().describe(`Max tools to return (default ${DEFAULT_TOOL_SEARCH_LIMIT}).`),
      offset: z.number().int().min(0).optional().describe("Skip this many matches, for paging."),
    }).strict(),
    async execute(input) { return JSON.stringify(searchTools(await gateway.listTools(), input), null, 2); },
  });
  bb.agents.registerTool({
    name: "agent_plugins_describe_tool",
    description: "Get full definitions, including input schemas, for Agent Plugin MCP tools by opaque ID.",
    instructions: "Pass opaqueIds returned by agent_plugins_list_tools; read inputSchema before calling agent_plugins_call.",
    presentation: { label: { pending: "Describing Agent Plugins tools", completed: "Tools described" } },
    parameters: z.object({ opaqueIds: z.array(z.string().min(1)).min(1).max(MAX_DESCRIBE_TOOLS) }).strict(),
    async execute(input) { return JSON.stringify(describeTools(await gateway.listTools(), input.opaqueIds), null, 2); },
  });
  bb.agents.registerTool({
    name: "agent_plugins_call",
    description: "Call one Agent Plugin MCP tool by opaque ID through the static bridge.",
    instructions: "Use opaqueId exactly as returned by agent_plugins_list_tools or agent_plugins_describe_tool; do not invent tool names.",
    presentation: { label: { pending: "Calling Agent Plugin tool", completed: "Tool completed" } },
    parameters: z.object({ opaqueId: z.string().min(1), args: jsonRecordSchema.default({}) }).strict(),
    async execute(input, ctx) {
      try { return JSON.stringify(await gateway.call(input.opaqueId, input.args as Record<string, unknown>, ctx.signal), null, 2); }
      catch (e) { return JSON.stringify({ isError: true, error: errorText(e) }); }
    },
  });
  bb.agents.registerTool({
    name: "agent_plugins_list_prompts",
    description: "List MCP prompts exposed by installed Agent Plugins.",
    instructions: "Call agent_plugins_list_prompts first to discover opaque prompt IDs before calling agent_plugins_get_prompt.",
    presentation: { label: { pending: "Listing Agent Plugins prompts", completed: "Prompts listed" } },
    parameters: z.object({}).strict(),
    async execute() { return JSON.stringify({ prompts: await gateway.listPrompts() }, null, 2); },
  });
  bb.agents.registerTool({
    name: "agent_plugins_get_prompt",
    description: "Get one Agent Plugin MCP prompt by opaque ID.",
    instructions: "Use opaqueId exactly as returned by agent_plugins_list_prompts; do not invent prompt names.",
    presentation: { label: { pending: "Getting Agent Plugins prompt", completed: "Prompt returned" } },
    parameters: z.object({ opaqueId: z.string().min(1), args: jsonRecordSchema.default({}) }).strict(),
    async execute(input, ctx) { return JSON.stringify(await gateway.getPrompt(input.opaqueId, input.args as Record<string, unknown>, ctx.signal), null, 2); },
  });
  bb.agents.registerTool({
    name: "agent_plugins_list_resources",
    description: "List MCP resources and resource templates exposed by installed Agent Plugins.",
    instructions: "Call agent_plugins_list_resources first to discover opaque resource IDs before calling agent_plugins_read_resource.",
    presentation: { label: { pending: "Listing Agent Plugins resources", completed: "Resources listed" } },
    parameters: z.object({}).strict(),
    async execute() { return JSON.stringify({ resources: await gateway.listResources(), resourceTemplates: await gateway.listResourceTemplates() }, null, 2); },
  });
  bb.agents.registerTool({
    name: "agent_plugins_read_resource",
    description: "Read one Agent Plugin MCP resource by opaque ID.",
    instructions: "Use opaqueId exactly as returned by agent_plugins_list_resources; do not invent resource URIs.",
    presentation: { label: { pending: "Reading Agent Plugins resource", completed: "Resource returned" } },
    parameters: z.object({ opaqueId: z.string().min(1) }).strict(),
    async execute(input, ctx) { return JSON.stringify(await gateway.readResource(input.opaqueId, ctx.signal), null, 2); },
  });
  bb.agents.configure(() => ({
    tools: ["agent_plugins_list_tools", "agent_plugins_describe_tool", "agent_plugins_call", "agent_plugins_list_prompts", "agent_plugins_get_prompt", "agent_plugins_list_resources", "agent_plugins_read_resource"],
    skills: [],
    instructions: "Agent Plugins bridge ready — search MCP tools with agent_plugins_list_tools({query}), get input schemas with agent_plugins_describe_tool, then call with agent_plugins_call.",
  }));

  // -------------------------------------------------------------------------
  // Core install logic — transactional staging → validation → atomic activation
  // -------------------------------------------------------------------------
  async function doInstall(sourceInput: string, tagPrefix?: string, existing?: PluginRecord): Promise<{ id: string; name: string | null; version: string | null }> {
    const dd = await getDataDir();
    const parsed = parseSource(sourceInput, tagPrefix);
    const lockKey = existing ? `plugin:${existing.id}` : parsed.normalized;
    if (installLocks.has(lockKey)) throw new Error(`An install for ${lockKey} is already running — please wait for it to finish. If it seems stuck, run bb plugin reload agent-plugins to clear it.`);
    installLocks.add(lockKey);
    let fetchRes: { stagingPath: string; resolved: string; contentHash: string } | null = null;
    let pluginRoot: string | null = null;
    let installId: string | null = null;
    let pluginDataPath: string | null = null;
    let cleanupStaging = true;
    let stagingPath: string | null = null;
    const materializedSkillNames: string[] = [];
    const previousSkills = existing ? store.listSkills(existing.id) : [];
    const previousServers = existing ? store.listMcpServers(existing.id) : [];
    const previousSkillByName = new Map(previousSkills.map((skill) => [skill.skillName, skill]));
    const previousServerById = new Map(previousServers.map((server) => [server.serverId, server]));
    try {
      const stagingBase = path.join(dd, "plugins", "agent-plugins", "staging");
      await ensureDir(stagingBase);
      fetchRes = await fetchSource(parsed, stagingBase);
      stagingPath = fetchRes.stagingPath;
      // Validate manifest
      const pluginJsonPath = path.join(stagingPath!, "plugin.json");
      let manifestRaw: unknown;
      try { manifestRaw = await readJsonLimited(pluginJsonPath); } catch (e) { throw new Error(`plugin.json missing or invalid: ${errorText(e)}`); }
      const mRes = validateManifest(manifestRaw);
      if (mRes.fatal) throw new Error(`plugin.json invalid: ${mRes.errors.join("; ")}${mRes.warnings.length ? ` (warnings: ${mRes.warnings.join("; ")})` : ""}`);
      const name = mRes.name!;
      const specVersion = mRes.specVersion!;
      // Check duplicate name. Updates must keep the installed identity stable;
      // a source that changes its manifest name is a new plugin, not an update.
      const existingByName = store.getPluginByName(name);
      if (existing && name !== existing.name) throw new Error(`plugin name changed from ${existing.name} to ${name}; install it as a new plugin instead`);
      if (existingByName && (!existing || existingByName.id !== existing.id)) throw new Error(`plugin already installed as ${existingByName.id} (name: ${name}); remove or update instead`);

      // Content hash for generation
      const contentHash = await hashDirectory(stagingPath!);

      // Determine persistent paths. Updates keep the plugin id and data path,
      // but activate a fresh generation so the old tree remains recoverable
      // until the new database state is committed.
      installId = existing?.id ?? randomId();
      const pluginsRootBase = path.join(dd, "plugins", "agent-plugins", "plugins");
      const dataBase = path.join(dd, "plugins", "agent-plugins", "data");
      const nextGen = existing ? existing.activeGen + 1 : 1;
      pluginRoot = path.join(pluginsRootBase, installId, `v${nextGen}`);
      const pluginData = existing?.pluginData ?? path.join(dataBase, installId);
      pluginDataPath = pluginData;
      await ensureDir(path.dirname(pluginRoot));
      await ensureDir(pluginData);

      // Discover skills
      const skillsRootInStaging = path.join(stagingPath!, "skills");
      const discoveredSkills: { dirName: string; srcDir: string; frontmatter: unknown; bodyHash: string; valid: boolean; errors: string[] }[] = [];
      let skillsDisabled = false;
      try {
        const stat = await fsp.stat(skillsRootInStaging);
        if (!stat.isDirectory()) throw new Error("skills is not directory");
        const entries = await fsp.readdir(skillsRootInStaging, { withFileTypes: true });
        if (entries.length > LIMITS.maxSkillCount) throw new Error(`too many skills: ${entries.length} > ${LIMITS.maxSkillCount}`);
        for (const e of entries) {
          if (!e.isDirectory()) continue;
          const dirName = e.name;
          const srcDir = path.join(skillsRootInStaging, dirName);
          const skillMdPath = path.join(srcDir, "SKILL.md");
          let valid = true; let errors: string[] = []; let frontmatter: unknown = null; let bodyHash = "";
          try {
            const text = await fsp.readFile(skillMdPath, "utf8");
            if (text.length > LIMITS.maxSkillMdBytes) throw new Error(`SKILL.md too large`);
            bodyHash = crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
            const fmMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
            if (!fmMatch) { valid = false; errors.push("Missing frontmatter --- block"); }
            else {
              try { frontmatter = yaml.load(fmMatch[1]); } catch (ye) { valid = false; errors.push(`YAML parse error: ${errorText(ye)}`); }
              if (frontmatter) {
                const v = validateSkillFrontmatter(frontmatter, dirName);
                if (!v.valid) { valid = false; errors.push(...v.errors); }
              }
            }
          } catch (err) {
            valid = false; errors.push(errorText(err));
          }
          discoveredSkills.push({ dirName, srcDir, frontmatter, bodyHash, valid, errors });
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          // No skills — not an error
        } else {
          // Per spec: bad skills root → disable skills only, not fatal
          skillsDisabled = true;
          bb.log.warn(`[agent-plugins] skills disabled for ${name}: ${errorText(err)}`);
        }
      }

      // Validate MCP envelope + per-server
      const mcpJsonPath = path.join(stagingPath!, "mcp.json");
      let mcpServers: { id: string; raw: unknown; valid: boolean; errors: string[]; type: string | null }[] = [];
      try {
        const hasMcp = await fsp.stat(mcpJsonPath).then(() => true).catch(() => false);
        if (hasMcp) {
          const mcpRaw = await readJsonLimited(mcpJsonPath);
          const envelope = validateMcpEnvelope(mcpRaw, specVersion);
          if (!envelope.valid) {
            bb.log.warn(`[agent-plugins] mcp disabled for ${name}: ${envelope.envelopeErrors.join("; ")}`);
          } else {
            if (Object.keys(envelope.servers).length > LIMITS.maxMcpServerCount) throw new Error(`too many mcp servers`);
            for (const [sid, raw] of Object.entries(envelope.servers)) {
              const r = validateMcpServer(sid, raw);
              mcpServers.push({
                id: sid,
                raw,
                valid: r.valid,
                errors: r.errors,
                type: r.type,
              });
            }
          }
        }
      } catch (err) {
        bb.log.warn(`[agent-plugins] mcp disabled for ${name}: ${errorText(err)}`);
      }

      const updatedMcpServers: McpServerRecord[] = mcpServers.map((srv) => {
        const previous = previousServerById.get(srv.id);
        const unchanged = previous !== undefined && srv.valid && sameMcpConfig(previous, srv.type ?? "stdio", srv.raw);
        const enabled = previous?.enabled ?? 1;
        const approved = unchanged ? previous!.approved : 0;
        const status = !srv.valid
          ? "error"
          : enabled !== 1
            ? "disabled"
            : approved === 1
              ? (unchanged && previous?.status === "needs-auth" ? "needs-auth" : "idle")
              : "needs-approval";
        return {
          pluginId: installId!,
          serverId: srv.id,
          type: (srv.type as McpServerRecord["type"]) ?? "stdio",
          configJson: JSON.stringify(srv.raw),
          status,
          lastError: srv.valid ? null : srv.errors.join("; "),
          approved,
          enabled,
        };
      });

      // Atomic promotion: move staging to pluginRoot
      await ensureDir(path.dirname(pluginRoot));
      await atomicRename(stagingPath!, pluginRoot!);
      cleanupStaging = false; // now owned

      // Materialize skills (full-tree, owned, collision-safe)
      const skillResults: { name: string; status: string; error: string | null; materializedPath: string | null }[] = [];
      if (!skillsDisabled) {
        for (const s of discoveredSkills) {
          if (!s.valid) {
            skillResults.push({ name: s.dirName, status: "skipped", error: s.errors.join("; "), materializedPath: null });
            continue;
          }
          const previous = previousSkillByName.get(s.dirName);
          if (previous?.enabled === 0) {
            skillResults.push({ name: s.dirName, status: "skipped", error: null, materializedPath: null });
            continue;
          }
          const res = await materializeSkill({ installId: installId!, pluginName: name, skillName: s.dirName, srcDir: path.join(pluginRoot!, "skills", s.dirName), dataDir: dd, specVersion });
          skillResults.push({ name: s.dirName, status: res.status, error: res.error, materializedPath: res.materializedPath });
          if (res.materializedPath) materializedSkillNames.push(s.dirName);
        }
      }

      const discoveredSkillNames = skillsDisabled && existing
        ? new Set(previousSkills.map((skill) => skill.skillName))
        : new Set(discoveredSkills.map((skill) => skill.dirName));
      const removedSkillConflicts: PluginSkillRecord[] = [];
      for (const previous of previousSkills) {
        if (discoveredSkillNames.has(previous.skillName)) continue;
        if (previous.materializedPath) {
          const removed = await unmaterializeSkill({ installId: installId!, skillName: previous.skillName, dataDir: dd });
          if (!removed && await pathExists(previous.materializedPath)) {
            removedSkillConflicts.push({
              ...previous,
              status: "conflicted",
              lastError: `Skill /${previous.skillName} was removed by the updated plugin but local files were modified; it was left in place.`,
            });
          }
        }
      }

      const updatedServerIds = new Set(updatedMcpServers.map((server) => server.serverId));
      const removedServerIds = previousServers.filter((server) => !updatedServerIds.has(server.serverId)).map((server) => server.serverId);
      const changedServerIds = updatedMcpServers
        .filter((server) => {
          const previous = previousServerById.get(server.serverId);
          return previous !== undefined && !sameMcpConfig(previous, server.type, JSON.parse(server.configJson));
        })
        .map((server) => server.serverId);

      // DB commit — generations + plugins + skills + mcp
      const now = Date.now();
      const pluginVersion = (mRes.manifest as { version?: string } | null)?.version ?? null;
      const pluginDescription = mRes.description ?? null;
      const hasPendingApproval = updatedMcpServers.some((server) => server.status === "needs-approval");
      const pluginStatus: "active" | "needs-approval" = hasPendingApproval ? "needs-approval" : "active";
      const pluginApproval: "pending" | "approved" = hasPendingApproval ? "pending" : "approved";
      const pluginRecord: PluginRecord = {
        id: installId!,
        name,
        version: typeof pluginVersion === "string" ? pluginVersion : null,
        description: typeof pluginDescription === "string" ? pluginDescription : null,
        specVersion,
        sourceType: parsed.type,
        sourceIntent: parsed.intent,
        sourceResolved: fetchRes!.resolved,
        sourceRef: parsed.gitRef ?? parsed.npmSpec ?? null,
        tagPrefix: parsed.tagPrefix ?? null,
        pluginRoot: pluginRoot!,
        pluginData,
        activeGen: existing ? existing.activeGen + 1 : 1,
        status: pluginStatus,
        approval: pluginApproval,
        lastError: null,
        contentHash,
        installedAt: existing?.installedAt ?? now,
        updatedAt: now,
      };
      store.transaction(() => {
        store.upsertPlugin(pluginRecord);
        store.db.prepare(`INSERT OR REPLACE INTO generations (pluginId, gen, pluginRoot, contentHash, createdAt) VALUES (?,?,?,?,?)`).run(installId!, pluginRecord.activeGen, pluginRoot!, contentHash, now);
        if (existing) {
          store.db.prepare(`DELETE FROM generations WHERE pluginId = ? AND gen < ?`).run(installId!, pluginRecord.activeGen);
        }
        for (const s of discoveredSkills) {
          const mr = skillResults.find(r => r.name === s.dirName);
          const previous = previousSkillByName.get(s.dirName);
          store.upsertSkill({
            pluginId: installId!,
            skillName: s.dirName,
            skillDir: `skills/${s.dirName}`,
            frontmatterJson: JSON.stringify(s.frontmatter ?? {}),
            bodyHash: s.bodyHash,
            materializedPath: mr?.materializedPath ?? null,
            status: (mr?.status as unknown as "active" | "conflicted" | "skipped" | "error") ?? (s.valid ? "active" : "skipped"),
            lastError: mr?.error ?? (s.valid ? null : s.errors.join("; ")),
            enabled: previous?.enabled ?? 1,
          });
        }
        for (const server of updatedMcpServers) store.upsertMcpServer(server);
        for (const previous of previousSkills) {
          if (discoveredSkillNames.has(previous.skillName)) continue;
          const conflict = removedSkillConflicts.find((skill) => skill.skillName === previous.skillName);
          if (conflict) store.upsertSkill(conflict);
          else store.deleteSkill(installId!, previous.skillName);
        }
        for (const serverId of removedServerIds) store.deleteMcpServer(installId!, serverId);
      });

      // Close old connections only after the new generation and DB state are
      // committed. If an update fails during validation or promotion, the old
      // generation remains fully usable. We deliberately do not reconnect
      // here: updates must not synchronously trigger an OAuth flow or hang BB.
      if (existing) {
        for (const server of previousServers) {
          await gateway.closeServer(existing.id, server.serverId).catch((error) => {
            bb.log.warn(`[agent-plugins] close after update ${server.serverId}: ${errorText(error)}`);
          });
        }
      }
      if (existing?.pluginRoot && existing.pluginRoot !== pluginRoot) await rimraf(existing.pluginRoot).catch(() => {});
      for (const serverId of [...removedServerIds, ...changedServerIds]) {
        await gateway.resetServer(installId!, serverId).catch((error) => {
          bb.log.warn(`[agent-plugins] reset updated server ${serverId}: ${errorText(error)}`);
        });
        await deleteOAuthCredentials(installId!, serverId).catch((error) => {
          bb.log.warn(`[agent-plugins] OAuth credentials reset for updated server ${serverId}: ${errorText(error)}`);
        });
      }

      invalidateUpdateCheck(installId!);
      await publishChanged({ kind: existing ? "update" : "install", id: installId! });
      return { id: installId!, name, version: typeof pluginVersion === "string" ? pluginVersion : null };
    } catch (e) {
      // Transactional cleanup: remove promoted pluginRoot and any materialized skills if DB failed
      try {
        if (pluginRoot) {
          await rimraf(pluginRoot).catch(() => {});
          if (!existing) await rimraf(path.dirname(pluginRoot)).catch(() => {});
        }
      } catch {}
      if (installId && !existing) {
        for (const skillName of materializedSkillNames) {
          await unmaterializeSkill({ installId, skillName, dataDir: dd }).catch(() => {});
        }
      }
      if (pluginDataPath && !existing) await rimraf(pluginDataPath).catch(() => {});
      throw e;
    } finally {
      installLocks.delete(lockKey);
      if (cleanupStaging && fetchRes) await rimraf(fetchRes.stagingPath).catch(() => {});
    }
  }

  // RPC registrations
  async function checkPluginUpdate(plugin: PluginRecord) {
    const checkedAt = Date.now();
    try {
      const parsed = parseSource(plugin.sourceIntent, plugin.tagPrefix ?? undefined);
      const probe = await probeSource(parsed);
      return {
        id: plugin.id,
        currentVersion: plugin.version,
        latestVersion: probe.version,
        available: plugin.sourceResolved !== probe.resolved,
        checkedAt,
        error: null,
      };
    } catch (error) {
      return {
        id: plugin.id,
        currentVersion: plugin.version,
        latestVersion: null,
        available: false,
        checkedAt,
        error: errorText(error),
      };
    }
  }

  async function processNextUpdate(signal: AbortSignal): Promise<void> {
    const id = updateQueue.shift();
    if (!id) return;
    queuedUpdateIds.delete(id);
    const task = updateTasks.get(id);
    if (!task) return;
    const generation = updateGenerations.get(id) ?? 0;
    try {
      if (signal.aborted) throw new Error("update checker stopped");
      const plugin = store.getPlugin(id);
      if (!plugin) throw new Error(`not found: ${id}`);
      const result = await checkPluginUpdate(plugin);
      if ((updateGenerations.get(id) ?? 0) !== generation || updateTasks.get(id) !== task) return;
      updateCache.set(id, result);
      task.resolve(result);
      await publishChanged({ kind: "update-check", id });
    } catch (error) {
      task.reject(error);
    } finally {
      if (updateTasks.get(id) === task) updateTasks.delete(id);
    }
  }

  async function runUpdateChecker(signal: AbortSignal): Promise<void> {
    updateWorkerActive = true;
    try {
      for (const id of duePluginIds()) enqueueUpdateCheck(id);
      while (!signal.aborted) {
        if (updateQueue.length > 0) {
          await processNextUpdate(signal);
          await sleepWithSignal(UPDATE_CHECK_GAP_MS, signal);
          continue;
        }
        await waitForUpdateWork(signal, UPDATE_CHECK_INTERVAL_MS);
        if (!signal.aborted) for (const id of duePluginIds()) enqueueUpdateCheck(id);
      }
    } finally {
      updateWorkerActive = false;
      const stopped = new Error("update checker stopped");
      updateQueue.length = 0;
      queuedUpdateIds.clear();
      for (const task of updateTasks.values()) task.reject(stopped);
      updateTasks.clear();
    }
  }

  async function drainUpdateQueue(): Promise<void> {
    if (manualUpdateDrain) return manualUpdateDrain;
    const drain = (async () => {
      const signal = new AbortController().signal;
      while (updateQueue.length > 0) {
        await processNextUpdate(signal);
        await sleepWithSignal(UPDATE_CHECK_GAP_MS, signal);
      }
    })();
    manualUpdateDrain = drain;
    try { await drain; }
    finally { if (manualUpdateDrain === drain) manualUpdateDrain = null; }
  }

  async function requestedUpdateResults(plugins: PluginRecord[], refresh: boolean): Promise<UpdateResult[]> {
    const waits: Promise<UpdateResult>[] = [];
    for (const plugin of plugins) {
      const cached = updateCache.get(plugin.id);
      const stale = !cached || Date.now() - cached.checkedAt >= UPDATE_CHECK_TTL_MS;
      if (refresh || stale) waits.push(enqueueUpdateCheck(plugin.id));
    }
    if (refresh && waits.length > 0) {
      if (!updateWorkerActive) {
        await drainUpdateQueue();
      } else {
        await Promise.all(waits);
      }
    }
    return plugins
      .map((plugin) => updateCache.get(plugin.id))
      .filter((update): update is UpdateResult => update !== undefined);
  }

  bb.background.service("update-checker", {
    start: runUpdateChecker,
  });

  bb.rpc.register(rpcContract, {
    async snapshot() { return await buildSnapshot() as unknown as { plugins: Record<string, unknown>[]; skills: Record<string, unknown>[]; mcpServers: Record<string, unknown>[]; updates: UpdateResult[]; dataDir: string | null }; },
    async listTools() { return { tools: await gateway.listTools() }; },
    async callTool({ opaqueId, args }) { return gateway.call(opaqueId, args as Record<string, unknown>); },
    async listPrompts() { return { prompts: await gateway.listPrompts() }; },
    async getPrompt({ opaqueId, args }) { return gateway.getPrompt(opaqueId, args as Record<string, unknown>); },
    async listResources() { return { resources: await gateway.listResources() }; },
    async listResourceTemplates() { return { resourceTemplates: await gateway.listResourceTemplates() }; },
    async readResource({ opaqueId }) { return gateway.readResource(opaqueId); },
    async complete({ ref, argument }) { return gateway.complete(ref as Record<string, unknown>, argument as Record<string, unknown>); },
    async subscribeResource({ opaqueId }) { await gateway.subscribeResource(opaqueId); return { subscribed: true }; },
    async unsubscribeResource({ opaqueId }) { await gateway.unsubscribeResource(opaqueId); return { unsubscribed: true }; },
    async setLoggingLevel({ level }) { await gateway.setLoggingLevel(level); return { updated: true }; },
    async install({ source, tagPrefix }) { return doInstall(source, tagPrefix); },
    async checkUpdates({ id, refresh }) {
      const plugins = id ? [store.getPlugin(id) ?? store.getPluginByName(id)].filter((plugin): plugin is PluginRecord => plugin !== undefined) : store.listPlugins();
      if (id && plugins.length === 0) throw new Error(`not found: ${id}`);
      // Keep the legacy single-plugin call synchronous for existing clients;
      // the page-wide call is the throttled background path.
      return { updates: await requestedUpdateResults(plugins, refresh === true || Boolean(id)) };
    },
    async update({ id }) {
      const plugin = store.getPlugin(id) ?? store.getPluginByName(id);
      if (!plugin) throw new Error(`not found: ${id}`);
      return doInstall(plugin.sourceIntent, plugin.tagPrefix ?? undefined, plugin);
    },
    async remove({ id, purgeData }) {
      const p = store.getPlugin(id) ?? store.getPluginByName(id);
      if (!p) return { deleted: false };
      // Unmaterialize owned skills
      const dd = await getDataDir();
      const skills = store.listSkills(p.id);
      for (const s of skills) {
        if (s.materializedPath) {
          try { await unmaterializeSkill({ installId: p.id, skillName: s.skillName, dataDir: dd }); } catch (e) { bb.log.warn(`[agent-plugins] unmaterialize ${s.skillName}: ${errorText(e)}`); }
        }
      }
      // Close MCP servers
      for (const srv of store.listMcpServers(p.id)) {
        try { await gateway.closeServer(p.id, srv.serverId); } catch {}
        await deleteOAuthCredentials(p.id, srv.serverId);
      }
      if (purgeData) await rimraf(p.pluginData).catch(() => {});
      else bb.log.info(`[agent-plugins] preserve pluginData ${p.pluginData} (use --purge-data to delete)`);
      // Remove pluginRoot generation dir's parent (the installId dir)
      await rimraf(path.dirname(p.pluginRoot)).catch(() => {});
      const deleted = store.deletePlugin(p.id);
      await publishChanged({ kind: "remove", id: p.id });
      return { deleted };
    },
    async refresh({ id }) {
      const p = store.getPlugin(id) ?? store.getPluginByName(id);
      if (!p) throw new Error(`not found: ${id}`);
      // Compatibility endpoint retained for older Agent Plugins clients.
      return { id: p.id, name: p.name };
    },
    async approve({ id, serverId }) {
      await approveServer(id, serverId);
      return { approved: true };
    },
    async setSkillEnabled({ id, skillName, enabled }) {
      return setSkillEnabled(id, skillName, enabled);
    },
    async setMcpEnabled({ id, serverId, enabled }) {
      return setMcpEnabled(id, serverId, enabled);
    },
    async authenticate({ id, serverId }) {
      const p = store.getPlugin(id) ?? store.getPluginByName(id);
      if (!p) throw new Error(`not found: ${id}`);
      const url = await gateway.authUrl(p.id, serverId);
      return { url, status: await gateway.authStatus(p.id, serverId) };
    },
    async reconnect({ id, serverId }) {
      const p = store.getPlugin(id) ?? store.getPluginByName(id);
      if (!p) throw new Error(`not found: ${id}`);
      const url = await gateway.reconnectServer(p.id, serverId);
      const status = await gateway.authStatus(p.id, serverId);
      await publishChanged({ kind: "mcp-reconnect", id: p.id, serverId });
      return { url, status };
    },
    async reauthorize({ id, serverId }) {
      const p = store.getPlugin(id) ?? store.getPluginByName(id);
      if (!p) throw new Error(`not found: ${id}`);
      const result = await withDeferredOAuthPersistence(async () => {
        await gateway.clearAuthentication(p.id, serverId);
        const url = await gateway.authUrl(p.id, serverId);
        return { url, status: await gateway.authStatus(p.id, serverId) };
      });
      await publishChanged({ kind: "mcp-reauthorize", id: p.id, serverId });
      return result;
    },
    async authStatus({ id, serverId }) {
      const p = store.getPlugin(id) ?? store.getPluginByName(id);
      if (!p) throw new Error(`not found: ${id}`);
      return { status: await gateway.authStatus(p.id, serverId) };
    },
    async finishAuthentication({ id, serverId, callbackUrl }) {
      const p = store.getPlugin(id) ?? store.getPluginByName(id);
      if (!p) throw new Error(`not found: ${id}`);
      const expected = oauthCallbackUrl(bb.server.loopbackBaseUrl, bb.pluginId, p.id, serverId);
      const params = validatePastedCallback(callbackUrl, expected);
      await withDeferredOAuthPersistence(() => gateway.finishAuth(p.id, serverId, params));
      await publishChanged({ kind: "oauth", id: p.id, serverId });
      return { authenticated: true };
    },
    async cancelAuthentication({ id, serverId }) {
      const p = store.getPlugin(id) ?? store.getPluginByName(id);
      if (!p) throw new Error(`not found: ${id}`);
      await withDeferredOAuthPersistence(() => gateway.cancelAuthentication(p.id, serverId));
      return { canceled: true };
    },
    async clearAuthentication({ id, serverId }) {
      const p = store.getPlugin(id) ?? store.getPluginByName(id);
      if (!p) throw new Error(`not found: ${id}`);
      await withDeferredOAuthPersistence(() => gateway.clearAuthentication(p.id, serverId));
      return { cleared: true };
    },
    async pickFolder() {
      try {
        const cfg = (await bb.sdk.system.config()) as unknown as { primaryHostId?: string | null };
        let hostId: string | null = cfg.primaryHostId ?? null;
        if (!hostId) {
          try {
            const hosts = await bb.sdk.hosts.list();
            hostId = hosts[0]?.id ?? null;
          } catch {}
        }
        if (!hostId) throw new Error("No host available for folder picker");
        const res = await bb.sdk.hosts.pickFolder({ hostId, clientHostId: hostId });
        const picked = res.path ?? null;
        return { path: typeof picked === "string" ? picked : null };
      } catch (e) {
        throw new Error(`Folder picker failed: ${errorText(e)}`);
      }
    },
  });

  // CLI — delegate to RPC where possible, but install is now real
  bb.cli.register({
    name: "agent-plugins",
    summary: "Install Agent Plugins (skills + MCP) once; flow to every provider",
    commands: [
      { name: "list", summary: "List installed Agent Plugins", usage: "bb agent-plugins list [--json]" },
      { name: "show", summary: "Show one plugin", usage: "bb agent-plugins show <id> [--json]" },
      { name: "install", summary: "Install from path/git/npm", usage: "bb agent-plugins install <path|git:url|npm:spec> [--tag-prefix <p>] [--json]" },
      { name: "outdated", summary: "Check tracked Agent Plugins for updates", usage: "bb agent-plugins outdated [--json]" },
      { name: "update", summary: "Update one installed Agent Plugin", usage: "bb agent-plugins update <id> [--json]" },
      { name: "remove", summary: "Remove a plugin", usage: "bb agent-plugins remove <id> [--purge-data] [--json]" },
      { name: "tools", summary: "List or search MCP tools via bridge", usage: "bb agent-plugins tools [--query <words>] [--server <serverId>] [--limit <n>] [--offset <n>] [--json]" },
      { name: "describe", summary: "Show full MCP tool definitions", usage: "bb agent-plugins describe <opaqueId>… [--json]" },
      { name: "call", summary: "Call an MCP tool by opaqueId", usage: "bb agent-plugins call <opaqueId> <json> [--json]" },
      { name: "prompts", summary: "List MCP prompts via bridge", usage: "bb agent-plugins prompts [--json]" },
      { name: "resources", summary: "List MCP resources via bridge", usage: "bb agent-plugins resources [--json]" },
      { name: "skills", summary: "List materialized skills", usage: "bb agent-plugins skills [--json]" },
      { name: "approve", summary: "Approve an MCP server", usage: "bb agent-plugins approve <id> <serverId> [--json]" },
      { name: "auth", summary: "Start or inspect MCP OAuth", usage: "bb agent-plugins auth <id> <serverId> [--json]" },
    ],
    async run(argv, _ctx) {
      const [cmd = "list", ...rest] = argv;
      const asJson = rest.includes("--json");
      const snap = store.snapshot();
      if (cmd === "list") {
        const out = snap.plugins;
        return { exitCode: 0, stdout: (asJson ? JSON.stringify(out, null, 2) : out.map(p => `${p.id} ${p.name}@${p.specVersion} [${p.status}] ${p.sourceType}:${p.sourceIntent}`).join("\n")) + "\n" };
      }
      if (cmd === "show") {
        const id = rest[0];
        if (!id || id === "--json") return { exitCode: 2, stderr: "Usage: bb agent-plugins show <id> [--json]\n" };
        const p = store.getPlugin(id) ?? store.getPluginByName(id);
        if (!p) return { exitCode: 1, stderr: `not found: ${id}\n` };
        const rawMcp = store.listMcpServers(p.id);
        const redactedMcp = rawMcp.map(m => ({ ...m, configJson: redactMcpConfigJson(m.configJson) }));
        const detail = { plugin: p, skills: store.listSkills(p.id), mcpServers: redactedMcp };
        return { exitCode: 0, stdout: JSON.stringify(detail, null, 2) + "\n" };
      }
      if (cmd === "install") {
        const source = rest[0];
        if (!source || source === "--json") return { exitCode: 2, stderr: "Usage: bb agent-plugins install <path|git:url|npm:spec> [--json]\n" };
        const tagPrefixIdx = rest.indexOf("--tag-prefix");
        const tagPrefix = tagPrefixIdx !== -1 ? rest[tagPrefixIdx + 1] : undefined;
        try {
          const res = await doInstall(source, tagPrefix);
          return { exitCode: 0, stdout: (asJson ? JSON.stringify(res, null, 2) : `Installed ${res.name} as ${res.id}\n`) };
        } catch (e) {
          return { exitCode: 1, stderr: `${errorText(e)}\n` };
        }
      }
      if (cmd === "outdated") {
        const updates = await requestedUpdateResults(snap.plugins, true);
        const available = updates.filter((update) => update.available || update.error);
        return {
          exitCode: available.some((update) => update.error) ? 1 : 0,
          stdout: asJson
            ? JSON.stringify({ updates: available }, null, 2) + "\n"
            : (available.length === 0 ? "All Agent Plugins are up to date.\n" : available.map((update) => `${update.id}: ${update.error ?? "update available"}`).join("\n") + "\n"),
        };
      }
      if (cmd === "update") {
        const id = rest[0];
        if (!id || id === "--json") return { exitCode: 2, stderr: "Usage: bb agent-plugins update <id> [--json]\n" };
        const plugin = store.getPlugin(id) ?? store.getPluginByName(id);
        if (!plugin) return { exitCode: 1, stderr: `not found: ${id}\n` };
        try {
          const result = await doInstall(plugin.sourceIntent, plugin.tagPrefix ?? undefined, plugin);
          return { exitCode: 0, stdout: asJson ? JSON.stringify(result, null, 2) + "\n" : `Updated ${result.name} to ${result.version ?? "the latest source"}\n` };
        } catch (e) {
          return { exitCode: 1, stderr: `${errorText(e)}\n` };
        }
      }
      if (cmd === "remove") {
        const id = rest[0];
        if (!id || id === "--json") return { exitCode: 2, stderr: "Usage: bb agent-plugins remove <id> [--json]\n" };
        const purge = rest.includes("--purge-data");
        const p = store.getPlugin(id) ?? store.getPluginByName(id);
        if (!p) return { exitCode: 1, stderr: `not found: ${id}\n` };
        try {
          const dd = await getDataDir();
          for (const s of store.listSkills(p.id)) if (s.materializedPath) await unmaterializeSkill({ installId: p.id, skillName: s.skillName, dataDir: dd }).catch(() => {});
          for (const srv of store.listMcpServers(p.id)) {
            await gateway.closeServer(p.id, srv.serverId).catch(() => {});
            await deleteOAuthCredentials(p.id, srv.serverId);
          }
          if (purge) await rimraf(p.pluginData).catch(() => {});
          await rimraf(path.dirname(p.pluginRoot)).catch(() => {});
        } catch (e) {
          return { exitCode: 1, stderr: `${errorText(e)}\n` };
        }
        const deleted = store.deletePlugin(p.id);
        await publishChanged({ kind: "remove", id: p.id });
        return { exitCode: deleted ? 0 : 1, stdout: (asJson ? JSON.stringify({ deleted }) : deleted ? `Removed ${id}\n` : `Not found: ${id}\n`) };
      }
      if (cmd === "tools") {
        const flag = (name: string): string | undefined => {
          const idx = rest.indexOf(name);
          return idx >= 0 ? rest[idx + 1] : undefined;
        };
        const query = flag("--query"); const serverId = flag("--server");
        const limit = flag("--limit"); const offset = flag("--offset");
        const tools = await gateway.listTools();
        if (query === undefined && serverId === undefined && limit === undefined && offset === undefined) {
          return { exitCode: 0, stdout: (asJson ? JSON.stringify({ tools }, null, 2) : tools.map((t: CatalogTool) => `${t.opaqueId} — ${t.description} [${t.serverType}]`).join("\n")) + "\n" };
        }
        const result = searchTools(tools, {
          query, serverId,
          limit: limit === undefined ? undefined : Number(limit),
          offset: offset === undefined ? undefined : Number(offset),
        });
        const text = [
          `${result.total} match${result.total === 1 ? "" : "es"}${result.partialMatch ? " (partial)" : ""}; showing ${result.tools.length} from offset ${result.offset}`,
          ...result.tools.map((t) => `${t.opaqueId} — ${t.summary} [${t.serverId}]`),
        ].join("\n");
        return { exitCode: 0, stdout: (asJson ? JSON.stringify(result, null, 2) : text) + "\n" };
      }
      if (cmd === "describe") {
        const ids = rest.filter((arg) => arg !== "--json");
        if (ids.length === 0) return { exitCode: 2, stderr: "Usage: bb agent-plugins describe <opaqueId>… [--json]\n" };
        const result = describeTools(await gateway.listTools(), ids);
        const text = [
          ...result.tools.map((t) => `${t.opaqueId}\n${t.description}\ninputSchema: ${JSON.stringify(t.inputSchema)}`),
          ...result.notFound.map((id) => `Not found: ${id}`),
        ].join("\n\n");
        return { exitCode: result.notFound.length > 0 ? 1 : 0, stdout: (asJson ? JSON.stringify(result, null, 2) : text) + "\n" };
      }
      if (cmd === "call") {
        const opaqueId = rest[0]; const rawArgs = rest[1];
        if (!opaqueId || opaqueId === "--json" || !rawArgs) return { exitCode: 2, stderr: "Usage: bb agent-plugins call <opaqueId> <json> [--json]\n" };
        try {
          const args = JSON.parse(rawArgs) as Record<string, unknown>;
          const result = await gateway.call(opaqueId, args);
          return { exitCode: result.isError ? 1 : 0, stdout: JSON.stringify(result, null, 2) + "\n" };
        } catch (e) { return { exitCode: 2, stderr: `Invalid JSON args: ${errorText(e)}\n` }; }
      }
      if (cmd === "prompts") {
        const prompts = await gateway.listPrompts();
        return { exitCode: 0, stdout: (asJson ? JSON.stringify({ prompts }, null, 2) : prompts.map((p: CatalogPrompt) => `${p.opaqueId} — ${p.description ?? p.name} [${p.serverType}]`).join("\n")) + "\n" };
      }
      if (cmd === "resources") {
        const resources = await gateway.listResources();
        const resourceTemplates = await gateway.listResourceTemplates();
        return { exitCode: 0, stdout: (asJson ? JSON.stringify({ resources, resourceTemplates }, null, 2) : [...resources.map((r: CatalogResource) => `${r.opaqueId} — ${r.uri}`), ...resourceTemplates.map((r: CatalogResourceTemplate) => `${r.opaqueId} — ${r.uriTemplate}`)].join("\n")) + "\n" };
      }
      if (cmd === "skills") {
        return { exitCode: 0, stdout: (asJson ? JSON.stringify(snap.skills, null, 2) : snap.skills.map(s => `${s.skillName} [${s.status}] ${s.pluginId}`).join("\n")) + "\n" };
      }
      if (cmd === "approve") {
        const id = rest[0]; const serverId = rest[1];
        if (!id || !serverId || serverId === "--json") return { exitCode: 2, stderr: "Usage: bb agent-plugins approve <id> <serverId> [--json]\n" };
        try {
          await approveServer(id, serverId);
          return { exitCode: 0, stdout: (asJson ? JSON.stringify({ approved: true }) : `Approved ${serverId}\n`) };
        } catch (e) {
          return { exitCode: 1, stderr: `${errorText(e)}\n` };
        }
      }
      if (cmd === "auth") {
        const id = rest[0]; const serverId = rest[1];
        if (!id || !serverId || serverId === "--json") return { exitCode: 2, stderr: "Usage: bb agent-plugins auth <id> <serverId> [--json]\n" };
        try {
          const p = store.getPlugin(id) ?? store.getPluginByName(id);
          if (!p) throw new Error(`not found: ${id}`);
          const url = await gateway.authUrl(p.id, serverId);
          const status = await gateway.authStatus(p.id, serverId);
          return { exitCode: 0, stdout: asJson ? JSON.stringify({ url, status }, null, 2) + "\n" : `${status}${url ? ` — authorize at ${url}` : ""}\n` };
        } catch (e) { return { exitCode: 1, stderr: `${errorText(e)}\n` }; }
      }
      return { exitCode: 2, stderr: "Usage: bb agent-plugins <list|show|install|outdated|update|remove|tools|describe|call|prompts|resources|skills|approve|auth> …\n" };
    },
  });

  bb.log.info("[agent-plugins] ready");
  bb.onDispose(async () => { await gateway.close().catch(() => {}); bb.log.info("[agent-plugins] disposed"); });
}
