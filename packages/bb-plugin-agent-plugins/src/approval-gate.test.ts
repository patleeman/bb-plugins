import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { GrantGate, GrantRefusedError, CONFIRM_TOKEN_TTL_MS } from "./approvals.js";
import { rimraf } from "./safe-fs.js";

const hosts: Array<ReturnType<typeof createFakePluginHost>> = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.harness.lifecycle.dispose()));
  while (tempDirs.length > 0) await rimraf(tempDirs.pop()!);
});

type Server = { serverId: string; approved: number; enabled: boolean; status: string };
type Request = { id: string; pluginId: string; serverId: string; source: string; threadId: string | null; reason: string | null };
type Snapshot = { plugins: Array<{ id: string; status: string }>; mcpServers: Server[]; requests: Request[] };

async function writePlugin(source: string, body = "console.log('v1')"): Promise<void> {
  await fsp.writeFile(path.join(source, "plugin.json"), JSON.stringify({
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name: "gate-example",
    version: "1.0.0",
  }));
  await fsp.writeFile(path.join(source, "mcp.json"), JSON.stringify({
    $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
    mcpServers: { docs: { type: "stdio", command: "node", args: ["${PLUGIN_ROOT}/server.js"] } },
  }));
  await fsp.writeFile(path.join(source, "server.js"), body);
}

async function setup() {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-plugins-gate-data-"));
  const source = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-plugins-gate-source-"));
  tempDirs.push(dataDir, source);
  await writePlugin(source);
  const host = createFakePluginHost({
    pluginId: "agent-plugins",
    sdk: { system: { config: async () => ({ dataDir }) } },
  });
  hosts.push(host);
  await plugin(host.bb);
  const installed = (await host.harness.callRpc("install", { source: `path:${source}` })) as { id: string };
  const snapshot = async () => (await host.harness.callRpc("snapshot", null)) as Snapshot;
  const docs = async () => (await snapshot()).mcpServers.find((server) => server.serverId === "docs")!;
  /** What the page does: ask for a token, then read it off realtime. */
  const confirmToken = async (action: string, serverId?: string): Promise<string> => {
    const clientNonce = `nonce-${Math.random().toString(16).slice(2)}-${Date.now()}`;
    const reply = await host.harness.callRpc("requestConfirmToken", { action, id: installed.id, ...(serverId ? { serverId } : {}), clientNonce });
    // The token never travels in the RPC reply.
    expect(reply).toEqual({ sent: true });
    const signal = host.harness.inspection.realtimeSignals
      .filter((s) => s.channel === "agent-plugins-confirm")
      .map((s) => s.payload as { clientNonce: string; token: string })
      .find((payload) => payload.clientNonce === clientNonce);
    expect(signal).toBeDefined();
    return signal!.token;
  };
  return { host, source, installed, snapshot, docs, confirmToken };
}

