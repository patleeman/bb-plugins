import * as http from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { McpGateway } from "./gateway.js";
import { DeferredOAuthCredentialStore, McpOAuthProvider, type OAuthCredentialRecord } from "./oauth.js";
import { AgentPluginsStore } from "./store.js";
import type { PluginRecord } from "./types.js";
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
async function fixture(allCapabilities = true) {
  let clock = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  const db = new Database(":memory:"); cleanup.push(() => { db.close(); });
  const store = new AgentPluginsStore(db, (db, statements) => { for (const statement of statements) db.exec(statement); });
  const plugin: PluginRecord = {
    id: "refresh-plugin", name: "Refresh fixture", version: "1", description: null, specVersion: "1.0.0",
    sourceType: "path", sourceIntent: "path:/tmp/fixture", sourceResolved: null, sourceRef: null, tagPrefix: null,
    pluginRoot: "/tmp", pluginData: "/tmp", activeGen: 1, status: "active", approval: "approved", lastError: null,
    contentHash: null, installedAt: 1, updatedAt: 1,
  };
  store.upsertPlugin(plugin);
  let parallelReads = false, releaseReads: (() => void) | undefined;
  let lateUnauthorized = false, releaseUnauthorized: (() => void) | undefined, acceptedAfterRefresh = false;
  let generation = 0, expiresAt = clock + 300_000, revoked = false, rejectFresh = false, origin = "";
  const counts = { refresh: 0, invalid: 0, reads: 0, unauthorized: 0, registrations: 0 };
  const json = (res: http.ServerResponse, value: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
  const server = http.createServer(async (req, res) => {
    if (req.url?.includes("oauth-protected-resource")) return json(res, { resource: origin + "/mcp", authorization_servers: [origin], scopes_supported: ["fixture:read"] });
    if (req.url?.includes("oauth-authorization-server")) return json(res, {
      issuer: origin, authorization_endpoint: origin + "/authorize", token_endpoint: origin + "/token", registration_endpoint: origin + "/register",
      response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"], scopes_supported: ["fixture:read"],
    });
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    if (req.url === "/token") {
      counts.refresh++;
      const form = new URLSearchParams(body);
      if (form.get("grant_type") !== "refresh_token" || form.get("client_id") !== "fixture-client" || form.get("resource") !== origin + "/mcp" || form.get("refresh_token") !== `fixture-refresh-${generation}` || revoked) {
        counts.invalid++; return json(res, { error: "invalid_grant" }, 400);
      }
      generation++; expiresAt = clock + 300_000;
      return json(res, { access_token: `fixture-access-${generation}`, refresh_token: `fixture-refresh-${generation}`, token_type: "Bearer", expires_in: 300, scope: "fixture:read" });
    }
    if (req.url === "/register") { counts.registrations++; return json(res, { error: "unexpected_registration" }, 400); }
    if (req.url !== "/mcp") return json(res, {}, 404);
    if (revoked || rejectFresh && generation > 0 || clock >= expiresAt || req.headers.authorization !== `Bearer fixture-access-${generation}`) {
      counts.unauthorized++;
      if (lateUnauthorized && counts.unauthorized === 2 && !acceptedAfterRefresh) await new Promise<void>(resolve => { releaseUnauthorized = resolve; });
      res.setHeader("www-authenticate", `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="fixture:read"`);
      return json(res, { error: "invalid_token" }, 401);
    }
    if (req.method === "GET") return json(res, {}, 405);
    if (!body) { res.writeHead(202); return res.end(); }
    const message = JSON.parse(body);
    if (message.method === "notifications/initialized") { res.writeHead(202); return res.end(); }
    if (message.method === "initialize") return json(res, { jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-11-25", capabilities: allCapabilities ? { tools: {}, prompts: {}, resources: {} } : { tools: {} }, serverInfo: { name: "refresh-fixture", version: "1" } } });
    if (message.method === "tools/list") return json(res, { jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "read", inputSchema: { type: "object" } }] } });
    if (message.method === "prompts/list") return json(res, { jsonrpc: "2.0", id: message.id, result: { prompts: [] } });
    if (message.method === "resources/list") return json(res, { jsonrpc: "2.0", id: message.id, result: { resources: [] } });
    if (message.method === "resources/templates/list") return json(res, { jsonrpc: "2.0", id: message.id, result: { resourceTemplates: [] } });
    if (message.method === "tools/call") {
      counts.reads++;
      if (generation > 0) { acceptedAfterRefresh = true; releaseUnauthorized?.(); }
      if (parallelReads) {
        if (counts.reads < 2) await new Promise<void>(resolve => { releaseReads = resolve; });
        else releaseReads?.();
      }
    }
    return json(res, { jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "authenticated fixture read" }] } });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  store.upsertMcpServer({ pluginId: plugin.id, serverId: "fixture", type: "streamable-http", configJson: JSON.stringify({ type: "streamable-http", url: origin + "/mcp" }), status: "idle", lastError: null, approved: 1, enabled: 1 });
  let persisted: Record<string, OAuthCredentialRecord> = {};
  const backend = { async load() { return structuredClone(persisted); }, async save(value: Record<string, OAuthCredentialRecord>) { persisted = structuredClone(value); } };
  const secrets = new DeferredOAuthCredentialStore(backend);
  const provider = new McpOAuthProvider("fixture", new URL(origin + "/mcp"), new URL("http://127.0.0.1/callback"), secrets);
  await provider.saveClientInformation({ client_id: "fixture-client", token_endpoint_auth_method: "none", issuer: origin });
  await provider.saveTokens({ access_token: "fixture-access-0", refresh_token: "fixture-refresh-0", token_type: "Bearer", scope: "fixture:read", issuer: origin });
  const newGateway = (clientProvider: McpOAuthProvider) => {
    const gateway = new McpGateway(store, { info() {}, warn() {}, error() {} }, { oauth: { async getProvider() { return clientProvider; } } });
    cleanup.push(() => gateway.close()); return gateway;
  };
  const gateway = newGateway(provider);
  clock += 1000; await gateway.startServer(plugin.id, "fixture");
  const id = (await gateway.listTools())[0]!.opaqueId;
  return { gateway, id, counts, provider, store, backend, advance(milliseconds = 301_000) { clock += milliseconds; }, parallelReads() { parallelReads = true; }, delayUnauthorized() { lateUnauthorized = true; }, revoke() { revoked = true; }, rejectFresh() { rejectFresh = true; },
    async restartClient() {
      await gateway.close();
      const reloaded = new McpOAuthProvider("fixture", new URL(origin + "/mcp"), new URL("http://127.0.0.1/callback"), new DeferredOAuthCredentialStore(backend));
      const nextGateway = newGateway(reloaded);
      clock += 1000; await nextGateway.startServer(plugin.id, "fixture");
      return { gateway: nextGateway, provider: reloaded };
    } };
}
describe("rotating OAuth refresh over real HTTP", () => {
  it("refreshes an expired token for a single authenticated request", async () => {
    const f = await fixture(false); f.advance(299_500);
    await f.gateway.call(f.id, {});
    expect(f.counts).toMatchObject({ refresh: 1, invalid: 0, reads: 1, registrations: 0 });
  });
  it("keeps a valid grant for concurrent tools-only reads after access expiry", async () => {
    const f = await fixture(false); f.advance(299_500);
    const results = await Promise.allSettled([f.gateway.call(f.id, {}), f.gateway.call(f.id, {})]);
    expect({ outcomes: results.map(r => r.status), counts: f.counts }).toMatchObject({ outcomes: ["fulfilled", "fulfilled"], counts: { refresh: 1, invalid: 0, reads: 2 } });
    expect(await f.provider.status()).toBe("authenticated");
  });
  it("reuses the saved outcome for a late 401 after refresh has completed", async () => {
    const f = await fixture(false); f.advance(299_500); f.delayUnauthorized();
    await Promise.all([f.gateway.call(f.id, {}), f.gateway.call(f.id, {})]);
    expect(f.counts).toMatchObject({ refresh: 1, invalid: 0, reads: 2, unauthorized: 2 });
  });
  it("keeps authenticated reads parallel", async () => {
    const f = await fixture(false); f.parallelReads();
    await Promise.all([f.gateway.call(f.id, {}), f.gateway.call(f.id, {})]);
    expect(f.counts).toMatchObject({ refresh: 0, reads: 2 });
  });
  it("reuses the persisted rotated pair after reconnect and client reconstruction", async () => {
    const f = await fixture(false); f.advance(299_500);
    await f.gateway.call(f.id, {});
    await f.gateway.reconnectServer("refresh-plugin", "fixture");
    expect(f.counts.refresh).toBe(1);
    const client = await f.restartClient();
    await client.gateway.call(f.id, {});
    f.advance(299_500);
    await client.gateway.call(f.id, {});
    expect(f.counts).toMatchObject({ refresh: 2, invalid: 0, reads: 3, registrations: 0 });
    expect(await client.provider.status()).toBe("authenticated");
  });
  it("shares one rejected refresh and reports needs-auth without replaying a revoked grant", async () => {
    const f = await fixture(false); f.revoke();
    const results = await Promise.allSettled([f.gateway.call(f.id, {}), f.gateway.call(f.id, {})]);
    expect(results.map(r => r.status)).toEqual(["rejected", "rejected"]);
    expect(f.counts).toMatchObject({ refresh: 1, invalid: 1, reads: 0 });
    expect(f.store.listMcpServers()[0]).toMatchObject({ status: "needs-auth", lastError: "MCP authorization is required" });
    expect(await f.gateway.authStatus("refresh-plugin", "fixture")).toBe("authorizing");
    expect((await f.gateway.status())["refresh-plugin:fixture"]).toBe("needs-auth");
    await expect(f.gateway.call(f.id, {})).rejects.toThrow("authorization is required");
    expect(f.counts.refresh).toBe(1);
  });
  it("stops after refreshed credentials are rejected and clears false ready/authenticated state", async () => {
    const f = await fixture(false); f.advance(299_500); f.rejectFresh();
    await expect(f.gateway.call(f.id, {})).rejects.toThrow("rejected refreshed credentials");
    expect(f.counts).toMatchObject({ refresh: 1, invalid: 0, reads: 0, unauthorized: 2 });
    expect(f.store.listMcpServers()[0]?.status).toBe("needs-auth");
    expect(await f.gateway.authStatus("refresh-plugin", "fixture")).toBe("unauthenticated");
    expect((await f.gateway.status())["refresh-plugin:fixture"]).toBe("needs-auth");
    await expect(f.gateway.call(f.id, {})).rejects.toThrow("authorization is required");
    expect(f.counts.refresh).toBe(1);
  });
  it("coordinates each provider separately", async () => {
    const first = await fixture(false), second = await fixture(false);
    first.advance(299_500); second.advance(299_500);
    await Promise.all([first.gateway.call(first.id, {}), second.gateway.call(second.id, {})]);
    expect(first.counts).toMatchObject({ refresh: 1, invalid: 0, reads: 1 });
    expect(second.counts).toMatchObject({ refresh: 1, invalid: 0, reads: 1 });
  });
  it("keeps a valid rotating grant during concurrent catalogue refresh", async () => {
    const f = await fixture(); f.advance();
    const tools = await f.gateway.listTools();
    expect({ names: tools.map(t => t.name), counts: f.counts }).toMatchObject({ names: ["read"], counts: { refresh: 1, invalid: 0 } });
    await f.gateway.call(f.id, {});
    expect(f.counts).toMatchObject({ refresh: 1, invalid: 0, reads: 1, registrations: 0 });
    expect(await f.provider.status()).toBe("authenticated");
  });
});
