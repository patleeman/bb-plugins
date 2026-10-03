import { experimental_acpProviderBridge } from "@get-bb/plugin-sdk/provider-bridge/acp";
import { createBridgeIo, experimental_defineProviderBridge, type ProviderBridgeContext } from "@get-bb/plugin-sdk/provider-bridge";
import { createHermesBridge } from "./hermes-bridge.js";
import { AgentConnectionError } from "./hermes-client.js";
import { openclawConnectionSchema, openclawHealth, prepareOpenClaw } from "./openclaw.js";

const hermes = createHermesBridge();
const io = createBridgeIo<unknown>();
const routes = new Map<string, "hermes" | "openclaw">();
const launches = new Map<string, Awaited<ReturnType<typeof prepareOpenClaw>>>();
let context: ProviderBridgeContext | undefined;
let activeProvider = "hermes";

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
      const result = await openclawHealth(openclawConnectionSchema.parse(options));
      io.sendResult(request.id, { supported: true, health: { status: result.status, statusMessage: result.message, accountEmail: null, planLabel: null, installedVersion: null, minimumSupportedVersion: null, canInstall: false, canUpdate: false, loginCommand: null } });
      return;
    }
    if (request.method === "model/list") {
      const client = await prepareOpenClaw(openclawConnectionSchema.parse(options));
      try { io.sendResult(request.id, { models: await client.agents(), selectedOnlyModels: [] }); }
      finally { await client.dispose(); }
      return;
    }
    if (request.method === "thread/start" || request.method === "thread/resume") {
      const client = await prepareOpenClaw(openclawConnectionSchema.parse(options), context?.tempDir);
      // Probe before giving the ACP bridge a process so offline errors are immediate and clear.
      try { await client.agents(); } catch (error) { await client.dispose(); throw error; }
      const previous = launches.get(params.threadId);
      launches.set(params.threadId, client);
      routes.set(params.threadId, "openclaw");
      params.options.providerOptions = { acpDialect: "generic", acpLaunchSpec: client.launch(params.threadId, params.options.model) };
      delete params.options.model; // The BB model selects a Gateway agent, not an LLM model in ACP.
      // OpenClaw explicitly rejects per-session MCP servers; tools run on its Gateway.
      params.dynamicTools = [];
      experimental_acpProviderBridge.handleLine(JSON.stringify(request));
      // Old children have consumed the token file; deleting it cannot change their credentials.
      await previous?.dispose();
      return;
    }
    if (params.options) {
      const client = launches.get(params.threadId);
      if (client) params.options.providerOptions = { acpDialect: "generic", acpLaunchSpec: client.launch(params.threadId, params.options.model) };
      delete params.options.model;
    }
    experimental_acpProviderBridge.handleLine(JSON.stringify(request));
  } catch (error) {
    if (request.id !== undefined) io.sendError(request.id, -32000, error instanceof AgentConnectionError ? error.message : "OpenClaw bridge configuration is invalid.");
  }
}
function close() {
  hermes.onClose?.();
  experimental_acpProviderBridge.onClose?.();
  for (const client of launches.values()) void client.dispose();
  launches.clear(); routes.clear();
}
export const experimental_providerBridge = experimental_defineProviderBridge({
  handleLine: line => { void handleLine(line); },
  start(value) { context = value; hermes.start?.(value); experimental_acpProviderBridge.start?.(value); },
  onClose: close, onSigterm: close, onSigint: close,
});
