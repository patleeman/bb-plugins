import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { rimraf } from "./safe-fs.js";

const hosts: Array<ReturnType<typeof createFakePluginHost>> = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.harness.lifecycle.dispose()));
  while (tempDirs.length > 0) await rimraf(tempDirs.pop()!);
});

describe("Agent Plugins OAuth route", () => {
  it("accepts provider redirects without BB browser authentication and rejects missing context", async () => {
    const host = createFakePluginHost({ pluginId: "agent-plugins" });
    hosts.push(host);
    await plugin(host.bb);
    const callback = host.harness.registrations.httpRoutes.find((route) => route.path === "/oauth/callback");
    expect(callback?.auth).toBe("none");
    const route = callback!;
    const response = await route.handler({ req: { url: "https://bb.example.test/api/v1/plugins/agent-plugins/http/oauth/callback" } } as Parameters<typeof route.handler>[0]);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Missing Agent Plugins OAuth callback context");
  });
});

describe("Agent Plugins update flow", () => {
  it("keeps the installed identity, data path, and disabled skill state across an update", async () => {
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-plugins-data-"));
    const source = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-plugins-source-"));
    tempDirs.push(dataDir, source);
    await writePlugin(source, "1.0.0", "first version");

    const host = createFakePluginHost({
      pluginId: "agent-plugins",
      sdk: { system: { config: async () => ({ dataDir }) } },
    });
    hosts.push(host);
    await plugin(host.bb);

    const installed = (await host.harness.callRpc("install", { source: `path:${source}` })) as { id: string };
    const before = (await host.harness.callRpc("snapshot", null)) as Snapshot;
    const beforePlugin = before.plugins[0]!;
    expect(beforePlugin.id).toBe(installed.id);

    await host.harness.callRpc("setSkillEnabled", {
      id: installed.id,
      skillName: "research",
      enabled: false,
    });
    await fsp.writeFile(path.join(source, "plugin.json"), JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "example-plugin",
      version: "1.1.0",
      description: "updated",
    }));
    await fsp.writeFile(path.join(source, "skills", "research", "SKILL.md"), [
      "---",
      "name: research",
      "description: Research updated sources.",
      "---",
      "second version",
      "",
    ].join("\n"));

    const updated = (await host.harness.callRpc("update", { id: installed.id })) as { id: string; version: string | null };
    const after = (await host.harness.callRpc("snapshot", null)) as Snapshot;
    const afterPlugin = after.plugins[0]!;
    const afterSkill = after.skills.find((skill) => skill.skillName === "research")!;

    expect(updated).toMatchObject({ id: installed.id, version: "1.1.0" });
    expect(afterPlugin).toMatchObject({
      id: installed.id,
      version: "1.1.0",
      pluginData: beforePlugin.pluginData,
      installedAt: beforePlugin.installedAt,
    });
    expect(afterPlugin.pluginRoot).not.toBe(beforePlugin.pluginRoot);
    expect(afterSkill.enabled).toBe(false);
    expect(afterSkill.materializedPath).toBeNull();
  });

  it("reports a tracked local source as outdated without installing it", async () => {
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-plugins-data-"));
    const source = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-plugins-source-"));
    tempDirs.push(dataDir, source);
    await writePlugin(source, "1.0.0", "first version");

    const host = createFakePluginHost({
      pluginId: "agent-plugins",
      sdk: { system: { config: async () => ({ dataDir }) } },
    });
    hosts.push(host);
    await plugin(host.bb);

    const installed = (await host.harness.callRpc("install", { source: `path:${source}` })) as { id: string };
    await fsp.writeFile(path.join(source, "plugin.json"), JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "example-plugin",
      version: "1.1.0",
    }));

    const result = (await host.harness.callRpc("checkUpdates", { id: installed.id })) as { updates: Array<{ available: boolean; latestVersion: string | null }> };
    expect(result.updates).toEqual([expect.objectContaining({ available: true, latestVersion: "1.1.0" })]);
  });

  it("queues page-wide update checks for the background worker", async () => {
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-plugins-data-"));
    const source = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-plugins-source-"));
    tempDirs.push(dataDir, source);
    await writePlugin(source, "1.0.0", "first version");

    const host = createFakePluginHost({
      pluginId: "agent-plugins",
      sdk: { system: { config: async () => ({ dataDir }) } },
    });
    hosts.push(host);
    await plugin(host.bb);
    const installed = (await host.harness.callRpc("install", { source: `path:${source}` })) as { id: string };
    await fsp.writeFile(path.join(source, "plugin.json"), JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "example-plugin",
      version: "1.1.0",
    }));

    const queued = (await host.harness.callRpc("checkUpdates", {})) as { updates: unknown[] };
    expect(queued.updates).toEqual([]);
    const service = host.harness.behavior.runService("update-checker");
    const result = (await host.harness.callRpc("checkUpdates", { id: installed.id })) as { updates: Array<{ available: boolean; latestVersion: string | null }> };
    expect(result.updates).toEqual([expect.objectContaining({ available: true, latestVersion: "1.1.0" })]);
    service.controller.abort();
    await service.done;
  });
});

async function writePlugin(source: string, version: string, body: string): Promise<void> {
  await fsp.mkdir(path.join(source, "skills", "research"), { recursive: true });
  await fsp.writeFile(path.join(source, "plugin.json"), JSON.stringify({
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name: "example-plugin",
    version,
    description: "Example plugin",
  }));
  await fsp.writeFile(path.join(source, "skills", "research", "SKILL.md"), [
    "---",
    "name: research",
    "description: Research sources.",
    "---",
    body,
    "",
  ].join("\n"));
}

type Snapshot = {
  plugins: Array<Record<string, unknown>>;
  skills: Array<Record<string, unknown>>;
};
