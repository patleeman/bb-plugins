// Pure helpers shared by the server and the frontend. Nothing here may import
// a runtime value from the SDK: the frontend bundle loads this file directly.

/** Realtime channel: payload `{ id }` of the recording that changed. */
export const RECORDING_CHANGED = "recording-changed";

/** Studio's "New recording" dispatches this on window; Talk's overlay starts one. */
export const NEW_RECORDING_EVENT = "bb-studio:talk:new-recording";

/** The plugin's declared icon (`bb.branding.experimental_icons`). */
export const TALK_ICON = "talk/talk";

/** The nav panel path; recordings live at /plugins/talk/recordings/<id>. */
export const PANEL_PATH = "recordings";

/** Audio the server refused, kept on this device: /plugins/talk/recordings/unsent. */
export const UNSENT_PATH = "unsent";

/**
 * Finished with no words and nothing left to retry. Talk does not keep
 * these: the server deletes them as soon as they get here.
 */
export function isEmptyRecording(recording: { status: string; wordCount: number; failedCount: number }): boolean {
  return recording.status === "done" && recording.wordCount === 0 && recording.failedCount === 0;
}

export function recordingHref(id: string): string {
  return `/plugins/talk/${PANEL_PATH}/${id}`;
}

/** `65_000` → `1:05`, `3_725_000` → `1:02:05`. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

/** `65_000` → `1 min`, `3_725_000` → `1 hr 2 min`, `20_000` → `20 sec`. */
export function formatLength(ms: number): string {
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total} sec`;
  const minutes = Math.round(total / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}

export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

/**
 * Joins per-segment transcripts into one text. A segment boundary is not a
 * sentence boundary, so pieces join with a space; a new capture session
 * (pause, reload, resume) starts a new paragraph.
 */
export function joinTranscript(
  segments: readonly { sessionId: string; text: string | null }[],
): string {
  let out = "";
  let session: string | null = null;
  for (const segment of segments) {
    const text = segment.text?.trim();
    if (!text) continue;
    if (out === "") out = text;
    else out += (segment.sessionId === session ? " " : "\n\n") + text;
    session = segment.sessionId;
  }
  return out;
}

export function tail(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(text.length - max);
  const space = cut.indexOf(" ");
  return `…${space > 0 && space < 40 ? cut.slice(space + 1) : cut}`;
}

export function defaultTitle(createdAt: number, kind: "recording" | "dictation"): string {
  const when = new Date(createdAt).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return `${kind === "dictation" ? "Dictation" : "Recording"} · ${when}`;
}

/**
 * Normalizes a model's title answer: first line, no quotes, markdown, or
 * trailing period, at most 80 characters. Returns null for an unusable answer.
 */
export function cleanTitle(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const line = raw
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part !== "");
  if (!line) return null;
  let title = line
    .replace(/^(title\s*:\s*)/i, "")
    .replace(/^[#*_`>\s-]+|[*_`\s]+$/g, "")
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/\.$/, "")
    .trim();
  if (title.length > 80) title = `${title.slice(0, 79).trimEnd()}…`;
  return title.length >= 2 ? title : null;
}

/** A stable excerpt for titling: the opening and the close of a long text. */
export function titleExcerpt(text: string, max = 4000): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.7);
  return `${text.slice(0, head)}\n[…]\n${text.slice(text.length - (max - head))}`;
}

export type RecordingTone = "neutral" | "live" | "progress" | "warning" | "danger" | "success";

/** A recording's state as a badge, or null once it's simply done. */
export function recordingBadge(
  recording: { status: string; pendingCount: number; failedCount: number },
  live = false,
): { label: string; tone: RecordingTone } | null {
  if (live || recording.status === "recording") return { label: "Recording", tone: "live" };
  if (recording.status === "paused") return { label: "Paused", tone: "neutral" };
  if (recording.status === "interrupted") return { label: "Interrupted", tone: "warning" };
  if (recording.pendingCount > 0 || recording.status === "finishing") return { label: "Transcribing", tone: "progress" };
  if (recording.failedCount > 0) return { label: `${recording.failedCount} failed`, tone: "danger" };
  return null;
}
