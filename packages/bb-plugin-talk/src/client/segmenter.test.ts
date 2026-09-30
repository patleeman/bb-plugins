import { describe, expect, it } from "vitest";
import {
  LevelTracker,
  MAX_SEGMENT_MS,
  MAX_TICK_GAP_MS,
  pickMimeType,
  rmsOf,
  segmentPolicy,
  shouldCut,
  tickGap,
  uploadDuration,
} from "./segmenter";

describe("segmenter", () => {
  it("cuts at a pause after the target, or at the hard maximum", () => {
    const policy = segmentPolicy(25);
    expect(shouldCut(policy, 20_000, 2_000)).toBe(false);
    expect(shouldCut(policy, 26_000, 100)).toBe(false);
    expect(shouldCut(policy, 26_000, 400)).toBe(true);
    expect(shouldCut(policy, 40_000, 0)).toBe(true);
  });

  it("doesn't count a sleep as recorded time", () => {
    expect(tickGap(100)).toBe(100);
    expect(tickGap(3 * 3_600_000)).toBe(MAX_TICK_GAP_MS);
    expect(tickGap(-5)).toBe(0);
    expect(tickGap(Number.NaN)).toBe(0);
  });

  it("clamps upload durations to what the server accepts", () => {
    expect(uploadDuration(25_400.6)).toBe(25_401);
    expect(uploadDuration(null)).toBe(0);
    expect(uploadDuration(-1)).toBe(0);
    // A segment sealed across a laptop sleep.
    expect(uploadDuration(8 * 3_600_000)).toBe(MAX_SEGMENT_MS);
  });

  it("clamps the segment length", () => {
    expect(segmentPolicy(1).targetMs).toBe(8_000);
    expect(segmentPolicy(600).targetMs).toBe(60_000);
    expect(segmentPolicy(Number.NaN).targetMs).toBe(25_000);
  });

  it("counts quiet time against an adaptive noise floor", () => {
    const tracker = new LevelTracker();
    for (let i = 0; i < 50; i++) tracker.push(0.01, 100);
    // Steady room noise becomes the floor, so it reads as quiet.
    expect(tracker.push(0.01, 100).quietForMs).toBeGreaterThan(0);
    expect(tracker.push(0.2, 100).quietForMs).toBe(0);
    expect(tracker.level).toBeGreaterThan(0.5);
    tracker.push(0.005, 200);
    expect(tracker.push(0.005, 200).quietForMs).toBe(400);
  });

  it("measures RMS and picks a supported container", () => {
    expect(rmsOf(new Float32Array([0.5, -0.5]))).toBeCloseTo(0.5);
    expect(pickMimeType((type) => type === "audio/mp4")).toBe("audio/mp4");
    expect(pickMimeType(() => false)).toBe("");
  });
});
