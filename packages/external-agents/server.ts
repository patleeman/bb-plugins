import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { hostContract, rpcContract } from "./src/contracts.js";

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    dotEnabled: { type: "boolean", label: "Enable Dot (experimental — one shared ChatGPT conversation; private API)", default: false },
    hermesTokenEnvFile: { type: "string", label: "Hermes token dotenv file on the BB host", default: "" },
    openclawTokenEnvFile: { type: "string", label: "OpenClaw token dotenv file on the BB host", default: "" },
    hermesEnabled: { type: "boolean", label: "Enable Hermes", default: false },
    hermesBaseUrl: { type: "string", label: "Hermes API URL", default: "http://100.69.111.53:8642" },
    hermesTokenEnv: { type: "string", label: "Hermes token environment variable", default: "RED4_HERMES_TOKEN", experimental_schema: z.string().regex(/^[A-Z_][A-Z0-9_]*$/) },
    openclawStateDir: { type: "string", label: "OpenClaw paired client state directory", default: "" },
    openclawAllowPrivateWs: { type: "boolean", label: "Allow OpenClaw WebSocket over a private encrypted network", default: false },
    openclawEnabled: { type: "boolean", label: "Enable OpenClaw", default: false },
    openclawBaseUrl: { type: "string", label: "OpenClaw Gateway URL", default: "ws://100.69.111.53:18789" },
    openclawTokenEnv: { type: "string", label: "OpenClaw token environment variable", default: "RED4_OPENCLAW_TOKEN", experimental_schema: z.string().regex(/^[A-Z_][A-Z0-9_]*$/) },
  });
  let config = await settings.get();
  const connection = (provider: "hermes" | "openclaw") => ({ baseUrl: config[`${provider}BaseUrl`], tokenEnv: config[`${provider}TokenEnv`], tokenEnvFile: config[`${provider}TokenEnvFile`], enabled: config[`${provider}Enabled`], ...(provider === "openclaw" ? { stateDir: config.openclawStateDir, allowPrivateWs: config.openclawAllowPrivateWs } : {}) });
  const host = bb.hosts.experimental_client({ contract: hostContract });
  bb.rpc.register(rpcContract, { health: async ({ hostId, provider }) => {
    const target = provider === "dot" ? { enabled: config.dotEnabled } : connection(provider);
    if (!target.enabled) return { online: false, status: "disabled" as const, message: `${provider} is disabled.` };
    const selectedHostId = hostId ?? (await bb.sdk.system.config()).primaryHostId;
    if (!selectedHostId) return { online: false, status: "unknown" as const, message: "The BB server host is not enrolled." };
    try { return await host.call("health", { provider, connection: target }, { hostId: selectedHostId }); }
    catch { return { online: false, status: "unknown" as const, message: "The BB host could not run the agent health check." }; }
  } });
  let providers: { dispose(): void }[] = [];
  function register() {
    providers.forEach(provider => provider.dispose());
    providers = [];
    if (config.dotEnabled) providers.push(bb.providers.register({
      id: "dot", displayName: "Dot (experimental)", icon: "Network",
      strings: { signInHint: "Sign in with Codex on this Mac. Dot uses its existing auth.json.", expiredHint: "Sign in again with Codex on this Mac.", installUrl: "https://chatgpt.com" },
      experimental_bridgeOptions: { provider: "dot", enabled: true },
      maintenance: { health: true, usage: false, installation: false },
      capabilities: { supportsServiceTier: false, supportsNativeUserQuestion: false, fork: "none", supportsManualCompaction: false, supportsThreadArchive: false, supportsThreadRename: false, permissionModes: ["full"], reasoningLevels: ["none"] },
      models: { scope: "host" }, composerActions: [],
      deriveProviderOptions: () => ({ provider: "dot", enabled: config.dotEnabled }),
    }));
    for (const provider of ["hermes", "openclaw"] as const) {
    if (!config[`${provider}Enabled`]) continue;
    const displayName = provider === "hermes" ? "Hermes" : "OpenClaw";
    providers.push(bb.providers.register({
      id: provider, displayName, icon: "Network",
      strings: { signInHint: `Set the ${displayName} token environment variable on the BB host.`, expiredHint: `Update the ${displayName} token on the BB host.`, installUrl: provider === "hermes" ? "https://github.com/NousResearch/hermes-agent" : "https://docs.openclaw.ai" },
      experimental_bridgeOptions: { ...connection(provider), provider },
      maintenance: { health: true, usage: false, installation: false },
      capabilities: { supportsServiceTier: false, supportsNativeUserQuestion: false, fork: "none", supportsManualCompaction: false, supportsThreadArchive: false, supportsThreadRename: false, permissionModes: ["accept-edits", "full"], reasoningLevels: ["none"] },
      models: { scope: "host" }, composerActions: [],
      env: { passthrough: [config[`${provider}TokenEnv`]] },
      deriveProviderOptions: () => ({ ...connection(provider), provider }),
    }));
    }
  }
  register();
  settings.onChange(next => { config = next; register(); });
  bb.onDispose(() => providers.forEach(provider => provider.dispose()));
}
