import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "./src/contracts.js";
import { hermesHealth } from "./src/hermes-bridge.js";

import { openclawHealth, openclawConnectionSchema } from "./src/openclaw.js";
export { experimental_providerBridge } from "./src/bridge.js";
export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    health: async ({ provider, connection }) => provider === "hermes" ? hermesHealth(connection) : openclawHealth(openclawConnectionSchema.parse(connection)),
  },
});
