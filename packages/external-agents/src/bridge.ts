import { experimental_acpProviderBridge } from "@get-bb/plugin-sdk/provider-bridge/acp";
import { createBridgeIo, experimental_defineProviderBridge, type ProviderBridgeEntry, type ProviderBridgeContext } from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";
import { createHermesBridge } from "./hermes-bridge.js";
import { AgentConnectionError } from "./hermes-client.js";
import { openclawConnectionSchema, openclawHealth, prepareOpenClaw } from "./openclaw.js";

export function createProviderBridge(dependencies: {
  acp?: ProviderBridgeEntry;
  hermes?: ProviderBridgeEntry;
  prepare?: typeof prepareOpenClaw;
  health?: typeof openclawHealth;
  write?: (line: string) => void;
} = {}) {
const acp = dependencies.acp ?? experimental_acpProviderBridge;
const prepare = dependencies.prepare ?? prepareOpenClaw;
const health = dependencies.health ?? openclawHealth;
const hermes = dependencies.hermes ?? createHermesBridge(dependencies.write);
const io = createBridgeIo<unknown>({ write: dependencies.write });
const routes = new Map<string, "hermes" | "openclaw">();
const launches = new Map<string, Awaited<ReturnType<typeof prepareOpenClaw>>>();
let context: ProviderBridgeContext | undefined;
let activeProvider = "hermes";
const selectedModels = new Map<string, string>();
const generations = new Map<string, number>();

async function handleLine(line: string) {
  let request: Record<string, any>;
  try { request = JSON.parse(line); } catch { return; }
  if (!request || typeof request !== "object") return;
  const params = request.params || {};
  const options = params.options?.providerOptions ?? params.providerOptions;
  const provider = options?.provider ?? routes.get(params.threadId) ?? activeProvider;
  // Both provider implementations support these minimum common capabilities.
  if (request.method === "initialize") { hermes.handleLine(line); return; }
  if (provider !== "openclaw") { hermes.handleLine(line); return; }
  activeProvider = "openclaw";
  try {
    if (request.method === "provider/health") {
      const result = await health(openclawConnectionSchema.parse(options));
      io.sendResult(request.id, { supported: true, health: { status: result.status, statusMessage: result.message, accountEmail: null, planLabel: null, installedVersion: null, minimumSupportedVersion: null, canInstall: false, canUpdate: false, loginCommand: null } });
      return;
    }
    if (request.method === "model/list") {
      const client = await prepare(openclawConnectionSchema.parse(options));
      try { io.sendResult(request.id, { models: await client.agents(), selectedOnlyModels: [] }); }
      finally { await client.dispose(); }
      return;
    }
    if (request.method === "thread/start" || request.method === "thread/resume") {
      const generation = (generations.get(params.threadId) ?? 0) + 1;
      generations.set(params.threadId, generation);
      const client = await prepare(openclawConnectionSchema.parse(options), context?.tempDir);
      // Probe before giving the ACP bridge a process so offline errors are immediate and clear.
      try { await client.agents(); } catch (error) { await client.dispose(); throw error; }
      if (generations.get(params.threadId) !== generation) {
        await client.dispose();
        throw new AgentConnectionError("OpenClaw session start was cancelled.");
      }
      selectedModels.set(params.threadId, params.options.model || "openclaw/main");
      const previous = launches.get(params.threadId);
      launches.set(params.threadId, client);
      routes.set(params.threadId, "openclaw");
      params.options.providerOptions = { acpDialect: "generic", acpLaunchSpec: client.launch(params.threadId, params.options.model) };
      delete params.options.model; // The BB model selects a Gateway agent, not an LLM model in ACP.
      // OpenClaw explicitly rejects per-session MCP servers; tools run on its Gateway.
      params.dynamicTools = [];
      acp.handleLine(JSON.stringify(request));
      // Old children have consumed the token file; deleting it cannot change their credentials.
      await previous?.dispose();
      return;
    }
    if (request.method === "thread/stop" || request.method === "thread/discard") {
      generations.set(params.threadId, (generations.get(params.threadId) ?? 0) + 1);
    }
    if (params.options) {
      const selected = selectedModels.get(params.threadId);
      if (selected && params.options.model && selected !== params.options.model) {
        throw new AgentConnectionError("Start a new BB thread to select a different OpenClaw Gateway agent.");
      }
      const client = launches.get(params.threadId);
      if (client) params.options.providerOptions = { acpDialect: "generic", acpLaunchSpec: client.launch(params.threadId, params.options.model) };
      delete params.options.model;
    }
    acp.handleLine(JSON.stringify(request));
  } catch (error) {
    if (request.id !== undefined) io.sendError(request.id, error instanceof z.ZodError ? -32602 : -32000, error instanceof AgentConnectionError ? error.message : "OpenClaw bridge configuration is invalid.");
  }
}
function close() {
  hermes.onClose?.();
  acp.onClose?.();
  for (const client of launches.values()) void client.dispose();
  launches.clear(); routes.clear(); selectedModels.clear();
  for (const [key, generation] of generations) generations.set(key, generation + 1);
}
return experimental_defineProviderBridge({
  handleLine: line => { void handleLine(line); },
  start(value) { context = value; hermes.start?.(value); acp.start?.(value); },
  onClose: close, onSigterm: close, onSigint: close,
});

}
export const experimental_providerBridge = createProviderBridge();
