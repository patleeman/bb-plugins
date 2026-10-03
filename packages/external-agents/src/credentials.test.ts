import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { resolveToken } from "./credentials.js";
it("reads only the named assignment without executing shell syntax", async () => {
  const dir = await mkdtemp(join(tmpdir(), "credential-fixture-"));
  const file = join(dir, ".env");
  try {
    await writeFile(file, 'OTHER_TOKEN=other\nexport TEST_TOKEN="$(do-not-execute)"\n', { mode: 0o600 });
    expect(resolveToken("TEST_TOKEN", file, {})).toBe("$(do-not-execute)");
    expect(resolveToken("MISSING_TOKEN", file, {})).toBe("");
    expect(resolveToken("TEST_TOKEN", file, { TEST_TOKEN: "environment-value" })).toBe("environment-value");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
