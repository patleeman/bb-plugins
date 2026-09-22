import { useState, type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import * as Dialog from "@radix-ui/react-dialog";
import * as Tooltip from "@radix-ui/react-tooltip";
import EmojiPicker, {
  Categories,
  EmojiStyle,
  SuggestionMode,
} from "emoji-picker-react";
import { emojiCatalog } from "./emoji-catalog";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { Bot, Room } from "./contract";
import { channelSlug, matchingChannels } from "./channel-references";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";

export function Menu({
  trigger,
  children,
  label,
  open,
  onOpenChange,
  className = "",
  tooltip,
}: {
  trigger: ReactNode;
  children: ReactNode;
  label: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  tooltip?: string;
}) {
  const triggerElement = <Popover.Trigger asChild>{trigger}</Popover.Trigger>;
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      {tooltip ? (
        <Tooltip.Root>
          <Tooltip.Trigger asChild>{triggerElement}</Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content className="channel-tooltip" sideOffset={6}>
              {tooltip}
            </Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
      ) : (
        triggerElement
      )}
      <Popover.Portal>
        <Popover.Content
          aria-label={label}
          align="end"
          sideOffset={5}
          className={`channel-popover ${className}`}
        >
          {children}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function IconActionTooltip({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="channel-tooltip" sideOffset={6}>
          {label}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
export function Modal({
  title,
  open,
  onOpenChange,
  children,
}: {
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="channel-dialog-overlay" />
        <Dialog.Content className="channel-dialog" aria-describedby={undefined}>
          <header>
            <Dialog.Title>{title}</Dialog.Title>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon" aria-label="Close dialog">
                <Icon name="X" />
              </Button>
            </Dialog.Close>
          </header>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function BotOptions({
  bots,
  memberIds,
  query,
  selected,
  onSelect,
  onCreate,
  listId,
  onHover,
}: {
  bots: Bot[];
  memberIds: string[];
  query: string;
  selected?: number;
  onSelect: (bot: Bot) => void;
  onCreate: () => void;
  listId?: string;
  onHover?: (index: number) => void;
}) {
  const matches = matchingBots(bots, memberIds, query);
  return (
    <div
      id={listId}
      role="listbox"
      aria-label="Bots"
      className="channel-bot-options"
    >
      {matches.map((bot, i) => (
        <div key={bot.id}>
          {(i === 0 ||
            memberIds.includes(matches[i - 1]!.id) !==
              memberIds.includes(bot.id)) && (
            <div className="channel-menu-label">
              {memberIds.includes(bot.id) ? "In this channel" : "Other bots"}
            </div>
          )}
          <button
            type="button"
            role="option"
            aria-selected={selected === i}
            id={listId ? `${listId}-${i}` : undefined}
            className="channel-menu-row"
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => onHover?.(i)}
            onClick={() => onSelect(bot)}
          >
            <span className="channel-avatar" aria-hidden>
              {bot.avatar}
            </span>
            <span className="channel-bot-name">
              {bot.name}
              <small>@{bot.handle}</small>
            </span>
            <small>{!memberIds.includes(bot.id) ? "Invite" : ""}</small>
          </button>
        </div>
      ))}
      {!matches.length && (
        <p className="channel-menu-label">No matching bots</p>
      )}
      <button
        type="button"
        role="option"
        aria-selected={selected === matches.length}
        id={listId ? `${listId}-${matches.length}` : undefined}
        className="channel-menu-row channel-menu-footer"
        onMouseDown={(e) => e.preventDefault()}
        onMouseEnter={() => onHover?.(matches.length)}
        onClick={onCreate}
      >
        <Icon name="Plus" /> Create new bot…
      </button>
    </div>
  );
}

export function ChannelOptions({
  rooms,
  currentRoomId,
  query,
  selected,
  onSelect,
  listId,
  onHover,
}: {
  rooms: Room[];
  currentRoomId: string;
  query: string;
  selected?: number;
  onSelect: (room: Room) => void;
  listId?: string;
  onHover?: (index: number) => void;
}) {
  const matches = matchingChannels(rooms, currentRoomId, query);
  return (
    <div
      id={listId}
      role="listbox"
      aria-label="Channels"
      className="channel-bot-options"
    >
      {matches.map((room, i) => (
        <button
          type="button"
          role="option"
          aria-selected={selected === i}
          id={listId ? `${listId}-${i}` : undefined}
          className="channel-menu-row"
          key={room.id}
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => onHover?.(i)}
          onClick={() => onSelect(room)}
        >
          <span className="channel-hash" aria-hidden>
            #
          </span>
          <span className="channel-bot-name">
            {room.name}
            <small>#{channelSlug(room.name)}</small>
          </span>
        </button>
      ))}
      {!matches.length && (
        <p className="channel-menu-label">No matching channels</p>
      )}
    </div>
  );
}
export function matchingBots(bots: Bot[], memberIds: string[], query: string) {
  const q = query.toLowerCase();
  return bots
    .filter((b) => !b.retired)
    .filter((b) => `${b.name} ${b.handle}`.toLowerCase().includes(q))
    .sort(
      (a, b) =>
        Number(memberIds.includes(b.id)) - Number(memberIds.includes(a.id)) ||
        a.name.localeCompare(b.name),
    );
}
export function InvitePicker({
  bots,
  memberIds,
  onSelect,
  onCreate,
}: {
  bots: Bot[];
  memberIds: string[];
  onSelect: (bot: Bot) => void;
  onCreate: () => void;
}) {
  const [query, setQuery] = useState("");
  return (
    <>
      <Input
        autoFocus
        aria-label="Find a bot"
        placeholder="Find a bot…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <BotOptions
        bots={bots}
        memberIds={memberIds}
        query={query}
        onSelect={onSelect}
        onCreate={onCreate}
      />
    </>
  );
}
const emojiCategories = [
  { category: Categories.SUGGESTED, name: "Recently Used" },
  { category: Categories.SMILEYS_PEOPLE, name: "Smileys & People" },
  { category: Categories.ANIMALS_NATURE, name: "Animals & Nature" },
  { category: Categories.FOOD_DRINK, name: "Food & Drink" },
  { category: Categories.TRAVEL_PLACES, name: "Travel & Places" },
  { category: Categories.ACTIVITIES, name: "Activities" },
  { category: Categories.OBJECTS, name: "Objects" },
  { category: Categories.SYMBOLS, name: "Symbols" },
  { category: Categories.FLAGS, name: "Flags" },
];
export function ReactionPicker({
  onReact,
  label = "Add reaction",
  open,
  onOpenChange,
}: {
  onReact: (emoji: string) => void;
  label?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const visible = open ?? internalOpen;
  const setVisible = (next: boolean) => {
    onOpenChange?.(next);
    if (open === undefined) setInternalOpen(next);
  };
  const select = (emoji: string) => {
    onReact(emoji);
    setVisible(false);
  };
  return (
    <Menu
      label="Choose a reaction"
      open={visible}
      onOpenChange={setVisible}
      className="channel-emoji-picker"
      tooltip={label}
      trigger={
        <Button variant="ghost" size="icon" aria-label={label}>
          <span className="channel-react-icon" aria-hidden>
            ☺<sup>+</sup>
          </span>
        </Button>
      }
    >
      <EmojiPicker
        emojiData={emojiCatalog}
        categories={emojiCategories}
        emojiStyle={EmojiStyle.NATIVE}
        suggestedEmojisMode={SuggestionMode.RECENT}
        searchPlaceholder="Search emoji…"
        autoFocusSearch
        width="100%"
        height="100%"
        previewConfig={{
          defaultCaption: "Choose a reaction",
          defaultEmoji: "1f44d",
        }}
        onEmojiClick={({ emoji }) => select(emoji)}
      />
    </Menu>
  );
}
