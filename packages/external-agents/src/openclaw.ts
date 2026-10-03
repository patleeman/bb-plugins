import { resolveToken } from "./credentials.js";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { AvailableModel, HostDaemonAcpLaunchSpec } from "@get-bb/plugin-sdk/provider-bridge";
import { AgentConnectionError } from "./hermes-client.js";

export const openclawConnectionSchema = z.object({
  baseUrl: z.string().url().refine(value => { const u = new URL(value); return ["ws:", "wss:"].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash; }, "Use a Gateway WebSocket URL without credentials"),
  tokenEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/), enabled: z.boolean(),
  tokenEnvFile: z.string().optional(),
  stateDir: z.string().default(""), allowPrivateWs: z.boolean().default(false),
});
export type OpenClawConnection = z.infer<typeof openclawConnectionSchema>;
export function agentId(model: unknown): string {
  if (model === undefined || model === "") return "main";
  if (typeof model !== "string" || !/^openclaw\/[a-zA-Z0-9_-]+$/.test(model)) throw new AgentConnectionError("Select an OpenClaw Gateway agent model (openclaw/<agentId>).");
  return model.slice("openclaw/".length);
}
export function sessionKey(threadId: string, model: unknown): string {
  return `agent:${agentId(model)}:bb-${createHash("sha256").update(threadId).digest("hex")}`;
}
export function mapAgents(value: unknown): AvailableModel[] {
  const parsed = z.object({ defaultId: z.string().optional(), agents: z.array(z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]+$/), name: z.string().optional() })) }).safeParse(value);
  if (!parsed.success) throw new AgentConnectionError("OpenClaw returned an invalid agent catalog.");
  const defaultId = parsed.data.defaultId ?? parsed.data.agents[0]?.id;
  return parsed.data.agents.map(agent => ({ id: `openclaw/${agent.id}`, model: `openclaw/${agent.id}`, displayName: agent.name || agent.id, description: "OpenClaw Gateway agent", isDefault: agent.id === defaultId, defaultReasoningEffort: "none", supportedReasoningEfforts: [{ reasoningEffort: "none", description: "Agent default" }] }));
}
export async function prepareOpenClaw(connection: OpenClawConnection, root = tmpdir()) {
  const config = openclawConnectionSchema.parse(connection);
  if (!config.enabled) throw new AgentConnectionError("OpenClaw is disabled in External Agents settings.");
  const token = resolveToken(config.tokenEnv, config.tokenEnvFile);
  if (!token) throw new AgentConnectionError(`OpenClaw token is missing. Set ${config.tokenEnv} on the BB host.`);
  const directory = await mkdtemp(join(root, "bb-openclaw-"));
  const tokenFile = join(directory, "token");
  const configFile = join(directory, "config.json");
  const dispose = () => rm(directory, { recursive: true, force: true });
  try {
    await writeFile(tokenFile, token, { mode: 0o600, flag: "wx" });
    await writeFile(configFile, JSON.stringify({ gateway: { mode: "remote", remote: { url: config.baseUrl, token } } }), { mode: 0o600, flag: "wx" });
  } catch (error) { await dispose(); throw error; }
  const env = {
    OPENCLAW_CONFIG_PATH: configFile,
    ...(config.stateDir ? { OPENCLAW_STATE_DIR: config.stateDir } : {}),
    OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: config.allowPrivateWs ? "1" : "0",
  };
  return {
    dispose,
    launch(threadId: string, model: unknown): HostDaemonAcpLaunchSpec {
      return { displayName: "OpenClaw", command: "openclaw", args: ["acp", "--url", config.baseUrl, "--token-file", tokenFile, "--session", sessionKey(threadId, model), "--no-prefix-cwd"], env };
    },
    async agents(): Promise<AvailableModel[]> {
      const output = await new Promise<string>((resolve, reject) => {
        execFile("openclaw", ["gateway", "call", "agents.list", "--json", "--expect-url", config.baseUrl, "--timeout", "10000"], { env: { ...process.env, ...env }, timeout: 15_000, maxBuffer: 1_048_576 }, (error, stdout) => {
          if (error) {
            let missingReadScope = false;
            try { missingReadScope = JSON.parse(stdout)?.error?.details?.missingScope === "operator.read"; } catch { /* No structured CLI response. */ }
            reject(new AgentConnectionError(missingReadScope
              ? "OpenClaw paired client lacks operator.read. Grant this scope to list Gateway agents."
              : "OpenClaw Gateway is unavailable or rejected authentication. Check its URL, Tailscale, token, and paired client state."));
          }
          else resolve(stdout);
        });
      });
      try { return mapAgents(JSON.parse(output)); } catch (error) { if (error instanceof AgentConnectionError) throw error; throw new AgentConnectionError("OpenClaw returned an invalid agent catalog."); }
    },
  };
}
export async function openclawHealth(connection: OpenClawConnection) {
  let client: Awaited<ReturnType<typeof prepareOpenClaw>> | undefined;
  try {
    client = await prepareOpenClaw(connection);
    await client.agents();
    return { online: true, status: "ready" as const, message: "OpenClaw Gateway is reachable." };
  } catch (error) {
    return { online: false, status: "unknown" as const, message: error instanceof AgentConnectionError ? error.message : "OpenClaw configuration is invalid." };
  } finally { await client?.dispose(); }
}
