/**
 * Canonical Agent Plugins MCP gateway for BB.
 *
 * The protocol and transports are deliberately delegated to the official MCP
 * client SDK. This class owns only BB concerns: approval/enabled gates,
 * process containment, catalog namespacing, durable lifecycle state, and the
 * UI/agent bridge around an MCP connection.
 */
import * as crypto from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type ClientCapabilities,
  type ClientOptions,
  type OAuthClientProvider,
  type Prompt,
  type Resource,
  type ResourceTemplateType,
  type Tool,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { AgentPluginsStore } from "./store.js";
import { expandPlaceholders, validateMcpServer } from "./loader.js";
import { isWithinRoot } from "./safe-fs.js";
import { McpOAuthProvider } from "./oauth.js";
import type {
  CatalogPrompt,
  CatalogResource,
  CatalogResourceTemplate,
  CatalogTool,
  JsonRecord,
  McpCallResult,
} from "./types.js";
import { optionalMcpCall } from "./mcp-compat.js";

export interface McpRuntime {
  listTools(serverId?: string): Promise<CatalogTool[]>;
  resolveTools(opaqueIds: string[]): Promise<CatalogTool[]>;
  call(opaqueId: string, args: JsonRecord, signal?: AbortSignal): Promise<McpCallResult>;
  listPrompts(): Promise<CatalogPrompt[]>;
  getPrompt(opaqueId: string, args?: JsonRecord, signal?: AbortSignal): Promise<JsonRecord>;
  listResources(): Promise<CatalogResource[]>;
  listResourceTemplates(): Promise<CatalogResourceTemplate[]>;
  readResource(opaqueId: string, signal?: AbortSignal): Promise<JsonRecord>;
  complete(ref: JsonRecord, argument: JsonRecord, signal?: AbortSignal): Promise<JsonRecord>;
  subscribeResource(opaqueId: string, signal?: AbortSignal): Promise<void>;
  unsubscribeResource(opaqueId: string, signal?: AbortSignal): Promise<void>;
  setLoggingLevel(level: string, signal?: AbortSignal): Promise<void>;
  startServer(pluginId: string, serverId: string): Promise<void>;
  stopServer(pluginId: string, serverId: string): Promise<void>;
  status(): Promise<Record<string, string>>;
  authUrl(pluginId: string, serverId: string): Promise<string | null>;
  authStatus(pluginId: string, serverId: string): Promise<"unauthenticated" | "authorizing" | "authenticated">;
  reconnectServer(pluginId: string, serverId: string): Promise<string | null>;
  finishAuth(pluginId: string, serverId: string, params: URLSearchParams): Promise<void>;
  cancelAuthentication(pluginId: string, serverId: string): Promise<void>;
  clearAuthentication(pluginId: string, serverId: string): Promise<void>;
  close(): Promise<void>;
  closeServer(pluginId: string, serverId: string): Promise<void>;
}

export interface McpGatewayOptions {
  onChanged?: () => void | Promise<void>;
  /** Bound the browser callback's authorization-code/token exchange. */
  oauthTimeoutMs?: number;
  /** Bound each HTTP request; leave a small grace period after oauthTimeoutMs by default. */
  requestTimeoutMs?: number;
  oauth?: {
    getProvider(pluginId: string, serverId: string, serverUrl: URL): Promise<McpOAuthProvider>;
  };
  onSampling?: (request: unknown, pluginId: string, serverId: string) => Promise<unknown>;
  onElicitation?: (request: unknown, pluginId: string, serverId: string) => Promise<unknown>;
  onRoots?: (pluginId: string, serverId: string) => Promise<unknown>;
  /** Isolated worker boundary used for local stdio MCP servers. */
  stdioHost?: McpStdioHost;
}

export interface McpStdioConfig {
  key: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface McpStdioCatalog {
  tools: Tool[];
  prompts: Prompt[];
  resources: Resource[];
  resourceTemplates: ResourceTemplateType[];
}

export interface McpStdioHost {
  start(config: McpStdioConfig, signal?: AbortSignal): Promise<McpStdioCatalog>;
  refresh(key: string, signal?: AbortSignal): Promise<McpStdioCatalog>;
  close(key: string, signal?: AbortSignal): Promise<void>;
  callTool(key: string, name: string, args: JsonRecord, toolDefinition?: Tool, signal?: AbortSignal): Promise<unknown>;
  getPrompt(key: string, name: string, args: JsonRecord, signal?: AbortSignal): Promise<unknown>;
  readResource(key: string, uri: string, signal?: AbortSignal): Promise<unknown>;
  complete(key: string, ref: JsonRecord, argument: JsonRecord, signal?: AbortSignal): Promise<unknown>;
  subscribeResource(key: string, uri: string, signal?: AbortSignal): Promise<void>;
  unsubscribeResource(key: string, uri: string, signal?: AbortSignal): Promise<void>;
  setLoggingLevel(key: string, level: string, signal?: AbortSignal): Promise<void>;
  onWorkerExit?(handler: (hostId: string) => void | Promise<void>): () => void;
  onCatalogChanged?(handler: (key: string, kind: "tools" | "prompts" | "resources", error: string | null) => void | Promise<void>): () => void;
  onConnectionChanged?(handler: (key: string, status: "closed" | "error", error: string | null) => void | Promise<void>): () => void;
}

const MCP_CLIENT_INFO = { name: "bb-agent-plugins", version: "0.2.2" };
const CONNECT_TIMEOUT_MS = 15_000;
const OAUTH_TIMEOUT_MS = 15_000;
const FETCH_TIMEOUT_GRACE_MS = 1_000;
const CLOSE_TIMEOUT_MS = 2_000;
const RETRY_AFTER_MS = 5_000;
const CATALOG_TTL_MS = 5 * 60_000;
const CATALOG_CONCURRENCY = 4;

function errorText(e: unknown): string { return e instanceof Error ? e.message : String(e); }
function isOAuthStateMismatch(error: unknown): boolean { return errorText(error) === "MCP OAuth state mismatch"; }
function authorizationFailure(params: URLSearchParams): string {
  const code = params.get("error") ?? "unknown_error";
  const description = params.get("error_description");
  return `MCP authorization failed: ${code}${description ? ` — ${description}` : ""}`;
}
function slug(v: string): string { return v.toLowerCase().replace(/[^a-z0-9_-]+/gu, "_").replace(/^_+|_+$/gu, "") || "item"; }
function shortHash(v: string): string { return crypto.createHash("sha256").update(v).digest("hex").slice(0, 10); }
function keyOf(pluginId: string, serverId: string): string { return `${pluginId}:${serverId}`; }

function exposedId(kind: string, pluginId: string, serverId: string, name: string): string {
  // Keep the original tool-ID hash stable for clients that cached a catalog
  // entry before prompts/resources were added. New capability kinds are
  // namespaced in their hash so identical names cannot collide across views.
  const hashInput = kind === "tool" ? [pluginId, serverId, name] : [kind, pluginId, serverId, name];
  return `${slug(pluginId)}__${slug(serverId)}__${slug(name)}_${shortHash(JSON.stringify(hashInput))}`;
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function asRecordArray(value: unknown): JsonRecord[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is JsonRecord => asRecord(item) !== undefined);
}

function toolSchema(value: unknown): JsonRecord {
  const record = asRecord(value);
  return record ?? { type: "object", properties: {}, additionalProperties: true };
}

function optionalRecord(value: unknown): JsonRecord | undefined { return asRecord(value); }

function optionalRecordArray(value: unknown): JsonRecord[] | undefined { return asRecordArray(value); }

function omitUndefined<T extends object>(value: T): T {
  for (const key of Object.keys(value)) {
    if ((value as Record<string, unknown>)[key] === undefined) delete (value as Record<string, unknown>)[key];
  }
  return value;
}

interface Connected {
  kind: "local" | "host";
  client?: Client;
  transport?: StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport;
  host?: McpStdioHost;
  hostKey?: string;
  tools: Tool[];
  prompts: Prompt[];
  resources: Resource[];
  resourceTemplates: ResourceTemplateType[];
  expectedClose: boolean;
  provider?: McpOAuthProvider;
}

interface PendingAuth {
  client: Client;
  transport: StreamableHTTPClientTransport | SSEClientTransport;
  provider: McpOAuthProvider;
}

interface Failure { message: string; at: number; }

interface CatalogCache {
  configJson: string;
  tools: Tool[];
  prompts: Prompt[];
  resources: Resource[];
  resourceTemplates: ResourceTemplateType[];
  updatedAt: number;
  error: string | null;
}

interface ServerConfig {
  type: "stdio" | "streamable-http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
}

class AuthenticationRequiredError extends Error {
  constructor(readonly authorizationUrl: string) {
    super("MCP authorization is required");
    this.name = "AuthenticationRequiredError";
  }
}

function parseServerConfig(rawJson: string): ServerConfig | null {
  try { return JSON.parse(rawJson) as ServerConfig; } catch { return null; }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string, onTimeout?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    p.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

function isJsonRpcBody(body: BodyInit | null | undefined): boolean {
  if (typeof body !== "string") return false;
  try {
    const parsed = JSON.parse(body) as unknown;
    if (Array.isArray(parsed)) return parsed.some((item) => asRecord(item)?.jsonrpc === "2.0");
    return asRecord(parsed)?.jsonrpc === "2.0";
  } catch {
    return false;
  }
}

function isMcpRequest(url: URL, configuredUrl: URL, input: RequestInfo | URL, init: RequestInit | undefined): boolean {
  // Legacy SSE servers advertise a second, session-specific POST endpoint.
  // Keep literal mcp.json headers on that endpoint, while distinguishing it
  // from same-origin OAuth JSON/form endpoints by requiring an MCP JSON-RPC
  // body or an event-stream GET.
  const requestHeaders = new Headers(init?.headers ?? (typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined));
  const method = (init?.method ?? (typeof Request !== "undefined" && input instanceof Request ? input.method : "GET")).toUpperCase();
  const exactConfiguredEndpoint = url.origin === configuredUrl.origin && url.pathname === configuredUrl.pathname && url.search === configuredUrl.search;
  if (method === "GET" && requestHeaders.get("accept")?.toLowerCase().includes("text/event-stream")) return true;
  if (method === "POST" && isJsonRpcBody(init?.body ?? null)) return true;
  // Streamable HTTP session cleanup uses DELETE on the configured endpoint;
  // OAuth discovery, registration, and token exchange do not.
  return exactConfiguredEndpoint && method === "DELETE";
}

export function redirectGuardFetch(url: URL, baseHeaders: Record<string, string> | undefined, timeoutMs = OAUTH_TIMEOUT_MS): typeof fetch {
  return async (input, init) => {
    const requestUrl = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    // Literal mcp.json headers belong only to the configured MCP endpoint. In
    // particular, never send an API key or Authorization header to OAuth
    // discovery, registration, or token endpoints—even when those endpoints
    // share the MCP server's origin.
    const useMcpHeaders = isMcpRequest(requestUrl, url, input, init);
    const headers = new Headers(typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined);
    if (useMcpHeaders) {
      new Headers(baseHeaders).forEach((value, name) => headers.set(name, value));
    }
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    const controller = new AbortController();
    const sourceSignals = [
      init?.signal,
      typeof Request !== "undefined" && input instanceof Request ? input.signal : undefined,
    ].filter((signal): signal is AbortSignal => signal !== undefined);
    const forwardAbort = (signal: AbortSignal) => () => controller.abort(signal.reason);
    const abortListeners = sourceSignals.map((signal) => {
      const listener = forwardAbort(signal);
      if (signal.aborted) listener();
      else signal.addEventListener("abort", listener, { once: true });
      return { signal, listener };
    });
    const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(new Error(`MCP HTTP request timed out after ${timeoutMs}ms`)), timeoutMs) : undefined;
    try {
      const response = await fetch(input as URL | RequestInfo, {
        ...(init as RequestInit),
        headers,
        signal: controller.signal,
        redirect: "manual",
      });
      if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
        throw new Error(`redirect blocked for ${url}: ${response.headers.get("location")}`);
      }
      return response;
    } finally {
      if (timer) clearTimeout(timer);
      for (const { signal, listener } of abortListeners) signal.removeEventListener("abort", listener);
    }
  };
}

