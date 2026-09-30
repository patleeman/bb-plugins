// When to close one audio segment and open the next. Pure, so it is tested
// without a microphone.
//
// Segments close at a pause once they reach the target length, so a word is
// rarely split between two transcription calls. A segment that never pauses
// closes at the hard maximum. BB's voice service allows about 10 seconds per
// call, which comfortably covers ~40 seconds of speech.

export interface SegmentPolicy {
  targetMs: number;
  maxMs: number;
  /** How long the level must stay low to count as a pause. */
  pauseMs: number;
}

export function segmentPolicy(segmentSeconds: number): SegmentPolicy {
  const target = Math.min(60, Math.max(8, Number.isFinite(segmentSeconds) ? segmentSeconds : 25));
  return { targetMs: target * 1000, maxMs: Math.round(target * 1.6 * 1000), pauseMs: 350 };
}

/** The server refuses longer segments (`segment_put`'s `durationMs`). */
export const MAX_SEGMENT_MS = 10 * 60_000;

/**
 * The most one level tick may add to a segment's length. Ticks come every
 * 100ms (every second or minute in a throttled background tab); a longer gap
 * means the machine slept, and no audio was recorded during it.
 */
export const MAX_TICK_GAP_MS = 60_000;

/** Recorded time a tick adds: the gap since the last one, less any sleep. */
export function tickGap(dtMs: number): number {
  return Number.isFinite(dtMs) ? Math.min(MAX_TICK_GAP_MS, Math.max(0, dtMs)) : 0;
}

/** A duration the server accepts: whole, non-negative, and under the cap. */
export function uploadDuration(durationMs: number | null | undefined): number {
  const value = Number.isFinite(durationMs) ? Math.round(durationMs!) : 0;
  return Math.min(MAX_SEGMENT_MS, Math.max(0, value));
}

export function shouldCut(policy: SegmentPolicy, elapsedMs: number, quietForMs: number): boolean {
  if (elapsedMs >= policy.maxMs) return true;
  return elapsedMs >= policy.targetMs && quietForMs >= policy.pauseMs;
}

/**
 * Tracks input level against an adaptive noise floor. The floor follows the
 * quietest recent level, so a noisy room does not read as constant speech.
 */
export class LevelTracker {
  private floor = 0.004;
  private quietMs = 0;
  /** 0..1, smoothed for a level meter. */
  level = 0;

  push(rms: number, dtMs: number): { quietForMs: number } {
    // Floor drops at once to a quieter reading, and creeps up slowly.
    this.floor = rms < this.floor ? rms : this.floor + (rms - this.floor) * Math.min(1, dtMs / 8000);
    this.floor = Math.max(0.001, this.floor);
    const threshold = Math.max(0.008, this.floor * 2.5);
    this.quietMs = rms < threshold ? this.quietMs + dtMs : 0;
    const target = Math.min(1, Math.sqrt(rms) * 2.2);
    this.level = target > this.level ? target : this.level * 0.85 + target * 0.15;
    return { quietForMs: this.quietMs };
  }

  reset(): void {
    this.quietMs = 0;
    this.level = 0;
  }
}

export function rmsOf(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  return Math.sqrt(sum / Math.max(1, samples.length));
}

/** The first container MediaRecorder supports here: webm on Chromium and Firefox, mp4 on Safari. */
export function pickMimeType(isSupported: (type: string) => boolean): string {
  for (const type of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"]) {
    if (isSupported(type)) return type;
  }
  return "";
}
