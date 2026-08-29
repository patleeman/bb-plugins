import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";

export { experimental_providerBridge } from "./src/provider-bridge.js";

export default experimental_defineHostEntry({
  contract: { resolveNativeRoots: { input: {} as any, output: {} as any } } as any,
  handlers: {
    resolveNativeRoots: async () => ({ roots: [] }),
  },
});
