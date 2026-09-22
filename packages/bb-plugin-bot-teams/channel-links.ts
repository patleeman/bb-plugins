const channelPath =
  /^\/plugins\/(?:bot-teams|bots)\/channels\/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})(?:\/message\/([^/]+))?\/?$/iu;
const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function channelMessageReference(
  roomId: string,
  name: string,
  messageId: string,
) {
  const label = `Message in #${name}`
    .replace(/[\\[\]<>*_`]/gu, "\\$&")
    .replace(/[\r\n]/gu, " ");
  return `[${label}](/plugins/bot-teams/channels/${encodeURIComponent(roomId)}/message/${encodeURIComponent(messageId)})`;
}

export function channelLinkDestination(
  href: string,
  currentOrigin: string,
  knownChannelIds: ReadonlySet<string>,
) {
  if (!/^\/(?!\/)|^https?:\/\//iu.test(href)) return null;
  try {
    const url = new URL(href, currentOrigin);
    if (url.username || url.password || url.search || url.hash) return null;
    const match = channelPath.exec(url.pathname);
    if (!match) return null;
    const id = match[1]!.toLowerCase();
    // The old ID also belongs to an unrelated community plugin. Only adopt
    // links whose channel identity is present in this installation.
    if (/^\/plugins\/bots\//iu.test(url.pathname) && !knownChannelIds.has(id))
      return null;
    if (
      url.origin !== currentOrigin &&
      !(
        (loopback.has(url.hostname) ||
          url.hostname === new URL(currentOrigin).hostname) &&
        knownChannelIds.has(id)
      )
    )
      return null;
    if (!match[2]) return id;
    const messageId = decodeURIComponent(match[2]);
    if (!messageId || /[\u0000-\u001f\u007f]/u.test(messageId)) return null;
    // toPluginPanel encodes subpath segments itself. Passing an encoded ID
    // here would turn ':' into '%253A' and lose the message on navigation.
    return `${id}/message/${messageId}`;
  } catch {
    return null;
  }
}
