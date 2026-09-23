export const broadcastHandles = ["all", "channel", "everyone"] as const;

export function mentioned(text: string, handle: string) {
  const escaped = handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(^|[^a-zA-Z0-9_.-])@${escaped}(?![a-zA-Z0-9_.-])`,
    "i",
  ).test(text);
}

export const isBroadcastHandle = (handle: string) =>
  broadcastHandles.some((alias) => alias === handle.toLowerCase());

export const mentionsEveryone = (text: string) =>
  broadcastHandles.some((handle) => mentioned(text, handle));

export const matchingBroadcastMentions = (query: string) =>
  broadcastHandles
    .filter((handle) => handle !== "everyone" || !!query)
    .filter((handle) => handle.startsWith(query.toLowerCase()))
    .map((handle) => ({ handle }));

export type BroadcastMention = ReturnType<
  typeof matchingBroadcastMentions
>[number];
