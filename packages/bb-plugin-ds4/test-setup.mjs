import { createRequire } from "node:module";

// The SDK's bundled cross-spawn fallback is CommonJS-shaped. Install the
// normal Node ESM-compatible require before the provider bridge is imported.
globalThis.require = createRequire(import.meta.url);
