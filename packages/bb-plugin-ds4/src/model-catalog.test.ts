import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, after } from "node:test";
import {
  advertisedModelIds,
  catalogPathFor,
  scanModelCatalog,
} from "./model-catalog.ts";
import { DEFAULT_GLM53_VISION_FILE } from "./run-config.ts";

const dir = mkdtempSync(join(tmpdir(), "ds4-catalog-"));
after(() => rmSync(dir, { recursive: true, force: true }));

// gguf/ subdir: two supported models plus noise; root: a third model and a
// larger duplicate of the Flash entry to exercise the largest-wins rule.
mkdirSync(join(dir, "gguf"));
writeFileSync(join(dir, "gguf", "GLM-5.3-Flash-Q2.gguf"), "0123456789");
writeFileSync(join(dir, "gguf", DEFAULT_GLM53_VISION_FILE), "0".repeat(64));
writeFileSync(join(dir, "gguf", "DeepSeek-V4-Flash-small.gguf"), "01234567");
writeFileSync(join(dir, "gguf", "download.gguf.part"), "partial");
writeFileSync(join(dir, "gguf", "unknown-model.gguf"), "00000000");
writeFileSync(join(dir, "GLM-5.2-UD-Q2_K.gguf"), "012345");
writeFileSync(join(dir, "DeepSeek-V4-Flash-big.gguf"), "0123456789abcdef");

const catalog = scanModelCatalog(dir);

test("scans the checkout root and gguf dir, skipping noise", () => {
  assert.deepEqual(
    catalog.map((e) => e.id),
    ["deepseek-v4-flash", "glm-5.2", "glm-5.3-flash"],
  );
});

test("prefers the largest file for duplicate canonical ids", () => {
  const flash = catalog.find((e) => e.id === "deepseek-v4-flash");
  assert.ok(flash);
  assert.equal(flash.sizeBytes, 16);
  assert.ok(flash.path.endsWith("DeepSeek-V4-Flash-big.gguf"));
});

test("resolves catalog paths by canonical id", () => {
  assert.ok(catalogPathFor(catalog, "glm-5.3-flash")?.endsWith("GLM-5.3-Flash-Q2.gguf"));
  assert.equal(catalogPathFor(catalog, "deepseek-v4-pro"), null);
});

test("handles a missing checkout", () => {
  assert.deepEqual(scanModelCatalog(null), []);
  assert.deepEqual(scanModelCatalog(join(dir, "does-not-exist")), []);
});

test("advertised ids list every downloaded model; unknown custom names add nothing", () => {
  assert.deepEqual(
    advertisedModelIds(catalog, null),
    ["deepseek-v4-flash", "glm-5.2", "glm-5.3-flash"],
  );
  assert.deepEqual(
    advertisedModelIds(catalog, join(dir, "custom-name.gguf")),
    ["deepseek-v4-flash", "glm-5.2", "glm-5.3-flash"],
  );
});

test("advertised ids fall back to the configured or default model", () => {
  assert.deepEqual(advertisedModelIds([], "/tmp/ds4/GLM-5.2.gguf"), ["glm-5.2"]);
  assert.deepEqual(advertisedModelIds([], "/tmp/ds4/custom.gguf"), ["deepseek-v4-flash"]);
  assert.deepEqual(
    advertisedModelIds([], "/tmp/ds4/GLM-5.3-Flash.gguf", "glm-5.3-flash"),
    ["glm-5.3-flash"],
  );
});
