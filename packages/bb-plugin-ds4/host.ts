import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";

export { experimental_providerBridge } from "./src/pi-bridge.js";

export default experimental_defineHostEntry({
  contract: {} as any,
  handlers: {},
});
