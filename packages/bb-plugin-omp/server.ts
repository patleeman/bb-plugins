import type { BbPluginApi } from "@get-bb/plugin-sdk";

const OMP_FALLBACK_MODEL = {
  id: "openai-codex/gpt-5",
  displayName: "GPT-5",
  description: "Openai-codex model via OMP",
  routeProviderId: "openai-codex",
  supportedReasoningEfforts: [
    { reasoningEffort: "none", description: "None" },
    { reasoningEffort: "low", description: "Low" },
    { reasoningEffort: "medium", description: "Medium" },
    { reasoningEffort: "high", description: "High" },
    { reasoningEffort: "xhigh", description: "Extra High" },
  ],
  defaultReasoningEffort: "medium",
  isDefault: true,
} as const;

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("omp provider plugin loaded (Pi-style)");

  // Disable hint: user can `bb plugin disable provider-acp` to hide Cursor/Grok/etc.
  // This plugin owns `omp` id separately, so both can coexist until disabled.

  bb.providers.register({
    id: "omp",
    displayName: "OhMyPi",
    icon: "omp/omp",
    strings: {
      signInHint: "Run `omp` on the machine to sign in (or set OMP_API_KEY).",
      expiredHint: "Your OhMyPi session expired. Run `omp` again, then reload.",
      installUrl: "https://github.com/can1357/omp",
      iconTint: { light: "#9333EA", dark: "#9333EA" },
    },
    // OMP is detected and health-checked, but this plugin does not own an
    // installer for the user's native OMP binary.
    maintenance: { health: true, usage: false, installation: false },
    capabilities: {
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      fork: "none",
      supportsManualCompaction: true,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      permissionModes: ["full"],
      reasoningLevels: ["none", "low", "medium", "high", "xhigh"],
    },
    reasoningLevels: [
      { id: "none", label: "None" },
      { id: "low", label: "Low" },
      { id: "medium", label: "Medium" },
      { id: "high", label: "High" },
      { id: "xhigh", label: "Extra High" },
    ],
    // Fallback when `omp` binary missing or catalog empty.
    models: {
      scope: "host",
      fallback: [OMP_FALLBACK_MODEL],
    },
    env: { passthrough: ["OMP_API_KEY", "BB_OMP_BRIDGE_COMMAND", "BB_OMP_BRIDGE_ARGS"] },
    composerActions: [],
  });
}
