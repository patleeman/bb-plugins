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

/** Where a rendered mention points; the channel resolves it to the bot's DM. */
export const mentionHref = (botId: string) =>
  `/plugins/bot-teams/mention/${encodeURIComponent(botId)}`;

export const mentionBotId = (href: string) => {
  const match = /^\/plugins\/bot-teams\/mention\/([^/?#]+)$/u.exec(href);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
};

// Fenced and inline code, existing links and raw HTML are passed through
// untouched, so a handle quoted as an example stays an example.
const protectedSpan =
  /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`|!?\[[^\]]*\]\([^)]*\)|<[^>\n]+>)/gu;
const handleRun = /(^|[^a-zA-Z0-9_.-])@([a-zA-Z0-9][a-zA-Z0-9_.-]*)/gu;

/**
 * Rewrite `@handle` as a Markdown link so a mention renders as a chip that
 * opens that bot, leaving every handle we do not know as plain text.
 */
export function linkifyMentions(
  text: string,
  botIdForHandle: (handle: string) => string | null,
) {
  return text
    .split(protectedSpan)
    .map((part, index) =>
      // split() yields the captured delimiters at odd indexes: leave those be.
      index % 2
        ? part
        : part.replace(handleRun, (whole, before: string, handle: string) => {
            const botId = botIdForHandle(handle);
            return botId
              ? `${before}[@${handle}](${mentionHref(botId)})`
              : whole;
          }),
    )
    .join("");
}
