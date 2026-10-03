import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { hostContract, rpcContract } from "./src/contracts.js";

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    hermesEnabled: { type: "boolean", label: "Enable Hermes", default: false },
    hermesBaseUrl: { type: "string", label: "Hermes API URL", default: "http://100.69.111.53:8642" },
    hermesTokenEnv: { type: "string", label: "Hermes token environment variable", default: "RED4_HERMES_TOKEN", experimental_schema: z.string().regex(/^[A-Z_][A-Z0-9_]*$/) },
    openclawEnabled: { type: "boolean", label: "Enable OpenClaw", default: false },
    openclawBaseUrl: { type: "string", label: "OpenClaw Gateway URL", default: "ws://100.69.111.53:18789" },
    openclawTokenEnv: { type: "string", label: "OpenClaw token environment variable", default: "RED4_OPENCLAW_TOKEN", experimental_schema: z.string().regex(/^[A-Z_][A-Z0-9_]*$/) },
  });
  let config = await settings.get();
  const connection = (provider: "hermes" | "openclaw") => ({ baseUrl: config[`${provider}BaseUrl`], tokenEnv: config[`${provider}TokenEnv`], enabled: config[`${provider}Enabled`] });
  const host = bb.hosts.experimental_client({ contract: hostContract });
  bb.rpc.register(rpcContract, { health: async ({ hostId, provider }) => host.call("health", { provider, connection: connection(provider) }, { hostId }) });
  let providers: { dispose(): void }[] = [];
  function register() {
    providers.forEach(provider => provider.dispose());
    providers = [];
    // OpenClaw registration is added with its ACP bridge in the next milestone.
    if (config.hermesEnabled) providers.push(bb.providers.register({
      id: "hermes", displayName: "Hermes", icon: "Network",
      strings: { signInHint: "Set the Hermes token environment variable on the BB host.", expiredHint: "Update the Hermes token on the BB host.", installUrl: "https://github.com/NousResearch/hermes-agent" },
      experimental_bridgeOptions: connection("hermes"),
      maintenance: { health: true, usage: false, installation: false },
      capabilities: { supportsServiceTier: false, supportsNativeUserQuestion: false, fork: "none", supportsManualCompaction: false, supportsThreadArchive: false, supportsThreadRename: false, permissionModes: ["accept-edits", "full"], reasoningLevels: ["none"] },
      models: { scope: "host" }, composerActions: [],
      env: { passthrough: [config.hermesTokenEnv] },
      deriveProviderOptions: () => connection("hermes"),
    }));
  }
  register();
  settings.onChange(next => { config = next; register(); });
  bb.onDispose(() => providers.forEach(provider => provider.dispose()));
}