function contentResult(result: unknown): McpCallResult {
  const record = asRecord(result) ?? {};
  return omitUndefined({
    content: (asRecordArray(record.content) ?? []) as JsonRecord[],
    isError: typeof record.isError === "boolean" ? record.isError : undefined,
    structuredContent: record.structuredContent,
    _meta: optionalRecord(record._meta),
  });
}

function responseRecord(result: unknown): JsonRecord {
  return asRecord(result) ?? {};
}

export class McpGateway implements McpRuntime {
  private readonly conns = new Map<string, Connected>();
  private readonly pending = new Map<string, Promise<Connected>>();
  private readonly connectControllers = new Map<string, AbortController>();
  private readonly oauthPending = new Map<string, PendingAuth>();
  private readonly providers = new Map<string, McpOAuthProvider>();
  private readonly failures = new Map<string, Failure>();
  private readonly catalogCache = new Map<string, CatalogCache>();
  // Routing hints only: every use rechecks the server gates and current catalog.
  private readonly toolOwners = new Map<string, string>();
  private readonly catalogLoads = new Map<string, Promise<CatalogCache>>();
  private readonly catalogGenerations = new Map<string, number>();
  private readonly dirtyCatalogs = new Set<string>();
  private readonly serverEpochs = new Map<string, number>();
  private readonly hostExitUnsubscribe?: () => void;
  private readonly hostCatalogUnsubscribe?: () => void;
  private readonly hostConnectionUnsubscribe?: () => void;
  private closed = false;