describe("MCP server approval gate", () => {
  it("turns a CLI approve into a pending request and never approves", async () => {
    const { host, installed, docs, snapshot } = await setup();
    expect((await docs()).approved).toBe(0);

    const result = await host.harness.runCli(["approve", installed.id, "docs", "--reason", "Need docs", "--json"], { threadId: "thr_agent" });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ approved: false, requested: true });
    expect((await docs()).approved).toBe(0);
    expect((await snapshot()).requests).toEqual([
      expect.objectContaining({ pluginId: installed.id, serverId: "docs", source: "cli", threadId: "thr_agent", reason: "Need docs" }),
    ]);

    const again = await host.harness.runCli(["request-approval", installed.id, "docs"]);
    expect(again.stdout).toContain("NOT approved");
    expect((await snapshot()).requests).toHaveLength(1);

    const listed = await host.harness.runCli(["requests", "--json"]);
    expect(JSON.parse(listed.stdout).requests).toHaveLength(1);
  });

  it("lets an agent tool request approval but not grant it", async () => {
    const { host, installed, docs, snapshot } = await setup();
    const output = await host.harness.callAgentTool(
      "agent_plugins_request_approval",
      { pluginId: installed.id, serverId: "docs", reason: "Search docs" },
      { threadId: "thr_agent" },
    );
    expect(JSON.parse(output as string)).toMatchObject({ approved: false, requested: true });
    expect((await docs()).approved).toBe(0);
    expect((await snapshot()).requests[0]).toMatchObject({ source: "agent", threadId: "thr_agent" });
  });

  it("refuses an RPC approve or toggle without a person's confirmation", async () => {
    const { host, installed, docs } = await setup();
    await expect(host.harness.callRpc("approve", { id: installed.id, serverId: "docs" })).rejects.toThrow(/Only a person/);
    await expect(host.harness.callRpc("approve", { id: installed.id, serverId: "docs", confirmToken: "made-up" })).rejects.toThrow(/expired or does not match/);
    await expect(host.harness.callRpc("setMcpEnabled", { id: installed.id, serverId: "docs", enabled: false })).rejects.toThrow(/Only a person/);
    expect(await docs()).toMatchObject({ approved: 0, enabled: true });
  });

  it("approves from the page with a realtime token, clears the request, and spends the token", async () => {
    const { host, installed, docs, snapshot, confirmToken } = await setup();
    await host.harness.runCli(["request-approval", installed.id, "docs"]);

    // A token minted for another action does not approve.
    const enableToken = await confirmToken("enable", "docs");
    await expect(host.harness.callRpc("approve", { id: installed.id, serverId: "docs", confirmToken: enableToken })).rejects.toThrow(/does not match/);

    const token = await confirmToken("approve", "docs");
    expect(await host.harness.callRpc("approve", { id: installed.id, serverId: "docs", confirmToken: token })).toEqual({ approved: true });
    expect((await docs()).approved).toBe(1);
    expect((await snapshot()).requests).toEqual([]);

    // Single use: replaying it for a later change is refused.
    await expect(host.harness.callRpc("setMcpEnabled", { id: installed.id, serverId: "docs", enabled: false, confirmToken: token })).rejects.toThrow(/does not match/);

    const disableToken = await confirmToken("disable", "docs");
    await host.harness.callRpc("setMcpEnabled", { id: installed.id, serverId: "docs", enabled: false, confirmToken: disableToken });
    expect(await docs()).toMatchObject({ approved: 1, enabled: false });
  });

  it("lets the user decline a request without approving", async () => {
    const { host, installed, docs, snapshot } = await setup();
    await host.harness.runCli(["request-approval", installed.id, "docs"]);
    const [request] = (await snapshot()).requests;
    expect(await host.harness.callRpc("declineRequest", { requestId: request!.id })).toEqual({ declined: true });
    expect((await snapshot()).requests).toEqual([]);
    expect((await docs()).approved).toBe(0);
  });

  it("keeps listing working for CLI and RPC callers", async () => {
    const { host, installed } = await setup();
    const list = await host.harness.runCli(["list", "--json"]);
    expect(list.exitCode).toBe(0);
    expect(JSON.parse(list.stdout)).toEqual([expect.objectContaining({ id: installed.id, name: "gate-example" })]);
    const show = await host.harness.runCli(["show", installed.id]);
    expect(JSON.parse(show.stdout).mcpServers).toEqual([expect.objectContaining({ serverId: "docs", approved: 0 })]);
    expect(await host.harness.callRpc("listTools", null)).toEqual({ tools: [] });
  });

  it("revokes a stdio approval when a CLI update changes the plugin's code, but not for a confirmed update", async () => {
    const { host, source, installed, docs, snapshot, confirmToken } = await setup();
    const token = await confirmToken("approve", "docs");
    await host.harness.callRpc("approve", { id: installed.id, serverId: "docs", confirmToken: token });
    expect((await docs()).approved).toBe(1);

    // Same command, same args, different code: the CLI update must not carry approval over.
    await writePlugin(source, "console.log('v2: something else')");
    const updated = await host.harness.runCli(["update", installed.id], { threadId: "thr_agent" });
    expect(updated.exitCode).toBe(0);
    expect(await docs()).toMatchObject({ approved: 0, status: "needs-approval" });
    expect((await snapshot()).requests).toEqual([
      expect.objectContaining({ serverId: "docs", source: "update", threadId: "thr_agent" }),
    ]);

    const again = await confirmToken("approve", "docs");
    await host.harness.callRpc("approve", { id: installed.id, serverId: "docs", confirmToken: again });

    // A person confirming the update in the page keeps the approval.
    await writePlugin(source, "console.log('v3')");
    const updateToken = await confirmToken("update");
    await host.harness.callRpc("update", { id: installed.id, confirmToken: updateToken });
    expect((await docs()).approved).toBe(1);

    // An unchanged update from the CLI keeps it too.
    await host.harness.runCli(["update", installed.id]);
    expect((await docs()).approved).toBe(1);
  });
});

describe("GrantGate", () => {
  it("refuses calls from other plugins even with a valid token", () => {
    const gate = new GrantGate();
    const target = { action: "approve" as const, pluginId: "p", serverId: "s" };
    const { token } = gate.issue(target);
    expect(() => gate.assert({ experimental_caller: { kind: "plugin", pluginId: "other" } }, target, token)).toThrow(GrantRefusedError);
  });

  it("accepts a matching token once, from a client caller or a host without caller info", () => {
    const gate = new GrantGate();
    const target = { action: "approve" as const, pluginId: "p", serverId: "s" };
    const first = gate.issue(target).token;
    expect(() => gate.assert({ experimental_caller: { kind: "client" } }, target, first)).not.toThrow();
    expect(() => gate.assert(undefined, target, first)).toThrow(GrantRefusedError);
    const second = gate.issue(target).token;
    expect(() => gate.assert(undefined, target, second)).not.toThrow();
  });

  it("rejects an expired token or one for another server", () => {
    let now = 1_000;
    const gate = new GrantGate(() => now);
    const target = { action: "approve" as const, pluginId: "p", serverId: "s" };
    const other = gate.issue({ ...target, serverId: "t" }).token;
    expect(() => gate.assert(undefined, target, other)).toThrow(/does not match/);
    const late = gate.issue(target).token;
    now += CONFIRM_TOKEN_TTL_MS + 1;
    expect(() => gate.assert(undefined, target, late)).toThrow(/expired/);
  });
});
