import { describe, expect, it } from "vitest";
import { ORPHAN_QUIET_MS, isOrphan, isPermanentRejection, isUploadable } from "./outbox";

describe("outbox", () => {
  const now = 1_000_000;
  const open = { complete: false, lastPartAt: now - 1000 };

  it("leaves another window's segments alone while it holds the capture lock", () => {
    expect(isOrphan(open, false, false, now)).toBe(false);
    expect(isOrphan({ ...open, lastPartAt: 0 }, false, false, now)).toBe(false);
  });

  it("seals segments no live recorder owns once the lock is free", () => {
    expect(isOrphan(open, false, true, now)).toBe(true);
    expect(isOrphan(open, true, true, now)).toBe(false);
    expect(isOrphan({ ...open, complete: true }, false, true, now)).toBe(false);
  });

  it("without Web Locks, seals only segments that stopped growing", () => {
    expect(isOrphan(open, false, null, now)).toBe(false);
    expect(isOrphan({ ...open, lastPartAt: now - ORPHAN_QUIET_MS }, false, null, now)).toBe(true);
  });

  it("skips segments the server refused for good", () => {
    expect(isUploadable({ complete: true })).toBe(true);
    expect(isUploadable({ complete: false })).toBe(false);
    expect(isUploadable({ complete: true, rejected: "durationMs: too big" })).toBe(false);
  });

  it("treats contract failures as permanent and everything else as retryable", () => {
    const withCode = (code: string) => Object.assign(new Error("x"), { code });
    expect(isPermanentRejection(withCode("invalid_input"))).toBe(true);
    expect(isPermanentRejection(withCode("handler_error"))).toBe(false);
    expect(isPermanentRejection(new TypeError("Failed to fetch"))).toBe(false);
    expect(isPermanentRejection(null)).toBe(false);
  });
});
