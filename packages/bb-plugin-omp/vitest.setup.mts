import { createRequire } from "node:module";

// The SDK's bundled cross-spawn fallback is CommonJS-shaped. Supplying the
// normal Node ESM-compatible require keeps the provider-bridge test surface
// executable under Vitest without changing production bundles.
(globalThis as Record<string, unknown>).require = createRequire(import.meta.url);
