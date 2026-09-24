// BB's MentionMenu (apps/app promptbox mentions): sticky section headers and
// compact suggestion rows above the composer, fed with bots and channels.
import { useEffect, useRef, type ReactNode } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { Bot, Room } from "./contract";
import { matchingBots } from "./channel-controls";
import { channelSlug, matchingChannels } from "./channel-references";
import { matchingBroadcastMentions, type BroadcastMention } from "./mentions";
import { cn } from "./lib/utils";

const ROW_ICON_CLASS = "size-3.5 shrink-0 text-muted-foreground";

/** BB has no # or @ icon; draw the character, as the channel sidebar does. */
export function GlyphIcon({
  glyph,
  className = ROW_ICON_CLASS,
}: {
  glyph: "#" | "@";
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex items-center justify-center text-[13px] font-medium leading-none",
        className,
      )}
    >
      {glyph}
    </span>
  );
}

function SuggestionRow({
  id,
  selected,
  icon,
  primary,
  trailing,
  title,
  onApply,
  onHover,
  rowRef,
}: {
  id: string;
  selected: boolean;
  icon: ReactNode;
  primary: string;
  trailing?: ReactNode;
  title: string;
  onApply: () => void;
  onHover: () => void;
  rowRef: (element: HTMLButtonElement | null) => void;
}) {
  return (
    <button
      ref={rowRef}
      id={id}
      type="button"
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      onMouseDown={(event) => {
        event.preventDefault();
        onApply();
      }}
      onMouseEnter={onHover}
      className={cn(
        "w-full scroll-mt-7 rounded px-2 py-1.5 text-left text-xs",
        selected ? "bg-state-active text-foreground" : "hover:bg-state-hover",
      )}
      title={title}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        {icon}
        <span className="truncate text-foreground">{primary}</span>
        {trailing}
      </div>
    </button>
  );
}

function MutedTrailing({ children }: { children: ReactNode }) {
  return (
    <span className="truncate text-subtle-foreground [flex-shrink:9999]">
      {children}
    </span>
  );
}

function MenuSectionHeader({ label }: { label: string }) {
  return (
    <div
      role="presentation"
      className="sticky top-0 z-10 bg-background px-3 pb-1 pt-1.5 text-xs text-muted-foreground"
    >
      {label}
    </div>
  );
}

function MenuStatusRow({ children }: { children: ReactNode }) {
  return (
    <div role="presentation" className="px-3 py-2 text-xs text-muted-foreground">
      {children}
    </div>
  );
}

type Row = {
  key: string;
  section: string;
  icon: ReactNode;
  primary: string;
  trailing?: ReactNode;
  title: string;
  apply: () => void;
};

export function ComposerMentionMenu({
  kind,
  query,
  bots,
  memberIds,
  rooms,
  currentRoomId,
  selectedIndex,
  listId,
  onHover,
  onInsert,
  onCreateBot,
}: {
  kind: "bot" | "channel";
  query: string;
  bots: Bot[];
  memberIds: string[];
  rooms: Room[];
  currentRoomId: string;
  selectedIndex: number;
  listId: string;
  onHover: (index: number) => void;
  onInsert: (item: Bot | Room | BroadcastMention) => void;
  onCreateBot: () => void;
}) {
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const rows: Row[] =
    kind === "channel"
      ? matchingChannels(rooms, currentRoomId, query).map((room) => ({
          key: room.id,
          section: "Channels",
          icon: <GlyphIcon glyph="#" />,
          primary: room.name,
          trailing: <MutedTrailing>#{channelSlug(room.name)}</MutedTrailing>,
          title: room.name,
          apply: () => onInsert(room),
        }))
      : [
          ...matchingBroadcastMentions(query).map((mention) => ({
            key: `@${mention.handle}`,
            section: "Everyone",
            icon: <GlyphIcon glyph="@" />,
            primary: `@${mention.handle}`,
            trailing: <MutedTrailing>Everyone in this channel</MutedTrailing>,
            title: `@${mention.handle}`,
            apply: () => onInsert(mention),
          })),
          ...matchingBots(bots, memberIds, query).map((bot) => ({
            key: bot.id,
            section: memberIds.includes(bot.id)
              ? "In this channel"
              : "Other bots",
            icon: (
              <span
                aria-hidden
                className="flex size-3.5 shrink-0 items-center justify-center text-[13px] leading-none"
              >
                {bot.avatar}
              </span>
            ),
            primary: bot.name,
            trailing: (
              <MutedTrailing>
                @{bot.handle}
                {memberIds.includes(bot.id) ? "" : " · Invite"}
              </MutedTrailing>
            ),
            title: `${bot.name} (@${bot.handle})`,
            apply: () => onInsert(bot),
          })),
        ];
  if (kind === "bot")
    rows.push({
      key: "create",
      section: "",
      icon: <Icon name="Plus" className={ROW_ICON_CLASS} aria-hidden />,
      primary: "Create new bot…",
      title: "Create new bot",
      apply: onCreateBot,
    });
  const selected = Math.min(selectedIndex, rows.length - 1);

  useEffect(() => {
    rowRefs.current[selected]?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const matchCount = rows.filter((row) => row.section).length;
  return (
    <div className="overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md">
      <div
        id={listId}
        role="listbox"
        aria-label={kind === "channel" ? "Channels" : "Mentions"}
        className="max-h-48 overflow-y-auto pb-1"
      >
        {matchCount === 0 ? (
          <MenuStatusRow>
            {kind === "channel" ? "No matching channels" : "No matching bots"}
          </MenuStatusRow>
        ) : null}
        {rows.map((row, index) => {
          const startsSection =
            row.section !== (rows[index - 1]?.section ?? null);
          return (
            <div key={row.key}>
              {startsSection && row.section ? (
                <MenuSectionHeader label={row.section} />
              ) : startsSection && index > 0 ? (
                <div role="presentation" className="mx-1 my-1 h-px bg-muted" />
              ) : null}
              <div className="px-1">
                <SuggestionRow
                  id={`${listId}-${index}`}
                  selected={index === selected}
                  icon={row.icon}
                  primary={row.primary}
                  trailing={row.trailing}
                  title={row.title}
                  onApply={row.apply}
                  onHover={() => onHover(index)}
                  rowRef={(element) => {
                    rowRefs.current[index] = element;
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
