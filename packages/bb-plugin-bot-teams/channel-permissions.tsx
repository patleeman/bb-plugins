import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import {
  experimental_Icon as Icon,
  experimental_PermissionModePicker as PermissionModePicker,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { Bot, PermissionMode, Room, rpcContract } from "./contract";
import { permissionOptions, permissionSummary } from "./permission-mode";
import { Button } from "./components/ui/button";
import { ErrorMessage, message } from "./bot-ui";

/**
 * The channel-wide gate, plus each bot's own mode, in one place. A thread has a
 * single provider and one label; a channel has one bot per provider, so each
 * bot's row uses BB's picker bound to that bot's provider.
 */
export function ChannelPermissionPicker({
  room,
  bots,
  onChanged,
}: {
  room: Room;
  bots: Bot[];
  onChanged: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const members = bots.filter(
    (b) => room.memberIds.includes(b.id) && !b.retired,
  );
  const summary = permissionSummary(room, members);
  const elevated = (room.permissionMode ?? null) === "full";
  const setChannelMode = async (value: PermissionMode | null) => {
    if (pending || room.archived) return;
    setPending(true);
    setError(null);
    try {
      await rpc.call("channelState", { id: room.id, permissionMode: value });
      onChanged();
    } catch (e) {
      setError(message(e));
    } finally {
      setPending(false);
    }
  };
  const setBotMode = async (bot: Bot, value: PermissionMode) => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await rpc.call("update", { id: bot.id, permissionMode: value });
      onChanged();
    } catch (e) {
      setError(message(e));
    } finally {
      setPending(false);
    }
  };
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`Bot permissions: ${summary}`}
          aria-busy={pending || undefined}
          disabled={!!room.archived}
          data-elevated={elevated || undefined}
          // Match BB's permission control beneath the thread composer.
          className="channel-permission-trigger h-8 w-fit max-w-full min-w-0 justify-start gap-1 border-none bg-transparent px-1 text-xs leading-tight text-muted-foreground shadow-none [&_[data-icon-root]]:size-3.5 max-md:pointer-coarse:h-9"
        >
          <span className="channel-permission-label">Bot permissions:</span>
          <span className="truncate">{summary}</span>
          <Icon name="ChevronDown" />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          className="channel-permission-popover"
          aria-label="Bot permissions"
        >
          <p className="channel-permission-heading" id={`${room.id}-all`}>
            All bots in this channel
          </p>
          <div role="radiogroup" aria-labelledby={`${room.id}-all`}>
            {permissionOptions.map((option) => {
              const selected = (room.permissionMode ?? null) === option.value;
              return (
                <button
                  key={option.label}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  className="channel-permission-option"
                  disabled={pending || !!room.archived}
                  onClick={() => void setChannelMode(option.value)}
                >
                  <span className="channel-permission-check" aria-hidden>
                    {selected && <Icon name="Check" />}
                  </span>
                  <span>
                    <strong>{option.label}</strong>
                    <span className="channel-permission-hint">
                      {option.hint}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          <p className="channel-permission-note">
            {room.permissionMode
              ? "Applies to each bot's next turn in this channel when its provider supports the mode. Profiles are used elsewhere."
              : "Uses each bot's profile mode for work started in this channel."}
          </p>
          {members.length > 0 && (
            <>
              <p className="channel-permission-heading">Bot profile defaults</p>
              {members.map((bot) => (
                <div className="channel-permission-bot" key={bot.id}>
                  <span className="channel-permission-bot-name">
                    <span aria-hidden>{bot.avatar}</span>
                    <span className="truncate">{bot.name}</span>
                  </span>
                  <PermissionModePicker
                    align="end"
                    disabled={pending || !!room.permissionMode}
                    providerId={bot.providerId}
                    value={bot.permissionMode}
                    routing={{ kind: "host", hostId: bot.hostId }}
                    onChange={(value) => void setBotMode(bot, value)}
                  />
                </div>
              ))}
              <p className="channel-permission-note">
                Each bot's profile applies in every channel unless that channel
                has an override.
              </p>
            </>
          )}
          <ErrorMessage error={error} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
