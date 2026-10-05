import * as http from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { McpGateway } from "./gateway.js";
import { McpOAuthProvider, type OAuthCredentialRecord, type OAuthCredentialStore } from "./oauth.js";
import { AgentPluginsStore } from "./store.js";
import type { PluginRecord } from "./types.js";

const databases: Database.Database[] = [];
const servers: http.Server[] = [];

class MemorySecrets implements OAuthCredentialStore {
  readonly records = new Map<string, OAuthCredentialRecord>();
  async get(key: string) { return this.records.get(key); }
  async set(key: string, value: OAuthCredentialRecord) { this.records.set(key, value); }
  async delete(key: string) { this.records.delete(key); }
}

function createStore(): AgentPluginsStore {
  const database = new Database(":memory:");
  databases.push(database);
  return new AgentPluginsStore(database, (db, statements) => { for (const statement of statements) db.exec(statement); });
}

function addPlugin(store: AgentPluginsStore): PluginRecord {
  const plugin: PluginRecord = {
    id: "oauth-plugin", name: "OAuth Plugin", version: "1.0.0", description: null, specVersion: "1.0.0",
    sourceType: "path", sourceIntent: "path:/tmp/oauth-plugin", sourceResolved: null, sourceRef: null, tagPrefix: null,
    pluginRoot: "/tmp", pluginData: "/tmp", activeGen: 1, status: "active", approval: "approved", lastError: null,
    contentHash: null, installedAt: 1, updatedAt: 1,
  };
  store.upsertPlugin(plugin);
  return plugin;
}

async function readBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response: http.ServerResponse, value: unknown, status = 200, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(value));
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const database of databases.splice(0)) database.close();
});

