export type ChannelHandoffSource = {
  threadId: string;
  projectId: string;
  title: string;
};

export function channelHandoffPath(source: ChannelHandoffSource) {
  return source.projectId === "proj_personal"
    ? `/threads/${encodeURIComponent(source.threadId)}`
    : `/projects/${encodeURIComponent(source.projectId)}/threads/${encodeURIComponent(source.threadId)}`;
}

export function channelHandoffText(source: ChannelHandoffSource) {
  const path = channelHandoffPath(source);
  const title = source.title
    .replace(/[\\[\]<>*_`]/gu, "\\$&")
    .replace(/[\r\n]/gu, " ");
  return `Continue from [${title}](${path}) (@thread:${source.threadId})`;
}

export function channelHandoffMessage(
  source: ChannelHandoffSource | null,
  text: string,
) {
  if (!source) return text;
  return `${channelHandoffText(source)}${text.trim() ? `\n\n${text}` : ""}`;
}

/** Read drafts saved before the source thread became a separate chip. */
export function parseLegacyChannelHandoffDraft(text: string): {
  source: ChannelHandoffSource;
  text: string;
} | null {
  const match = /^Continue from \[((?:\\.|[^\]])*)\]\((?:\/projects\/([^/]+)\/threads\/([^/)]+)|\/threads\/([^/)]+))\) \(@thread:([^)]+)\)(?:\n\n)?/u.exec(text);
  if (!match) return null;
  try {
    const threadId = decodeURIComponent(match[3] ?? match[4]!);
    if (threadId !== match[5]) return null;
    return {
      source: {
        threadId,
        projectId: match[2] ? decodeURIComponent(match[2]) : "proj_personal",
        title: match[1]!.replace(/\\([\\[\]<>*_`])/gu, "$1"),
      },
      text: text.slice(match[0].length),
    };
  } catch {
    return null;
  }
}

/** Keep the thread ID in the stored message for bots, but show one link to readers. */
export function displayChannelHandoffText(text: string) {
  return text.replace(
    /^(Continue from \[.*\]\((?:\/projects\/[^/]+)?\/threads\/(thr_[^/)]+)\)) \(@thread:\2\)/u,
    "$1",
  );
}