  constructor(
    private readonly store: AgentPluginsStore,
    private readonly log: { info(m: string): void; warn(m: string): void; error(m: string): void },
    private readonly options: McpGatewayOptions = {},
  ) {
    this.hostExitUnsubscribe = options.stdioHost?.onWorkerExit?.(() => {
      void this.handleHostWorkerExit();
    });
    this.hostCatalogUnsubscribe = options.stdioHost?.onCatalogChanged?.((key, kind, error) => {
      this.onCatalogChanged(key, kind, error ? new Error(error) : null, undefined);
    });
    this.hostConnectionUnsubscribe = options.stdioHost?.onConnectionChanged?.((key, status, error) => {
      void this.handleHostConnectionChanged(key, status, error);
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const controller of this.connectControllers.values()) controller.abort(new Error("MCP gateway closing"));
    await Promise.allSettled([...this.pending.entries()].map(async ([key, pending]) => {
      try { await withTimeout(pending, CLOSE_TIMEOUT_MS, `wait for MCP connection ${key}`); }
      catch (error) { this.log.warn(`wait for MCP connection ${key}: ${errorText(error)}`); }
    }));
    const all = new Map<string, Connected | PendingAuth>();
    for (const [key, conn] of this.conns) all.set(key, conn);
    for (const [key, pending] of this.oauthPending) all.set(key, pending);
    this.conns.clear();
    this.oauthPending.clear();
    this.failures.clear();
    this.toolOwners.clear();
    await Promise.all([...all.entries()].map(async ([key, value]) => {
      try {
        if ("expectedClose" in value) await this.closeConnected(key, value);
        else await this.closePendingAuthValue(key, value);
      } catch (e) { this.log.warn(`close ${key}: ${errorText(e)}`); }
    }));
    this.hostExitUnsubscribe?.();
    this.hostCatalogUnsubscribe?.();
    this.hostConnectionUnsubscribe?.();
  }

  async closeServer(pluginId: string, serverId: string): Promise<void> {
    const key = keyOf(pluginId, serverId);
    this.serverEpochs.set(key, (this.serverEpochs.get(key) ?? 0) + 1);
    this.connectControllers.get(key)?.abort(new Error(`MCP connection cancelled for ${serverId}`));
    const pendingConnect = this.pending.get(key);
    if (pendingConnect) {
      try { await withTimeout(pendingConnect, CLOSE_TIMEOUT_MS, `wait for MCP connection ${key}`); }
      catch (error) { this.log.warn(`wait for MCP connection ${key}: ${errorText(error)}`); }
      // A late connection is fenced by serverEpochs. Remove the old promise
      // now so reconnect/reenable can start a fresh attempt immediately.
      if (this.pending.get(key) === pendingConnect) this.pending.delete(key);
    }
    const conn = this.conns.get(key);
    const auth = this.oauthPending.get(key);
    this.conns.delete(key);
    this.oauthPending.delete(key);
    this.failures.delete(key);
    this.invalidateCatalog(key);
    const value = conn ?? auth;
    if (!value) return;
    try {
      if ("expectedClose" in value) await this.closeConnected(key, value);
      else await this.closePendingAuthValue(key, value);
    } catch (e) { this.log.warn(`close ${key}: ${errorText(e)}`); }
  }

  private async closeConnected(key: string, connection: Connected): Promise<void> {
    connection.expectedClose = true;
    if (connection.kind === "host") {
      if (connection.host && connection.hostKey) {
        const controller = new AbortController();
        await withTimeout(
          connection.host.close(connection.hostKey, controller.signal),
          CLOSE_TIMEOUT_MS,
          `close isolated MCP ${key}`,
          () => controller.abort(new Error(`close isolated MCP ${key} timed out`)),
        );
      }
      return;
    }
    if (connection.client) await withTimeout(connection.client.close(), CLOSE_TIMEOUT_MS, `close ${key}`);
  }

  private async closePendingAuthValue(key: string, pending: PendingAuth): Promise<void> {
    await Promise.all([
      withTimeout(pending.transport.close(), CLOSE_TIMEOUT_MS, `close pending MCP OAuth transport ${key}`)
        .catch((error) => this.log.warn(`close pending MCP OAuth transport ${key}: ${errorText(error)}`)),
      withTimeout(pending.client.close(), CLOSE_TIMEOUT_MS, `close ${key}`)
        .catch((error) => this.log.warn(`close pending MCP OAuth client ${key}: ${errorText(error)}`)),
    ]);
  }

  private async handleHostWorkerExit(): Promise<void> {
    if (this.closed) return;
    const isolated = [...this.conns.entries()].filter(([, connection]) => connection.kind === "host");
    for (const [key, connection] of isolated) {
      if (this.conns.get(key) !== connection) continue;
      this.conns.delete(key);
      const [pluginId, serverId] = key.split(":", 2);
      const message = "Isolated MCP worker exited; the server will reconnect on the next request";
      this.failures.set(key, { message, at: Date.now() });
      this.invalidateCatalog(key);
      if (pluginId && serverId) this.persistStatus(pluginId, serverId, "error", message);
    }
    if (isolated.length > 0) await this.notifyChanged();
  }

  private async handleHostConnectionChanged(key: string, status: "closed" | "error", error: string | null): Promise<void> {
    const connection = this.conns.get(key);
    if (!connection || connection.kind !== "host") return;
    this.conns.delete(key);
    this.invalidateCatalog(key);
    const [pluginId, serverId] = key.split(":", 2);
    const message = error ?? `Isolated MCP transport ${status}`;
    if (pluginId && serverId) this.persistStatus(pluginId, serverId, "error", message);
    this.failures.set(key, { message, at: Date.now() });
    await this.notifyChanged();
  }

  /**
   * Drop a cached OAuth provider when an update changes or removes an MCP
   * definition. Keeping the provider would retain the old server origin and
   * redirect metadata under the same plugin/server key.
   */
  async resetServer(pluginId: string, serverId: string): Promise<void> {
    const key = keyOf(pluginId, serverId);
    const provider = this.providers.get(key);
    await this.closeServer(pluginId, serverId);
    if (provider) await provider.clearPending().catch((error) => this.log.warn(`clear MCP OAuth state ${key}: ${errorText(error)}`));
    this.providers.delete(key);
  }

  async startServer(pluginId: string, serverId: string): Promise<void> { await this.ensureServer(pluginId, serverId); }
  async stopServer(pluginId: string, serverId: string): Promise<void> { await this.closeServer(pluginId, serverId); }

  async status(): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const [key, failure] of this.failures) result[key] = failure.message;
    for (const [key, conn] of this.conns) result[key] = `ready ${conn.tools.length} tools`;
    for (const [key, pending] of this.oauthPending) result[key] = `needs-auth ${pending.provider.serverOrigin}`;
    return result;
  }

  async authUrl(pluginId: string, serverId: string): Promise<string | null> {
    const record = this.serverRecord(pluginId, serverId);
    const cfg = this.validatedConfig(record);
    if (cfg.type === "stdio") return null;
    const provider = await this.providerFor(pluginId, serverId, new URL(cfg.url!));
    const existing = await provider.authorizationUrlValue();
    if (existing) return existing;
    try {
      await this.startServer(pluginId, serverId);
    } catch (error) {
      if (!(error instanceof AuthenticationRequiredError)) throw error;
    }
    return await provider.authorizationUrlValue() ?? null;
  }

  async authStatus(pluginId: string, serverId: string): Promise<"unauthenticated" | "authorizing" | "authenticated"> {
    const record = this.serverRecord(pluginId, serverId);
    const cfg = this.validatedConfig(record);
    if (cfg.type === "stdio") return "authenticated";
    const provider = await this.providerFor(pluginId, serverId, new URL(cfg.url!));
    return provider.status();
  }

  /**
   * Reconnect an enabled server while retaining its OAuth credentials. If the
   * existing credentials can no longer be used, return the SDK-generated
   * authorization URL so the caller can continue the browser flow.
   */
  async reconnectServer(pluginId: string, serverId: string): Promise<string | null> {
    const record = this.serverRecord(pluginId, serverId);
    if (record.enabled !== 1) throw new Error(`MCP server ${serverId} is disabled`);
    await this.closeServer(pluginId, serverId);
    this.persistStatus(pluginId, serverId, "idle", null);
    try {
      await this.startServer(pluginId, serverId);
      return null;
    } catch (error) {
      if (error instanceof AuthenticationRequiredError) return error.authorizationUrl;
      throw error;
    }
  }

  async finishAuth(pluginId: string, serverId: string, params: URLSearchParams): Promise<void> {
    const key = keyOf(pluginId, serverId);
    const pending = this.oauthPending.get(key);
    if (!pending) {
      // A plugin worker may be reloaded while the browser is on the consent
      // page. The provider's PKCE/discovery state is durable, so finish the
      // code exchange on a short-lived transport and let normal startup build
      // the authenticated connection.
      const record = this.serverRecord(pluginId, serverId);
      const cfg = this.validatedConfig(record);
      if (cfg.type === "stdio") throw new Error("MCP OAuth is only available for HTTP transports");
      const provider = await this.providerFor(pluginId, serverId, new URL(cfg.url!));
      try {
        await provider.validateState(params.get("state"));
      } catch (error) {
        if (!isOAuthStateMismatch(error)) this.log.warn(`MCP OAuth callback validation failed for ${key}: ${errorText(error)}`);
        throw error;
      }
      if (params.get("error")) {
        const message = authorizationFailure(params);
        await this.cancelPendingAuthentication(pluginId, serverId, provider, undefined, message);
        throw new Error(message);
      }
      const transport = this.createHttpTransport(cfg, provider);
      try {
        await withTimeout(
          transport.finishAuth(params),
          this.options.oauthTimeoutMs ?? OAUTH_TIMEOUT_MS,
          `OAuth token exchange ${serverId}`,
          () => { void transport.close().catch(() => {}); },
        );
      } catch (error) {
        const message = errorText(error);
        await this.cancelPendingAuthentication(pluginId, serverId, provider, undefined, message);
        throw error;
      } finally {
        try { await withTimeout(transport.close(), CLOSE_TIMEOUT_MS, `close OAuth transport ${serverId}`); } catch {}
      }
      try {
        await provider.clearPending();
        await withTimeout(this.ensureServer(pluginId, serverId), CONNECT_TIMEOUT_MS, `reconnect ${serverId}`);
        this.persistStatus(pluginId, serverId, "ready", null);
        this.failures.delete(key);
        await this.notifyChanged();
      } catch (error) {
        const message = errorText(error);
        this.persistStatus(pluginId, serverId, "error", message);
        await this.notifyChanged();
        throw new Error(message);
      }
      return;
    }
    try {
      await pending.provider.validateState(params.get("state"));
    } catch (error) {
      if (!isOAuthStateMismatch(error)) this.log.warn(`MCP OAuth callback validation failed for ${key}: ${errorText(error)}`);
      throw error;
    }
    if (params.get("error")) {
      const message = authorizationFailure(params);
      await this.cancelPendingAuthentication(pluginId, serverId, pending.provider, pending, message);
      throw new Error(message);
    }
    try {
      await withTimeout(
        pending.transport.finishAuth(params),
        this.options.oauthTimeoutMs ?? OAUTH_TIMEOUT_MS,
        `OAuth token exchange ${serverId}`,
        () => { void pending.transport.close().catch(() => {}); },
      );
    } catch (error) {
      const message = errorText(error);
      await this.cancelPendingAuthentication(pluginId, serverId, pending.provider, pending, message);
      throw error;
    }
    try {
      await pending.provider.clearPending();
    } catch (error) {
      const message = errorText(error);
      await this.closePendingAuth(key, pending);
      this.persistStatus(pluginId, serverId, "error", message);
      await this.notifyChanged();
      throw error;
    }
    // `finishAuth` exchanges the code on the transport that observed the
    // challenge. The SDK transport is already started at this point and must
    // not be passed to Client.connect() again; rebuild the connection with the
    // now-authenticated provider instead.
    await this.closePendingAuth(key, pending);
    try {
      await withTimeout(this.ensureServer(pluginId, serverId), CONNECT_TIMEOUT_MS, `reconnect ${serverId}`);
      this.failures.delete(key);
      await this.notifyChanged();
    } catch (error) {
      const message = errorText(error);
      this.persistStatus(pluginId, serverId, "error", message);
      await this.notifyChanged();
      throw new Error(message);
    }
  }

  async cancelAuthentication(pluginId: string, serverId: string): Promise<void> {
    const record = this.serverRecord(pluginId, serverId);
    const cfg = this.validatedConfig(record);
    if (cfg.type === "stdio") return;
    const provider = await this.providerFor(pluginId, serverId, new URL(cfg.url!));
    await this.closeServer(pluginId, serverId);
    try {
      await provider.clearPending();
      const status = record.enabled === 1 ? "needs-auth" : "disabled";
      this.persistStatus(pluginId, serverId, status, null);
      await this.notifyChanged();
    } catch (error) {
      const message = errorText(error);
      this.persistStatus(pluginId, serverId, "error", message);
      await this.notifyChanged();
      throw error;
    }
  }

  async clearAuthentication(pluginId: string, serverId: string): Promise<void> {
    const record = this.serverRecord(pluginId, serverId);
    const cfg = this.validatedConfig(record);
    if (cfg.type === "stdio") return;
    await this.closeServer(pluginId, serverId);
    const provider = await this.providerFor(pluginId, serverId, new URL(cfg.url!));
    await provider.invalidateCredentials("all");
    this.persistStatus(pluginId, serverId, record.enabled === 1 ? "idle" : "disabled", null);
    await this.notifyChanged();
  }

  private cacheCatalog(key: string, configJson: string, connection: Connected, error: string | null = null): CatalogCache {
    const cached: CatalogCache = {
      configJson,
      tools: connection.tools,
      prompts: connection.prompts,
      resources: connection.resources,
      resourceTemplates: connection.resourceTemplates,
      updatedAt: Date.now(),
      error,
    };
    this.catalogCache.set(key, cached);
    this.dirtyCatalogs.delete(key);
    return cached;
  }

  private invalidateCatalog(key: string): void {
    this.catalogGenerations.set(key, (this.catalogGenerations.get(key) ?? 0) + 1);
    this.catalogCache.delete(key);
    this.catalogLoads.delete(key);
    this.dirtyCatalogs.delete(key);
  }

  private async getCatalog(record: ReturnType<McpGateway["serverRecord"]>): Promise<CatalogCache> {
    const key = keyOf(record.pluginId, record.serverId);
    const cached = this.catalogCache.get(key);
    const age = cached ? Date.now() - cached.updatedAt : Number.POSITIVE_INFINITY;
    if (cached && cached.configJson === record.configJson && !this.dirtyCatalogs.has(key)) {
      if (cached.error && age < RETRY_AFTER_MS) throw new Error(cached.error);
      if (!cached.error && age < CATALOG_TTL_MS) return cached;
    }
    const existingLoad = this.catalogLoads.get(key);
    if (existingLoad) return existingLoad;
    const generation = this.catalogGenerations.get(key) ?? 0;

    const load = (async () => {
      try {
        const connection = await this.ensureServer(record.pluginId, record.serverId);
        if (!connection) throw new Error(`MCP server unavailable: ${record.serverId}`);
        const needsRefresh = this.dirtyCatalogs.has(key) || !cached || cached.configJson !== record.configJson || age >= CATALOG_TTL_MS;
        if (needsRefresh && cached) {
          const controller = new AbortController();
          await withTimeout(
            this.refreshCatalog(connection, controller.signal),
            CONNECT_TIMEOUT_MS,
            `refresh MCP catalog ${record.serverId}`,
            () => controller.abort(new Error(`MCP catalog refresh timed out for ${record.serverId}`)),
          );
        }
        if ((this.catalogGenerations.get(key) ?? 0) !== generation) throw new Error(`MCP catalog invalidated for ${record.serverId}`);
        return this.cacheCatalog(key, record.configJson, connection);
      } catch (error) {
        if ((this.catalogGenerations.get(key) ?? 0) === generation) {
          const message = errorText(error);
          const empty: Connected = {
            kind: "local",
            tools: [],
            prompts: [],
            resources: [],
            resourceTemplates: [],
            expectedClose: false,
          };
          this.cacheCatalog(key, record.configJson, empty, message);
        }
        throw error;
      }
    })();
    this.catalogLoads.set(key, load);
    try { return await load; }
    finally { if (this.catalogLoads.get(key) === load) this.catalogLoads.delete(key); }
  }

  async listTools(serverId?: string): Promise<CatalogTool[]> {
    const scope = serverId?.trim();
    return this.toolsForServers(this.enabledApprovedServers().filter((record) => !scope || record.serverId === scope));
  }

  async resolveTools(opaqueIds: string[]): Promise<CatalogTool[]> {
    const ids = new Set(opaqueIds);
    const servers = this.enabledApprovedServers();
    const owners = new Set<string>();
    for (const id of ids) {
      const known = this.toolOwners.get(id);
      if (known) {
        owners.add(known);
        continue;
      }
      // A cached ID can outlive this gateway instance. Use its stable prefix
      // only to select a server, never as authority to execute a tool. Slugs
      // are lossy (and may contain '__'), so ambiguous cold IDs fail closed;
      // scoped discovery records the exact owner for those IDs.
      if (!/^[a-z0-9_-]+_[a-f0-9]{10}$/u.test(id)) continue;
      const candidates = servers.filter((record) => id.startsWith(`${slug(record.pluginId)}__${slug(record.serverId)}__`));
      if (candidates.length === 1) owners.add(keyOf(candidates[0]!.pluginId, candidates[0]!.serverId));
    }
    const catalog = await this.toolsForServers(servers.filter((record) => owners.has(keyOf(record.pluginId, record.serverId))));
    // Exact full-ID comparison (including the hash) rejects stale/forged IDs.
    return catalog.filter((tool) => ids.has(tool.opaqueId));
  }

  private async toolsForServers(records: ReturnType<McpGateway["enabledApprovedServers"]>): Promise<CatalogTool[]> {
    const catalogs: CatalogTool[][] = new Array(records.length);
    let next = 0;
    // Per-request workers avoid a broad discovery queue blocking targeted calls.
    // getCatalog still coalesces concurrent loads and backs off per server.
    await Promise.all(Array.from({ length: Math.min(CATALOG_CONCURRENCY, records.length) }, async () => {
      while (next < records.length) {
        const index = next++;
        const record = records[index]!;
        const cfg = parseServerConfig(record.configJson);
        if (!cfg) { catalogs[index] = []; continue; }
        try {
          const catalog = await this.getCatalog(record);
          const pluginName = this.store.getPlugin(record.pluginId)?.name ?? record.pluginId;
          catalogs[index] = catalog.tools.map((tool) => this.catalogTool(record, cfg, pluginName, tool));
        } catch (error) {
          this.log.warn(`listTools skip ${record.serverId}: ${errorText(error)}`);
          catalogs[index] = [this.toolError(record, cfg, error)];
        }
        for (const tool of catalogs[index]!) this.toolOwners.set(tool.opaqueId, keyOf(record.pluginId, record.serverId));
      }
    }));
    // Preserve store/catalog order regardless of connection completion order.
    return catalogs.flat();
  }

  async call(opaqueId: string, args: JsonRecord, signal?: AbortSignal): Promise<McpCallResult> {
    const catalog = await this.resolveTools([opaqueId]);
    const definition = catalog.find((item) => item.opaqueId === opaqueId);
    if (!definition) throw new Error(`Tool not found: ${opaqueId}`);
    if (definition.status === "error") throw new Error(definition.error ?? "tool in error state");
    const conn = await this.ensureServer(definition.pluginId, definition.serverId);
    if (!conn) throw new Error(`MCP server unavailable: ${definition.serverId}`);
    const tool = conn.tools.find((item) => item.name === definition.name);
    if (!tool) throw new Error(`Tool not found: ${opaqueId}`);
    const result = await this.withAuthState(definition.pluginId, definition.serverId, () => this.callTool(conn!, definition.name, args, tool, signal));
    return contentResult(result);
  }

  async listPrompts(): Promise<CatalogPrompt[]> {
    const result: CatalogPrompt[] = [];
    for (const record of this.enabledApprovedServers()) {
      const cfg = parseServerConfig(record.configJson);
      if (!cfg) continue;
      try {
        const catalog = await this.getCatalog(record);
        const pluginName = this.store.getPlugin(record.pluginId)?.name ?? record.pluginId;
        for (const prompt of catalog.prompts) result.push(this.catalogPrompt(record, cfg, pluginName, prompt));
      } catch (error) { this.log.warn(`listPrompts skip ${record.serverId}: ${errorText(error)}`); }
    }
    return result;
  }

  async getPrompt(opaqueId: string, args: JsonRecord = {}, signal?: AbortSignal): Promise<JsonRecord> {
    const definition = (await this.listPrompts()).find((item) => item.opaqueId === opaqueId);
    if (!definition) throw new Error(`Prompt not found: ${opaqueId}`);
    const conn = await this.ensureServer(definition.pluginId, definition.serverId);
    if (!conn) throw new Error(`MCP server unavailable: ${definition.serverId}`);
    const argumentsMap: Record<string, string> = {};
    for (const [name, value] of Object.entries(args)) {
      if (typeof value !== "string") throw new Error(`Prompt argument ${name} must be a string`);
      argumentsMap[name] = value;
    }
    return responseRecord(await this.withAuthState(definition.pluginId, definition.serverId, () => this.callPrompt(conn!, definition.name, argumentsMap, signal)));
  }

  async listResources(): Promise<CatalogResource[]> {
    const result: CatalogResource[] = [];
    for (const record of this.enabledApprovedServers()) {
      const cfg = parseServerConfig(record.configJson);
      if (!cfg) continue;
      try {
        const catalog = await this.getCatalog(record);
        const pluginName = this.store.getPlugin(record.pluginId)?.name ?? record.pluginId;
        for (const resource of catalog.resources) result.push(this.catalogResource(record, cfg, pluginName, resource));
      } catch (error) { this.log.warn(`listResources skip ${record.serverId}: ${errorText(error)}`); }
    }
    return result;
  }

  async listResourceTemplates(): Promise<CatalogResourceTemplate[]> {
    const result: CatalogResourceTemplate[] = [];
    for (const record of this.enabledApprovedServers()) {
      const cfg = parseServerConfig(record.configJson);
      if (!cfg) continue;
      try {
        const catalog = await this.getCatalog(record);
        const pluginName = this.store.getPlugin(record.pluginId)?.name ?? record.pluginId;
        for (const template of catalog.resourceTemplates) result.push(this.catalogResourceTemplate(record, cfg, pluginName, template));
      } catch (error) { this.log.warn(`listResourceTemplates skip ${record.serverId}: ${errorText(error)}`); }
    }
    return result;
  }

  async readResource(opaqueId: string, signal?: AbortSignal): Promise<JsonRecord> {
    const definition = (await this.listResources()).find((item) => item.opaqueId === opaqueId);
    if (!definition) throw new Error(`Resource not found: ${opaqueId}`);
    const conn = await this.ensureServer(definition.pluginId, definition.serverId);
    if (!conn) throw new Error(`MCP server unavailable: ${definition.serverId}`);
    return responseRecord(await this.withAuthState(definition.pluginId, definition.serverId, () => this.readResourceOnConnection(conn!, definition.uri, signal)));
  }

  async complete(ref: JsonRecord, argument: JsonRecord, signal?: AbortSignal): Promise<JsonRecord> {
    const pluginId = typeof ref.pluginId === "string" ? ref.pluginId : undefined;
    const serverId = typeof ref.serverId === "string" ? ref.serverId : undefined;
    let target: { pluginId: string; serverId: string } | undefined = pluginId && serverId ? { pluginId, serverId } : undefined;
    if (!target && typeof ref.opaqueId === "string") {
      const [prompts, resources, templates] = await Promise.all([this.listPrompts(), this.listResources(), this.listResourceTemplates()]);
      const match = [...prompts, ...resources, ...templates].filter((item) => item.opaqueId === ref.opaqueId);
      if (match.length === 1) target = { pluginId: match[0]!.pluginId, serverId: match[0]!.serverId };
      else if (match.length > 1) throw new Error("Completion reference is ambiguous");
    }
    if (!target && ref.type === "ref/prompt" && typeof ref.name === "string") {
      const matches = (await this.listPrompts()).filter((item) => item.name === ref.name);
      if (matches.length === 1) target = { pluginId: matches[0]!.pluginId, serverId: matches[0]!.serverId };
      else if (matches.length > 1) throw new Error(`Completion prompt is ambiguous: ${ref.name}`);
    }
    if (!target && ref.type === "ref/resource" && typeof ref.uri === "string") {
      const [resources, templates] = await Promise.all([this.listResources(), this.listResourceTemplates()]);
      const matches = [...resources.filter((item) => item.uri === ref.uri), ...templates.filter((item) => item.uriTemplate === ref.uri)];
      if (matches.length === 1) target = { pluginId: matches[0]!.pluginId, serverId: matches[0]!.serverId };
      else if (matches.length > 1) throw new Error(`Completion resource is ambiguous: ${ref.uri}`);
    }
    if (!target && typeof ref.uriTemplate === "string") {
      const matches = (await this.listResourceTemplates()).filter((item) => item.uriTemplate === ref.uriTemplate);
      if (matches.length === 1) target = { pluginId: matches[0]!.pluginId, serverId: matches[0]!.serverId };
      else if (matches.length > 1) throw new Error(`Completion resource template is ambiguous: ${ref.uriTemplate}`);
    }
    if (!target) throw new Error("Completion reference must include pluginId and serverId");
    const conn = await this.ensureServer(target.pluginId, target.serverId);
    if (!conn) throw new Error(`MCP server unavailable: ${target.serverId}`);
    if (ref.type !== "ref/prompt" && ref.type !== "ref/resource") throw new Error(`Unsupported completion reference type: ${String(ref.type)}`);
    if (ref.type === "ref/prompt" && typeof ref.name !== "string") throw new Error("Prompt completion reference must include name");
    if (ref.type === "ref/resource" && typeof ref.uri !== "string") throw new Error("Resource completion reference must include uri");
    const wireRef: JsonRecord = { type: ref.type };
    if (typeof ref.name === "string") wireRef.name = ref.name;
    if (typeof ref.uri === "string") wireRef.uri = ref.uri;
    const wireArgument: JsonRecord = {
      name: typeof argument.name === "string" ? argument.name : String(argument.name ?? ""),
      value: typeof argument.value === "string" ? argument.value : String(argument.value ?? ""),
    };
    const params: JsonRecord = { ref: wireRef, argument: wireArgument };
    return responseRecord(await this.withAuthState(target.pluginId, target.serverId, () => this.completeOnConnection(conn!, wireRef, wireArgument, signal)));
  }

  async subscribeResource(opaqueId: string, signal?: AbortSignal): Promise<void> {
    const definition = (await this.listResources()).find((item) => item.opaqueId === opaqueId);
    if (!definition) throw new Error(`Resource not found: ${opaqueId}`);
    const conn = await this.ensureServer(definition.pluginId, definition.serverId);
    if (!conn) throw new Error(`MCP server unavailable: ${definition.serverId}`);
    await this.withAuthState(definition.pluginId, definition.serverId, () => this.subscribeOnConnection(conn!, definition.uri, signal));
  }

  async unsubscribeResource(opaqueId: string, signal?: AbortSignal): Promise<void> {
    const definition = (await this.listResources()).find((item) => item.opaqueId === opaqueId);
    if (!definition) throw new Error(`Resource not found: ${opaqueId}`);
    const conn = await this.ensureServer(definition.pluginId, definition.serverId);
    if (!conn) throw new Error(`MCP server unavailable: ${definition.serverId}`);
    await this.withAuthState(definition.pluginId, definition.serverId, () => this.unsubscribeOnConnection(conn!, definition.uri, signal));
  }

  async setLoggingLevel(level: string, signal?: AbortSignal): Promise<void> {
    const allowed = new Set(["debug", "info", "notice", "warning", "error", "critical", "alert", "emergency"]);
    if (!allowed.has(level)) throw new Error(`Invalid MCP logging level: ${level}`);
    for (const record of this.enabledApprovedServers()) {
      const conn = await this.ensureServer(record.pluginId, record.serverId);
      if (conn) await this.withAuthState(record.pluginId, record.serverId, () => this.setLoggingLevelOnConnection(conn!, level, signal));
    }
  }

  private async callTool(conn: Connected, name: string, args: JsonRecord, tool?: Tool, signal?: AbortSignal): Promise<unknown> {
    if (conn.kind === "host") return conn.host!.callTool(conn.hostKey!, name, args, tool, signal);
    return conn.client!.callTool(
      { name, arguments: args as Record<string, unknown> },
      { ...(signal ? { signal } : {}), ...(tool ? { toolDefinition: tool } : {}) },
    );
  }

  private async callPrompt(conn: Connected, name: string, args: JsonRecord, signal?: AbortSignal): Promise<unknown> {
    if (conn.kind === "host") return conn.host!.getPrompt(conn.hostKey!, name, args, signal);
    return conn.client!.getPrompt({ name, arguments: args as Record<string, string> }, signal ? { signal } : undefined);
  }

  private async readResourceOnConnection(conn: Connected, uri: string, signal?: AbortSignal): Promise<unknown> {
    if (conn.kind === "host") return conn.host!.readResource(conn.hostKey!, uri, signal);
    return conn.client!.readResource({ uri }, signal ? { signal } : undefined);
  }

  private async completeOnConnection(conn: Connected, ref: JsonRecord, argument: JsonRecord, signal?: AbortSignal): Promise<unknown> {
    if (conn.kind === "host") return conn.host!.complete(conn.hostKey!, ref, argument, signal);
    return conn.client!.complete({ ref: ref as never, argument: argument as never }, signal ? { signal } : undefined);
  }

  private async subscribeOnConnection(conn: Connected, uri: string, signal?: AbortSignal): Promise<void> {
    if (conn.kind === "host") {
      await conn.host!.subscribeResource(conn.hostKey!, uri, signal);
      return;
    }
    await conn.client!.subscribeResource({ uri }, signal ? { signal } : undefined);
  }

  private async unsubscribeOnConnection(conn: Connected, uri: string, signal?: AbortSignal): Promise<void> {
    if (conn.kind === "host") {
      await conn.host!.unsubscribeResource(conn.hostKey!, uri, signal);
      return;
    }
    await conn.client!.unsubscribeResource({ uri }, signal ? { signal } : undefined);
  }

  private async setLoggingLevelOnConnection(conn: Connected, level: string, signal?: AbortSignal): Promise<void> {
    if (conn.kind === "host") {
      await conn.host!.setLoggingLevel(conn.hostKey!, level, signal);
      return;
    }
    await conn.client!.setLoggingLevel(level as never, signal ? { signal } : undefined);
  }

  private async ensureServer(pluginId: string, serverId: string): Promise<Connected | null> {
    if (this.closed) throw new Error("MCP gateway closed");
    const key = keyOf(pluginId, serverId);
    const record = this.serverRecord(pluginId, serverId);
    if (record.enabled !== 1) throw new Error(`MCP server ${serverId} is disabled`);
    if (record.approved !== 1) throw new Error(`MCP server ${serverId} not approved (approval gate)`);
    const existing = this.conns.get(key);
    if (existing) return existing;
    if (this.oauthPending.has(key)) {
      const pending = this.oauthPending.get(key)!;
      throw new AuthenticationRequiredError(pending.provider.getAuthorizationUrl() ?? "");
    }
    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;
    const failure = this.failures.get(key);
    if (failure && Date.now() - failure.at < RETRY_AFTER_MS) throw new Error(failure.message);
    const cfg = this.validatedConfig(record);
    const controller = new AbortController();
    this.connectControllers.set(key, controller);
    const connectPromise = this.connectServer(pluginId, serverId, cfg, controller.signal);
    this.pending.set(key, connectPromise);
    try { return await connectPromise; }
    finally {
      if (this.pending.get(key) === connectPromise) this.pending.delete(key);
      if (this.connectControllers.get(key) === controller) this.connectControllers.delete(key);
    }
  }

  private async connectServer(pluginId: string, serverId: string, cfg: ServerConfig, signal: AbortSignal): Promise<Connected> {
    const key = keyOf(pluginId, serverId);
    const epoch = this.serverEpochs.get(key) ?? 0;
    const plugin = this.store.getPlugin(pluginId);
    if (!plugin) throw new Error(`plugin not found: ${pluginId}`);
    let client: Client | undefined;
    let transport: Connected["transport"] | undefined;
    let provider: McpOAuthProvider | undefined;
    let connection: Connected | undefined;
    try {
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("MCP connection cancelled");
      if (cfg.type === "stdio" && this.options.stdioHost) {
        const stdio = await this.expandedStdioConfig(key, cfg, plugin);
        const catalog = await withTimeout(
          this.options.stdioHost.start(stdio, signal),
          CONNECT_TIMEOUT_MS,
          `start isolated MCP ${serverId}`,
          () => this.connectControllers.get(key)?.abort(new Error(`start isolated MCP ${serverId} timed out`)),
        );
        connection = {
          kind: "host",
          host: this.options.stdioHost,
          hostKey: key,
          tools: catalog.tools,
          prompts: catalog.prompts,
          resources: catalog.resources,
          resourceTemplates: catalog.resourceTemplates,
          expectedClose: false,
        };
      } else {
        const capabilities: ClientCapabilities = {};
        if (this.options.onSampling) capabilities.sampling = {};
        if (this.options.onElicitation) capabilities.elicitation = { form: {} };
        if (this.options.onRoots) capabilities.roots = { listChanged: true };
        const clientOptions: ClientOptions = {
          capabilities,
          versionNegotiation: { mode: "auto" },
          listChanged: {
            tools: { autoRefresh: true, onChanged: (error, items) => this.onCatalogChanged(key, "tools", error, items) },
            prompts: { autoRefresh: true, onChanged: (error, items) => this.onCatalogChanged(key, "prompts", error, items) },
            resources: { autoRefresh: true, onChanged: (error, items) => this.onCatalogChanged(key, "resources", error, items) },
          },
        };
        client = new Client(MCP_CLIENT_INFO, clientOptions);
        this.installRequestHandlers(client, pluginId, serverId);

        if (cfg.type === "streamable-http" || cfg.type === "sse") {
        const serverUrl = new URL(cfg.url!);
        provider = await this.providerFor(pluginId, serverId, serverUrl);
        transport = this.createHttpTransport(cfg, provider);
        } else {
          const stdio = await this.expandedStdioConfig(key, cfg, plugin);
          transport = new StdioClientTransport({ command: stdio.command, args: stdio.args, cwd: stdio.cwd, env: stdio.env, stderr: "pipe" });
          transport.stderr?.on("data", (chunk: Buffer) => {
            const message = chunk.toString("utf8").trim();
            if (message) this.log.warn(`MCP ${serverId} stderr: ${message.slice(0, 2000)}`);
          });
        }

        connection = { kind: "local", client, transport, tools: [], prompts: [], resources: [], resourceTemplates: [], expectedClose: false, provider };
        this.installTransportHandlers(key, pluginId, serverId, connection);
        await withTimeout(
          client.connect(transport, { signal, timeout: CONNECT_TIMEOUT_MS }),
          CONNECT_TIMEOUT_MS,
          `connect ${serverId}`,
          () => { void client?.close().catch(() => {}); },
        );
        await withTimeout(
          this.refreshCatalog(connection, signal),
          CONNECT_TIMEOUT_MS,
          `list MCP capabilities ${serverId}`,
          () => this.connectControllers.get(key)?.abort(new Error(`list MCP capabilities ${serverId} timed out`)),
        );
      }
      if (provider) await provider.clearPending();
      if (this.closed) throw new Error("MCP gateway closed");
      if ((this.serverEpochs.get(key) ?? 0) !== epoch) throw new Error(`MCP connection cancelled for ${serverId}`);
      this.conns.set(key, connection);
      this.cacheCatalog(key, this.serverRecord(pluginId, serverId).configJson, connection);
      this.oauthPending.delete(key);
      this.failures.delete(key);
      this.persistStatus(pluginId, serverId, "ready", null);
      this.log.info(`MCP connected ${pluginId}:${serverId} (${connection.tools.length} tools, ${connection.prompts.length} prompts, ${connection.resources.length} resources)`);
      await this.notifyChanged();
      return connection;
    } catch (error) {
      const message = errorText(error);
      const cancelled = this.closed || signal.aborted || (this.serverEpochs.get(key) ?? 0) !== epoch;
      if (cancelled) {
        if (connection) try { await this.closeConnected(key, connection); } catch {}
        else if (client) try { await withTimeout(client.close(), CLOSE_TIMEOUT_MS, `close cancelled ${serverId}`); } catch {}
        this.conns.delete(key);
        throw new Error(this.closed ? "MCP gateway closed" : `MCP connection cancelled for ${serverId}`);
      }
      const authorizationUrl = provider ? await provider.authorizationUrlValue() : undefined;
      if (provider && client && transport && authorizationUrl) {
        this.oauthPending.set(key, { client: client!, transport: transport as StreamableHTTPClientTransport | SSEClientTransport, provider });
        this.failures.delete(key);
        this.persistStatus(pluginId, serverId, "needs-auth", "Authentication required");
        await this.notifyChanged();
        throw new AuthenticationRequiredError(authorizationUrl);
      }
      this.failures.set(key, { message, at: Date.now() });
      this.persistStatus(pluginId, serverId, "error", message);
      if (connection) try { await this.closeConnected(key, connection); } catch {}
      else if (client) try { await withTimeout(client.close(), CLOSE_TIMEOUT_MS, `close ${serverId}`); } catch {}
      this.conns.delete(key);
      throw new Error(message);
    }
  }

  private async expandedStdioConfig(
    key: string,
    cfg: ServerConfig,
    plugin: { pluginRoot: string; pluginData: string },
  ): Promise<McpStdioConfig> {
    if (!cfg.command) throw new Error("stdio MCP server is missing command");
    const args = (cfg.args ?? []).map((item) => expandPlaceholders(item, plugin.pluginRoot, plugin.pluginData));
    const envOverlay: Record<string, string> = {};
    for (const [name, value] of Object.entries(cfg.env ?? {})) envOverlay[name] = expandPlaceholders(value, plugin.pluginRoot, plugin.pluginData);
    const baseEnv: Record<string, string> = {};
    for (const name of ["PATH", "HOME", "USER", "SHELL", "LANG", "LC_ALL", "TMPDIR"]) if (process.env[name]) baseEnv[name] = process.env[name]!;
    const env = { ...baseEnv, ...envOverlay, PLUGIN_ROOT: plugin.pluginRoot, PLUGIN_DATA: plugin.pluginData };
    let cwd = plugin.pluginRoot;
    if (cfg.cwd) {
      const original = cfg.cwd;
      const expanded = expandPlaceholders(original, plugin.pluginRoot, plugin.pluginData);
      let anchor = plugin.pluginRoot;
      let resolved: string;
      if (original.startsWith("./")) resolved = path.resolve(plugin.pluginRoot, expanded.slice(2));
      else if (original === "${PLUGIN_DATA}" || original.startsWith("${PLUGIN_DATA}/")) { anchor = plugin.pluginData; resolved = path.resolve(expanded); }
      else resolved = path.resolve(expanded);
      if (!isWithinRoot(resolved, anchor)) throw new Error(`cwd escapes ${anchor === plugin.pluginRoot ? "PLUGIN_ROOT" : "PLUGIN_DATA"}: ${original} -> ${resolved}`);
      const real = await fsp.realpath(resolved).catch(() => resolved);
      if (!isWithinRoot(real, anchor)) throw new Error(`cwd realpath escapes: ${real}`);
      cwd = resolved;
    }
    const executable = cfg.command.startsWith("./") ? path.resolve(plugin.pluginRoot, cfg.command.slice(2)) : cfg.command;
    if (cfg.command.startsWith("./") && !isWithinRoot(executable, plugin.pluginRoot)) throw new Error(`command escapes plugin root: ${cfg.command} -> ${executable}`);
    return { key, command: executable, args, cwd, env };
  }

  private installTransportHandlers(key: string, pluginId: string, serverId: string, conn: Connected): void {
    if (!conn.transport) return;
    conn.transport.onerror = (error) => this.log.warn(`MCP ${serverId} error: ${errorText(error)}`);
    conn.transport.onclose = () => {
      if (conn.expectedClose || this.closed) return;
      if (this.conns.get(key)?.transport !== conn.transport) return;
      this.conns.delete(key);
      this.invalidateCatalog(key);
      const message = `MCP transport closed unexpectedly for ${serverId}`;
      this.failures.set(key, { message, at: Date.now() });
      this.persistStatus(pluginId, serverId, "error", message);
      void this.notifyChanged();
    };
  }

  private installRequestHandlers(client: Client, pluginId: string, serverId: string): void {
    const requestClient = client as unknown as {
      setRequestHandler(method: string, handler: (request: unknown) => Promise<unknown>): void;
    };
    if (this.options.onSampling) requestClient.setRequestHandler("sampling/createMessage", (request) => this.options.onSampling!(request, pluginId, serverId));
    if (this.options.onElicitation) requestClient.setRequestHandler("elicitation/create", (request) => this.options.onElicitation!(request, pluginId, serverId));
    if (this.options.onRoots) requestClient.setRequestHandler("roots/list", () => this.options.onRoots!(pluginId, serverId));
  }

  private async refreshCatalog(conn: Connected, signal?: AbortSignal): Promise<void> {
    if (conn.kind === "host") {
      if (!conn.host || !conn.hostKey) throw new Error("isolated MCP connection is missing its host key");
      const catalog = await conn.host.refresh(conn.hostKey, signal);
      conn.tools = catalog.tools;
      conn.prompts = catalog.prompts;
      conn.resources = catalog.resources;
      conn.resourceTemplates = catalog.resourceTemplates;
      return;
    }
    const options = signal ? { signal, cacheMode: "refresh" as const } : { cacheMode: "refresh" as const };
    const [tools, prompts, resources, resourceTemplates] = await Promise.all([
      optionalMcpCall(() => conn.client!.listTools(undefined, options), { tools: [] }),
      optionalMcpCall(() => conn.client!.listPrompts(undefined, options), { prompts: [] }),
      optionalMcpCall(() => conn.client!.listResources(undefined, options), { resources: [] }),
      optionalMcpCall(() => conn.client!.listResourceTemplates(undefined, options), { resourceTemplates: [] }),
    ]);
    conn.tools = tools.tools;
    conn.prompts = prompts.prompts;
    conn.resources = resources.resources;
    conn.resourceTemplates = resourceTemplates.resourceTemplates;
  }

  private onCatalogChanged(key: string, kind: "tools" | "prompts" | "resources", error: Error | null, items: unknown): void {
    if (error) this.log.warn(`MCP ${key} ${kind} refresh failed: ${errorText(error)}`);
    const conn = this.conns.get(key);
    if (conn && !error) {
      if (conn.kind === "host") {
        if (conn.host && conn.hostKey) {
          void conn.host.refresh(conn.hostKey).then((catalog) => {
            if (this.conns.get(key) !== conn) return;
            conn.tools = catalog.tools;
            conn.prompts = catalog.prompts;
            conn.resources = catalog.resources;
            conn.resourceTemplates = catalog.resourceTemplates;
            this.cacheCatalog(key, this.serverRecord(key.split(":", 2)[0]!, key.split(":", 2)[1]!).configJson, conn);
            void this.notifyChanged();
          }).catch((refreshError) => this.log.warn(`MCP ${key} isolated catalog refresh failed: ${errorText(refreshError)}`));
        }
        void this.notifyChanged();
        return;
      }
      if (kind === "tools" && Array.isArray(items)) conn.tools = items as Tool[];
      if (kind === "prompts" && Array.isArray(items)) conn.prompts = items as Prompt[];
      if (kind === "resources" && Array.isArray(items)) {
        conn.resources = items as Resource[];
        // MCP uses one resources/list_changed notification for both the
        // resources and resource-template catalogs. Refresh the latter too;
        // the SDK's listChanged option exposes the former callback only.
        void optionalMcpCall(
          () => conn.client!.listResourceTemplates(undefined, { cacheMode: "refresh" }),
          { resourceTemplates: [] },
        ).then((result) => {
          if (this.conns.get(key) === conn) {
            conn.resourceTemplates = result.resourceTemplates;
            const [pluginId, serverId] = key.split(":", 2);
            if (pluginId && serverId) {
              const record = this.store.listMcpServers(pluginId).find((item) => item.serverId === serverId);
              if (record) this.cacheCatalog(key, record.configJson, conn);
            }
          }
        }).catch((templateError) => this.log.warn(`MCP ${key} resource template refresh failed: ${errorText(templateError)}`));
      }
      const [pluginId, serverId] = key.split(":", 2);
      if (pluginId && serverId) {
        const record = this.store.listMcpServers(pluginId).find((item) => item.serverId === serverId);
        if (record) this.cacheCatalog(key, record.configJson, conn);
      }
    }
    void this.notifyChanged();
  }

  private serverRecord(pluginId: string, serverId: string) {
    const record = this.store.listMcpServers(pluginId).find((item) => item.serverId === serverId);
    if (!record) throw new Error(`MCP server not found: ${serverId}`);
    return record;
  }

  private validatedConfig(record: ReturnType<McpGateway["serverRecord"]>): ServerConfig {
    const cfg = parseServerConfig(record.configJson);
    if (!cfg) throw new Error(`invalid server config for ${record.serverId}`);
    const result = validateMcpServer(record.serverId, cfg);
    if (!result.valid) throw new Error(`invalid server config for ${record.serverId}: ${result.errors.join("; ")}`);
    return cfg;
  }

  private enabledApprovedServers() {
    return this.store.listMcpServers().filter((record) => record.enabled === 1 && record.approved === 1);
  }

  private async providerFor(pluginId: string, serverId: string, serverUrl: URL): Promise<McpOAuthProvider> {
    const key = keyOf(pluginId, serverId);
    const existing = this.providers.get(key);
    if (existing) return existing;
    if (!this.options.oauth) throw new Error("OAuth storage is not configured");
    const provider = await this.options.oauth.getProvider(pluginId, serverId, serverUrl);
    this.providers.set(key, provider);
    return provider;
  }

  private createHttpTransport(cfg: ServerConfig, provider: McpOAuthProvider): StreamableHTTPClientTransport | SSEClientTransport {
    const serverUrl = new URL(cfg.url!);
    const requestTimeout = this.options.requestTimeoutMs
      ?? (this.options.oauthTimeoutMs === undefined ? OAUTH_TIMEOUT_MS + FETCH_TIMEOUT_GRACE_MS : this.options.oauthTimeoutMs + FETCH_TIMEOUT_GRACE_MS);
    const fetchWithGuard = redirectGuardFetch(serverUrl, cfg.headers, requestTimeout);
    if (cfg.type === "streamable-http") {
      return new StreamableHTTPClientTransport(serverUrl, {
        authProvider: provider as OAuthClientProvider,
        requestInit: { redirect: "manual" },
        fetch: fetchWithGuard,
      });
    }
    return new SSEClientTransport(serverUrl, {
      authProvider: provider as OAuthClientProvider,
      requestInit: { redirect: "manual" },
      fetch: fetchWithGuard,
    });
  }

  private persistStatus(pluginId: string, serverId: string, status: "idle" | "ready" | "error" | "disabled" | "needs-approval" | "needs-auth", lastError: string | null): void {
    const record = this.store.listMcpServers(pluginId).find((item) => item.serverId === serverId);
    if (record) this.store.upsertMcpServer({ ...record, status, lastError });
  }

  private async notifyChanged(): Promise<void> {
    try { await this.options.onChanged?.(); } catch (error) { this.log.warn(`MCP change notification failed: ${errorText(error)}`); }
  }

  private async withAuthState<T>(pluginId: string, serverId: string, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      const provider = this.providers.get(keyOf(pluginId, serverId));
      if (provider && await provider.authorizationUrlValue()) {
        this.persistStatus(pluginId, serverId, "needs-auth", "Authentication required");
        await this.notifyChanged();
      }
      throw error;
    }
  }

  private async cancelPendingAuthentication(
    pluginId: string,
    serverId: string,
    provider: McpOAuthProvider,
    pending: PendingAuth | undefined,
    message = "Authentication was not completed",
  ): Promise<void> {
    const key = keyOf(pluginId, serverId);
    await provider.clearPending().catch((error) => this.log.warn(`clear MCP OAuth state ${key}: ${errorText(error)}`));
    if (pending) await this.closePendingAuth(key, pending);
    const record = this.serverRecord(pluginId, serverId);
    const status = record.enabled === 1 ? "needs-auth" : "disabled";
    this.persistStatus(pluginId, serverId, status, message);
    await this.notifyChanged();
  }

  private async closePendingAuth(key: string, pending: PendingAuth): Promise<void> {
    if (this.oauthPending.get(key) === pending) this.oauthPending.delete(key);
    try {
      // Closing the client is not sufficient for every SDK transport to
      // abort an in-flight token request. Close the transport explicitly so
      // a timed-out OAuth exchange cannot keep the plugin worker alive.
      await withTimeout(pending.transport.close(), CLOSE_TIMEOUT_MS, `close pending MCP OAuth transport ${key}`);
    } catch (error) {
      this.log.warn(`close pending MCP OAuth transport ${key}: ${errorText(error)}`);
    }
    try {
      await withTimeout(pending.client.close(), CLOSE_TIMEOUT_MS, `close pending MCP OAuth client ${key}`);
    } catch (error) {
      this.log.warn(`close pending MCP OAuth client ${key}: ${errorText(error)}`);
    }
  }

  private catalogTool(record: ReturnType<McpGateway["serverRecord"]>, cfg: ServerConfig, pluginName: string, tool: Tool): CatalogTool {
    const raw = tool as unknown as JsonRecord;
    return omitUndefined({
      opaqueId: exposedId("tool", record.pluginId, record.serverId, tool.name),
      pluginId: record.pluginId,
      pluginName,
      serverId: record.serverId,
      serverType: cfg.type,
      name: tool.name,
      description: tool.description?.trim() || `Call ${tool.name} on ${record.serverId}`,
      inputSchema: toolSchema(tool.inputSchema),
      outputSchema: optionalRecord(tool.outputSchema),
      annotations: optionalRecord(raw.annotations),
      execution: optionalRecord(raw.execution),
      icons: optionalRecordArray(raw.icons),
      _meta: optionalRecord(raw._meta),
      status: "ready",
    });
  }

  private toolError(record: ReturnType<McpGateway["serverRecord"]>, cfg: ServerConfig, error: unknown): CatalogTool {
    const message = errorText(error);
    return {
      opaqueId: exposedId("tool", record.pluginId, record.serverId, "__error__"),
      pluginId: record.pluginId,
      pluginName: this.store.getPlugin(record.pluginId)?.name ?? record.pluginId,
      serverId: record.serverId,
      serverType: cfg.type,
      name: `__error_${record.serverId}`,
      description: `MCP server ${record.serverId} failed: ${message}`,
      inputSchema: { type: "object", properties: {} },
      status: "error",
      error: message,
    };
  }

  private catalogPrompt(record: ReturnType<McpGateway["serverRecord"]>, cfg: ServerConfig, pluginName: string, prompt: Prompt): CatalogPrompt {
    const raw = prompt as unknown as JsonRecord;
    return omitUndefined({
      opaqueId: exposedId("prompt", record.pluginId, record.serverId, prompt.name),
      pluginId: record.pluginId,
      pluginName,
      serverId: record.serverId,
      serverType: cfg.type,
      name: prompt.name,
      title: typeof raw.title === "string" ? raw.title : undefined,
      description: prompt.description,
      arguments: optionalRecordArray(raw.arguments),
      icons: optionalRecordArray(raw.icons),
      _meta: optionalRecord(raw._meta),
      status: "ready",
    });
  }

  private catalogResource(record: ReturnType<McpGateway["serverRecord"]>, cfg: ServerConfig, pluginName: string, resource: Resource): CatalogResource {
    const raw = resource as unknown as JsonRecord;
    return omitUndefined({
      opaqueId: exposedId("resource", record.pluginId, record.serverId, resource.uri),
      pluginId: record.pluginId,
      pluginName,
      serverId: record.serverId,
      serverType: cfg.type,
      uri: resource.uri,
      name: resource.name,
      title: typeof raw.title === "string" ? raw.title : undefined,
      description: resource.description,
      mimeType: resource.mimeType,
      icons: optionalRecordArray(raw.icons),
      _meta: optionalRecord(raw._meta),
      status: "ready",
    });
  }

  private catalogResourceTemplate(record: ReturnType<McpGateway["serverRecord"]>, cfg: ServerConfig, pluginName: string, template: ResourceTemplateType): CatalogResourceTemplate {
    const raw = template as unknown as JsonRecord;
    return omitUndefined({
      opaqueId: exposedId("resource-template", record.pluginId, record.serverId, template.uriTemplate),
      pluginId: record.pluginId,
      pluginName,
      serverId: record.serverId,
      serverType: cfg.type,
      uriTemplate: template.uriTemplate,
      name: template.name,
      title: typeof raw.title === "string" ? raw.title : undefined,
      description: template.description,
      mimeType: template.mimeType,
      icons: optionalRecordArray(raw.icons),
      _meta: optionalRecord(raw._meta),
      status: "ready",
    });
  }
}
