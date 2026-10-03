import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "./src/contracts.js";
import { createHermesBridge, hermesHealth } from "./src/hermes-bridge.js";

export const experimental_providerBridge = createHermesBridge();
export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    health: async ({ provider, connection }) => provider === "hermes" ? hermesHealth(connection) : { online: false, status: "unknown" as const, message: "OpenClaw bridge is not configured yet." },
  },
});
