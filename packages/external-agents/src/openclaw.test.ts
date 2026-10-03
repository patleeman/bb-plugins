import { afterEach, expect, it, vi } from "vitest";
import { stat, readFile } from "node:fs/promises";
import { agentId, sessionKey, mapAgents, prepareOpenClaw, openclawHealth } from "./openclaw.js";
import { homedir } from "node:os";
import { join } from "node:path";

afterEach(() => vi.unstubAllEnvs());

it("maps Gateway agents to BB models with the declared default", () => {
  const models = mapAgents({ defaultId: "worker", agents: [{ id: "main" }, { id: "worker", name: "Worker" }] });
  expect(models.map(m => [m.id, m.isDefault])).toEqual([["openclaw/main", false], ["openclaw/worker", true]]);
  expect(() => agentId("claude/model")).toThrow("Select an OpenClaw");
});
it("isolates sessions between BB threads and Gateway agents", () => {
  expect(sessionKey("thread-1", "openclaw/main")).toBe(sessionKey("thread-1", "openclaw/main"));
  expect(sessionKey("thread-1", "openclaw/main")).not.toBe(sessionKey("thread-2", "openclaw/main"));
  expect(sessionKey("thread-1", "openclaw/main")).not.toBe(sessionKey("thread-1", "openclaw/worker"));
});
it("keeps the credential out of ACP argv and removes private temporary files", async () => {
  process.env.BB_TEST_OPENCLAW_TOKEN = "fixture-secret";
  const client = await prepareOpenClaw({ enabled: true, baseUrl: "ws://127.0.0.1:1", tokenEnv: "BB_TEST_OPENCLAW_TOKEN", stateDir: "", allowPrivateWs: false });
  try {
    const launch = client.launch("thread-1", "openclaw/main");
    expect(JSON.stringify(launch)).not.toContain("fixture-secret");
    const tokenFile = launch.args[launch.args.indexOf("--token-file") + 1]!;
    expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);
    expect(await readFile(tokenFile, "utf8")).toBe("fixture-secret");
    await client.dispose();
    await expect(stat(tokenFile)).rejects.toThrow();
  } finally { await client.dispose(); delete process.env.BB_TEST_OPENCLAW_TOKEN; }
});
it.runIf(process.env.BB_EXTERNAL_LIVE === "1")("discovers red4 Gateway agents and authenticated health", async () => {
  // The installed CLI intentionally suppresses stdout under VITEST unless opted in.
  vi.stubEnv("OPENCLAW_TEST_RUNTIME_LOG", "1");
  const config = { enabled: true, baseUrl: "ws://100.69.111.53:18789", tokenEnv: "RED4_OPENCLAW_TOKEN", stateDir: join(homedir(), ".config/agent-keys/openclaw-client"), allowPrivateWs: true };
  const client = await prepareOpenClaw(config);
  try { expect((await client.agents()).length).toBeGreaterThan(0); }
  finally { await client.dispose(); }
  expect(await openclawHealth(config)).toMatchObject({ online: true, status: "ready" });
}, 40_000);
