import { dotHealth } from "./src/dot-client.js";
import { connectionSchema } from "./src/hermes-client.js";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "./src/contracts.js";
import { hermesHealth } from "./src/hermes-bridge.js";

import { openclawHealth, openclawConnectionSchema } from "./src/openclaw.js";
export { experimental_providerBridge } from "./src/bridge.js";
export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    health: async ({ provider, connection }) => provider === "dot" ? dotHealth() : provider === "hermes" ? hermesHealth(connectionSchema.parse(connection)) : openclawHealth(openclawConnectionSchema.parse(connection)),
  },
});