describe("MCP SDK OAuth integration", () => {
  it("handles WWW-Authenticate discovery, dynamic registration, PKCE callback, and bearer retry", async () => {
    let port = 0;
    let mcpUrl = "";
    let protectedMetadata = "";
    let issuer = "";
    let authorizationUrl = "";
    let tokenRequests = 0;
    let requireAdditionalScope = false;
    const oauthRequestHeaders: Record<string, string | undefined>[] = [];
    let mcpHeader: string | undefined;
    const accessToken = "fixture-access-token";
    const server = http.createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
      if (url.pathname.includes("oauth-protected-resource")) {
        oauthRequestHeaders.push({ fixed: headerValue(request.headers["x-fixed"]), authorization: headerValue(request.headers.authorization) });
        sendJson(response, { resource: mcpUrl, authorization_servers: [issuer] });
        return;
      }
      if (url.pathname.includes("oauth-authorization-server")) {
        oauthRequestHeaders.push({ fixed: headerValue(request.headers["x-fixed"]), authorization: headerValue(request.headers.authorization) });
        sendJson(response, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          registration_endpoint: `${issuer}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
        });
        return;
      }
      if (url.pathname.endsWith("/register")) {
        oauthRequestHeaders.push({ fixed: headerValue(request.headers["x-fixed"]), authorization: headerValue(request.headers.authorization) });
        await readBody(request);
        sendJson(response, { client_id: "fixture-client", redirect_uris: ["http://127.0.0.1/callback"], token_endpoint_auth_method: "none" });
        return;
      }
      if (url.pathname.endsWith("/token")) {
        oauthRequestHeaders.push({ fixed: headerValue(request.headers["x-fixed"]), authorization: headerValue(request.headers.authorization) });
        const body = await readBody(request);
        const form = new URLSearchParams(body);
        expect(form.get("grant_type")).toBe("authorization_code");
        expect(form.get("code_verifier")).toBeTruthy();
        tokenRequests += 1;
        sendJson(response, { access_token: accessToken, token_type: "Bearer", refresh_token: "fixture-refresh-token", expires_in: 3600 });
        return;
      }
      if (url.pathname === "/auth/authorize") {
        authorizationUrl = url.toString();
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("fixture authorization page");
        return;
      }
      if (url.pathname === "/mcp") {
        mcpHeader = headerValue(request.headers["x-fixed"]);
        if (request.headers.authorization !== `Bearer ${accessToken}`) {
          response.setHeader("www-authenticate", `Bearer resource_metadata="${protectedMetadata}"`);
          response.writeHead(401);
          response.end();
          return;
        }
        const body = await readBody(request);
        if (!body.trim()) { response.writeHead(202); response.end(); return; }
        const message = JSON.parse(body) as { id: number; method: string };
        if (message.method === "initialize") {
          sendJson(response, { jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "oauth-fixture", version: "1" } } }, 200, { "mcp-session-id": "oauth-session" });
        } else if (message.method === "notifications/initialized") {
          response.writeHead(202); response.end();
        } else if (message.method === "tools/list") {
          sendJson(response, { jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "oauth-tool", description: "OAuth tool", inputSchema: { type: "object" } }] } }, 200, { "mcp-session-id": "oauth-session" });
        } else if (message.method === "tools/call" && requireAdditionalScope) {
          response.setHeader("www-authenticate", `Bearer error="insufficient_scope" scope="calendar.write" resource_metadata="${protectedMetadata}"`);
          response.writeHead(403);
          response.end();
        } else {
          sendJson(response, { jsonrpc: "2.0", id: message.id, result: {} }, 200, { "mcp-session-id": "oauth-session" });
        }
        return;
      }
      response.writeHead(404); response.end();
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    port = (server.address() as { port: number }).port;
    mcpUrl = `http://127.0.0.1:${port}/mcp`;
    protectedMetadata = `http://127.0.0.1:${port}/.well-known/oauth-protected-resource`;
    issuer = `http://127.0.0.1:${port}/auth`;

    const store = createStore();
    const plugin = addPlugin(store);
    store.upsertMcpServer({
      pluginId: plugin.id, serverId: "fastmail", type: "streamable-http", configJson: JSON.stringify({ type: "streamable-http", url: mcpUrl, headers: { "X-Fixed": "mcp-secret" } }),
      status: "idle", lastError: null, approved: 1, enabled: 1,
    });
    const secrets = new MemorySecrets();
    let provider: McpOAuthProvider | undefined;
    const gateway = new McpGateway(store, { info() {}, warn() {}, error() {} }, {
      oauth: {
        async getProvider(pluginId, serverId, serverUrl) {
          provider ??= new McpOAuthProvider(`${pluginId}:${serverId}`, serverUrl, new URL("http://127.0.0.1/callback"), secrets);
          return provider;
        },
      },
    });

    await expect(gateway.startServer(plugin.id, "fastmail")).rejects.toThrow("authorization");
    expect(store.listMcpServers(plugin.id)[0]?.status).toBe("needs-auth");
    const url = await gateway.authUrl(plugin.id, "fastmail");
    expect(url).toBeTruthy();
    expect(url).toContain("code_challenge");
    expect(authorizationUrl).toBe("");
    const state = new URL(url!).searchParams.get("state");
    expect(state).toBeTruthy();

    await expect(gateway.finishAuth(plugin.id, "fastmail", new URLSearchParams({ code: "fixture-code" }))).rejects.toThrow("state mismatch");
    await expect(gateway.finishAuth(plugin.id, "fastmail", new URLSearchParams({ code: "fixture-code", state: "wrong" }))).rejects.toThrow("state mismatch");
    expect(tokenRequests).toBe(0);
    await gateway.finishAuth(plugin.id, "fastmail", new URLSearchParams({ code: "fixture-code", state: state! }));
    await expect(gateway.finishAuth(plugin.id, "fastmail", new URLSearchParams({ code: "fixture-code", state: state! }))).rejects.toThrow("state mismatch");
    const tools = await gateway.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["oauth-tool"]);
    expect(tokenRequests).toBe(1);
    expect(mcpHeader).toBe("mcp-secret");
    expect(oauthRequestHeaders.every((headers) => !headers.fixed && !headers.authorization)).toBe(true);
    expect(await gateway.authStatus(plugin.id, "fastmail")).toBe("authenticated");
    expect(store.listMcpServers(plugin.id)[0]?.status).toBe("ready");

    requireAdditionalScope = true;
    await expect(gateway.call(tools[0]!.opaqueId, {})).rejects.toThrow();
    expect(store.listMcpServers(plugin.id)[0]?.status).toBe("needs-auth");
    expect(await gateway.authStatus(plugin.id, "fastmail")).toBe("authorizing");
    const stepUpUrl = await gateway.authUrl(plugin.id, "fastmail");
    const stepUpState = new URL(stepUpUrl!).searchParams.get("state");
    expect(stepUpState).toBeTruthy();
    await gateway.finishAuth(plugin.id, "fastmail", new URLSearchParams({ code: "step-up-code", state: stepUpState! }));
    expect(store.listMcpServers(plugin.id)[0]?.status).toBe("ready");
    expect(await gateway.authStatus(plugin.id, "fastmail")).toBe("authenticated");

    expect(await gateway.reconnectServer(plugin.id, "fastmail")).toBeNull();
    expect(store.listMcpServers(plugin.id)[0]?.status).toBe("ready");
    expect(await gateway.authStatus(plugin.id, "fastmail")).toBe("authenticated");

    await gateway.clearAuthentication(plugin.id, "fastmail");
    expect(store.listMcpServers(plugin.id)[0]?.status).toBe("idle");
    expect(await gateway.authStatus(plugin.id, "fastmail")).toBe("unauthenticated");
    expect(secrets.records.get(`${plugin.id}:fastmail`)).toBeUndefined();
    await gateway.close();
  }, 30_000);

  it("bounds a hanging OAuth token exchange and clears pending transport state", async () => {
    let port = 0;
    let mcpUrl = "";
    let protectedMetadata = "";
    let issuer = "";
    const server = http.createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
      if (url.pathname === "/.well-known/oauth-protected-resource") {
        sendJson(response, { resource: mcpUrl, authorization_servers: [issuer] });
        return;
      }
      if (url.pathname.includes("oauth-authorization-server")) {
        sendJson(response, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          registration_endpoint: `${issuer}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
        });
        return;
      }
      if (url.pathname === "/auth/register") {
        await readBody(request);
        sendJson(response, { client_id: "hanging-client", redirect_uris: ["http://127.0.0.1/callback"], token_endpoint_auth_method: "none" });
        return;
      }
      if (url.pathname === "/auth/token") {
        // Deliberately never respond. The gateway must bound this request and
        // tear down the pending transport instead of wedging BB's server.
        return;
      }
      if (url.pathname === "/mcp") {
        response.setHeader("www-authenticate", `Bearer resource_metadata="${protectedMetadata}"`);
        response.writeHead(401);
        response.end();
        return;
      }
      response.writeHead(404);
      response.end();
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    port = (server.address() as { port: number }).port;
    mcpUrl = `http://127.0.0.1:${port}/mcp`;
    protectedMetadata = `http://127.0.0.1:${port}/.well-known/oauth-protected-resource`;
    issuer = `http://127.0.0.1:${port}/auth`;

    const store = createStore();
    const plugin = addPlugin(store);
    store.upsertMcpServer({
      pluginId: plugin.id,
      serverId: "hanging-oauth",
      type: "streamable-http",
      configJson: JSON.stringify({ type: "streamable-http", url: mcpUrl }),
      status: "idle",
      lastError: null,
      approved: 1,
      enabled: 1,
    });
    const secrets = new MemorySecrets();
    let changed = 0;
    const gateway = new McpGateway(store, { info() {}, warn() {}, error() {} }, {
      oauthTimeoutMs: 30,
      onChanged: async () => { changed += 1; },
      oauth: {
        async getProvider(pluginId, serverId, serverUrl) {
          return new McpOAuthProvider(`${pluginId}:${serverId}`, serverUrl, new URL("http://127.0.0.1/callback"), secrets);
        },
      },
    });

    await expect(gateway.startServer(plugin.id, "hanging-oauth")).rejects.toThrow("authorization");
    const url = await gateway.authUrl(plugin.id, "hanging-oauth");
    const state = new URL(url!).searchParams.get("state");
    await expect(gateway.finishAuth(plugin.id, "hanging-oauth", new URLSearchParams({ code: "hang", state: state! }))).rejects.toThrow("OAuth token exchange hanging-oauth timed out");
    expect(store.listMcpServers(plugin.id)[0]?.status).toBe("needs-auth");
    expect(store.listMcpServers(plugin.id)[0]?.lastError).toContain("OAuth token exchange hanging-oauth timed out");
    expect(changed).toBeGreaterThan(0);
    expect(await gateway.authStatus(plugin.id, "hanging-oauth")).toBe("unauthenticated");
    await gateway.close();
  }, 5_000);
});
