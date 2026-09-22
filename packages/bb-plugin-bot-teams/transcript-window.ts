import type { Reaction, RoomMessage } from "./contract";

export const TRANSCRIPT_PAGE_SIZE = 50;
export const TRANSCRIPT_WINDOW_SIZE = 150;
export type TranscriptPage = {
  messages: RoomMessage[];
  parents: RoomMessage[];
  reactions: Reaction[];
  hasOlder: boolean;
  hasNewer: boolean;
};

/** Keep only a contiguous, bounded window as the reader moves through history. */
export function extendTranscript(
  current: TranscriptPage,
  page: TranscriptPage,
  direction: "older" | "newer",
): TranscriptPage {
  const combined =
    direction === "older"
      ? [...page.messages, ...current.messages]
      : [...current.messages, ...page.messages];
  const unique = [...new Map(combined.map((m) => [m.id, m])).values()];
  const messages =
    direction === "older"
      ? unique.slice(0, TRANSCRIPT_WINDOW_SIZE)
      : unique.slice(-TRANSCRIPT_WINDOW_SIZE);
  const ids = new Set(messages.map((m) => m.id));
  const parentIds = new Set(messages.map((m) => m.replyTo));
  const refreshed = new Set(page.messages.map((m) => m.id));
  return {
    messages,
    parents: [
      ...new Map(
        [...current.parents, ...page.parents].map((m) => [m.id, m]),
      ).values(),
    ].filter((m) => parentIds.has(m.id)),
    reactions: [
      ...current.reactions.filter((r) => !refreshed.has(r.messageId)),
      ...page.reactions,
    ].filter((r) => ids.has(r.messageId)),
    hasOlder:
      direction === "older"
        ? page.hasOlder
        : current.hasOlder || unique.length > messages.length,
    hasNewer:
      direction === "newer"
        ? page.hasNewer
        : current.hasNewer || unique.length > messages.length,
  };
}
