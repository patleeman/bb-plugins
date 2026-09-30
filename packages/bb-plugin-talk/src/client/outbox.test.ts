import { describe, expect, it } from "vitest";
import {
  ORPHAN_QUIET_MS,
  audioFileName,
  isOrphan,
  isPermanentRejection,
  isUploadable,
  sameKey,
  setAsideOf,
  type OutboxSegment,
} from "./outbox";

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

  it("lists set-aside segments with their size and reason, without their audio", () => {
    const base: OutboxSegment = {
      recordingId: "rec_abc12345",
      sessionId: "s1",
      index: 0,
      startedAt: Date.UTC(2026, 8, 30, 14, 5, 9),
      mimeType: "audio/webm;codecs=opus",
      lastPartAt: 0,
      durationMs: 4000,
      complete: true,
      parts: [new ArrayBuffer(3), new ArrayBuffer(5)],
    };
    const list = setAsideOf([base, { ...base, index: 1, rejected: "Bad duration" }]);
    expect(list).toEqual([
      {
        recordingId: "rec_abc12345",
        sessionId: "s1",
        index: 1,
        startedAt: base.startedAt,
        durationMs: 4000,
        mimeType: "audio/webm;codecs=opus",
        bytes: 8,
        reason: "Bad duration",
      },
    ]);
    expect(sameKey(list[0]!, { ...base, index: 1 })).toBe(true);
    expect(sameKey(list[0]!, base)).toBe(false);
  });

  it("names downloads after the recording, start time and format", () => {
    const at = Date.UTC(2026, 8, 30, 14, 5, 9);
    expect(audioFileName({ recordingId: "rec_a", startedAt: at, mimeType: "audio/webm;codecs=opus" })).toBe(
      "talk-rec_a-2026-09-30-14-05-09.webm",
    );
    expect(audioFileName({ recordingId: "rec_a", startedAt: at, mimeType: "audio/mp4" })).toBe("talk-rec_a-2026-09-30-14-05-09.m4a");
  });
});
