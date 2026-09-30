// What the agent is told about the item on screen: a pointer, not the
// content. The add-on's own tools read the latest version.
import type { StudioItem, StudioKind } from "@bb-studio/kit/contract";
import type { NewThreadRequest } from "@get-bb/plugin-sdk";
import type { Viewed } from "./contract";

type Item = StudioItem & { pluginId: string };

const GENERIC_HINT = "Find it with studio_list_items; its link is above.";

export function toViewed(item: Item, kind: StudioKind | null): Viewed {
  return {
    pluginId: item.pluginId,
    id: item.id,
    kind: item.kind,
    kindLabel: kind?.label ?? item.kind,
    title: item.title,
    icon: item.icon,
    kindIcon: kind?.icon ?? "File",
    projectId: item.projectId,
    href: item.href,
  };
}

export const itemKey = (ref: { pluginId: string; id: string }) => `${ref.pluginId}:${ref.id}`;

/** `<plugin>:<id>` back to its parts; the id may itself hold colons. */
export function parseItemKey(key: string): { pluginId: string; id: string } | null {
  const at = key.indexOf(":");
  if (at <= 0 || at === key.length - 1) return null;
  return { pluginId: key.slice(0, at), id: key.slice(at + 1) };
}

export function pointerNote(item: Item, kind: StudioKind | null): string {
  const label = (kind?.label ?? item.kind).toLowerCase();
  const title = item.title.trim() || "Untitled";
  return [
    `The user has this Studio ${label} open while they talk to you: "${title}" (${label} id ${item.id}, from the ${item.pluginId} plugin, link ${item.href}).`,
    `When they say "this" or "here", they mean it. ${kind?.agentHint ?? GENERIC_HINT}`,
    "Read it fresh before you answer about it; don't guess its content.",
  ].join("\n");
}

/** The note when Studio can't find the item any more. */
export function missingNote(key: string): string {
  return `The user had a Studio item open (${key}), but it can't be found now. It may have been deleted. ${GENERIC_HINT}`;
}

type TextInput = Extract<NewThreadRequest["input"][number], { type: "text" }>;

/**
 * The message with a pill for the item at the start of its first visible
 * text, so the user sees what the agent was pointed at. BB resolves the pill
 * through our mention provider when the thread starts.
 */
export function withItemPill(
  input: NewThreadRequest["input"],
  /** `wireId` is `<mention provider>:<item key>`, as BB namespaces mention ids. */
  pill: { pluginId: string; wireId: string; label: string; icon: string | null },
): NewThreadRequest["input"] {
  const label = `@${pill.label.trim() || "Untitled"}`;
  const mention = {
    start: 0,
    end: label.length,
    resource: { kind: "plugin" as const, pluginId: pill.pluginId, itemId: pill.wireId, label: pill.label.trim() || "Untitled", icon: pill.icon },
  };
  const at = input.findIndex((item) => item.type === "text" && item.visibility !== "agent-only");
  if (at < 0) return [{ type: "text", text: label, mentions: [mention] } as TextInput, ...input];
  const first = input[at] as TextInput;
  const shift = label.length + 1;
  const text: TextInput = {
    ...first,
    text: `${label} ${first.text}`,
    mentions: [mention, ...(first.mentions ?? []).map((each) => ({ ...each, start: each.start + shift, end: each.end + shift }))],
  };
  return input.map((item, index) => (index === at ? text : item));
}
