import assert from "node:assert/strict";
import { test } from "node:test";
import {
  orphanCleanupIsDue,
  providerLeaseVetoesStart,
} from "./supervisor-policy.ts";

test("a supervisor start yields to an active provider lease", () => {
  assert.equal(providerLeaseVetoesStart(true, true), true);
  assert.equal(providerLeaseVetoesStart(true, false), false);
  assert.equal(providerLeaseVetoesStart(false, true), false);
});

test("orphan cleanup waits for idle grace after demand", () => {
  assert.equal(orphanCleanupIsDue(null, 10_000, 5_000), true);
  assert.equal(orphanCleanupIsDue(10_000, 14_999, 5_000), false);
  assert.equal(orphanCleanupIsDue(10_000, 15_000, 5_000), true);
});
