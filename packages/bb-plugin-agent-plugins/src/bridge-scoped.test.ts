import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.js";
import { McpGateway } from "./gateway.js";
import type { CatalogTool } from "./types.js";

const hosts: Array<ReturnType<typeof createFakePluginHost>> = [];
const tool: CatalogTool = {
  opaqueId: "fixture__healthy__echo_0123456789", pluginId: "fixture", pluginName: "Fixture",
  serverId: "healthy", serverType: "stdio", name: "echo", description: "Echo a value.",
  inputSchema: { type: "object", properties: { value: { type: "string" } } }, status: "ready",
};

async function createHost() {
  const host = createFakePluginHost({ pluginId: "agent-plugins" });
  hosts.push(host);
  await plugin(host.bb);
  return host.harness.behavior;
}

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.harness.lifecycle.dispose()));
  vi.restoreAllMocks();
});

describe("scoped static bridge contracts", () => {
  it("passes the server filter to discovery before searching; CLI uses the same scope", async () => {
    const list = vi.spyOn(McpGateway.prototype, "listTools").mockResolvedValue([tool]);
    const host = await createHost();
    const result = JSON.parse(String(await host.callAgentTool("agent_plugins_list_tools", { serverId: "healthy", query: "echo", limit: 1, offset: 0 })));
    expect(list).toHaveBeenCalledExactlyOnceWith("healthy");
    expect(result).toMatchObject({ total: 1, offset: 0, tools: [{ opaqueId: tool.opaqueId }], servers: [{ pluginName: "Fixture", serverId: "healthy", tools: 1 }] });
    expect(result.tools[0]).not.toHaveProperty("inputSchema");
    list.mockClear();
    const cli = await host.runCli(["tools", "--server", "healthy", "--json"]);
    expect(cli.exitCode).toBe(0);
    expect(list).toHaveBeenCalledExactlyOnceWith("healthy");
    expect(JSON.parse(cli.stdout!)).toEqual(result);
  });

  it("describes requested IDs without invoking global discovery, preserving notFound and deduplication", async () => {
    const list = vi.spyOn(McpGateway.prototype, "listTools");
    const resolve = vi.spyOn(McpGateway.prototype, "resolveTools").mockResolvedValue([tool]);
    const host = await createHost();
    const ids = [tool.opaqueId, "missing", tool.opaqueId];
    const result = JSON.parse(String(await host.callAgentTool("agent_plugins_describe_tool", { opaqueIds: ids })));
    expect(resolve).toHaveBeenCalledExactlyOnceWith(ids);
    expect(list).not.toHaveBeenCalled();
    expect(result).toEqual({ tools: [tool], notFound: ["missing"] });
    resolve.mockClear();
    const cli = await host.runCli(["describe", ...ids, "--json"]);
    expect(cli.exitCode).toBe(1);
    expect(resolve).toHaveBeenCalledExactlyOnceWith(ids);
    expect(JSON.parse(cli.stdout!)).toEqual(result);
    expect(list).not.toHaveBeenCalled();
  });

  it("retains strict input schemas, call defaults, cancellation and the error envelope", async () => {
    const list = vi.spyOn(McpGateway.prototype, "listTools");
    const call = vi.spyOn(McpGateway.prototype, "call").mockRejectedValue(new Error("fixture call error"));
    const host = await createHost();
    await expect(host.callAgentTool("agent_plugins_list_tools", { serverId: "healthy", unknown: true })).rejects.toThrow();
    await expect(host.callAgentTool("agent_plugins_list_tools", { limit: 201 })).rejects.toThrow();
    await expect(host.callAgentTool("agent_plugins_describe_tool", { opaqueIds: [] })).rejects.toThrow();
    await expect(host.callAgentTool("agent_plugins_describe_tool", { opaqueIds: Array(21).fill("id") })).rejects.toThrow();
    expect(list).not.toHaveBeenCalled();
    const signal = new AbortController().signal;
    const result = JSON.parse(String(await host.callAgentTool("agent_plugins_call", { opaqueId: tool.opaqueId }, { signal })));
    expect(call).toHaveBeenCalledExactlyOnceWith(tool.opaqueId, {}, signal);
    expect(result).toEqual({ isError: true, error: "fixture call error" });
  });
});
