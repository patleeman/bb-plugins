import { fromMarkdown } from "mdast-util-from-markdown";
import type { Room } from "./contract";

/** Search token only. Stored references use channel IDs. */
export function channelSlug(name: string) {
  return (
    name
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || "channel"
  );
}

export function matchingChannels(
  rooms: Room[],
  currentRoomId: string,
  query: string,
) {
  const q = query.toLowerCase();
  return rooms
    .filter((room) => !room.archived && room.id !== currentRoomId)
    .filter((room) => {
      const slug = channelSlug(room.name);
      return slug.includes(q) || room.name.toLowerCase().includes(q);
    })
    .sort((a, b) => channelSlug(a.name).localeCompare(channelSlug(b.name)));
}

export function channelReference(room: Pick<Room, "id" | "name">) {
  const label = room.name
    .replace(/[\\[\]<>]/gu, "\\$&")
    .replace(/[\r\n]/gu, " ");
  return `[#${label}](/plugins/bot-teams/channels/${room.id})`;
}

/** Bind unambiguous plain-text mentions, never code, URLs, or existing links. */
export function linkChannelReferences(text: string, rooms: Room[]) {
  const bySlug = new Map<string, Room | null>();
  for (const room of rooms) {
    const slug = channelSlug(room.name);
    bySlug.set(slug, bySlug.has(slug) ? null : room);
  }
  const changes: { start: number; end: number; text: string }[] = [];
  const tree = fromMarkdown(text);
  const walk = (
    node:
      | typeof tree
      | (typeof tree.children)[number]
      | {
          type: string;
          children?: unknown[];
          position?: { start: { offset?: number }; end: { offset?: number } };
        },
  ) => {
    if (
      [
        "link",
        "linkReference",
        "image",
        "imageReference",
        "definition",
        "code",
        "inlineCode",
        "html",
      ].includes(node.type)
    )
      return;
    if (node.type === "text" && node.position) {
      const start = node.position.start.offset,
        end = node.position.end.offset;
      if (start === undefined || end === undefined) return;
      const raw = text.slice(start, end);
      for (const match of raw.matchAll(/(^|[\s(])#([a-z0-9][a-z0-9_-]*)/giu)) {
        const room = bySlug.get(match[2]!.toLowerCase());
        if (room)
          changes.push({
            start: start + match.index! + match[1]!.length,
            end: start + match.index! + match[0].length,
            text: channelReference(room),
          });
      }
    }
    if ("children" in node && node.children)
      for (const child of node.children)
        walk(child as Parameters<typeof walk>[0]);
  };
  walk(tree);
  for (const change of changes.reverse())
    text = text.slice(0, change.start) + change.text + text.slice(change.end);
  return text;
}
