import { defineConfig } from "vitest/config";

export default defineConfig({
  server: {
    deps: {
      inline: ["@get-bb/plugin-sdk"],
    },
  },
  test: {
    environment: "node",
    setupFiles: ["./vitest.setup.mts"],
  },
});
