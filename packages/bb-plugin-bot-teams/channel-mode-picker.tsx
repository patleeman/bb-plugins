import { useId, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { experimental_Icon as Icon, useRpc } from "@get-bb/plugin-sdk/app";
import type { Room, rpcContract } from "./contract";
import { Button } from "./components/ui/button";
import { ErrorMessage, message } from "./bot-ui";

const modes = [
  { value: "smart", label: "Smart", hint: "Choose relevant bots" },
  { value: "directed", label: "Directed", hint: "Only mentions and replies" },
  { value: "everyone", label: "Everyone", hint: "All bots can respond" },
] as const;

export function ChannelModePicker({
  room,
  onChanged,
}: {
  room: Room;
  onChanged: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const hintId = useId();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const value = room.responseBehavior ?? "everyone";
  const selected = modes.find((mode) => mode.value === value)!;

  const changeMode = async (next: string) => {
    const mode = modes.find((option) => option.value === next);
    if (!mode || pending || room.archived) return;
    setPending(true);
    setError(null);
    try {
      await rpc.call("channelState", {
        id: room.id,
        responseBehavior: mode.value,
        rememberDefault: true,
      });
      onChanged();
    } catch (e) {
      setError(message(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={`Chat mode: ${selected.label}`}
            aria-busy={pending || undefined}
            disabled={pending || !!room.archived}
            // Match BB's ProjectSelector option trigger beneath the prompt box.
            className="h-8 w-fit max-w-full min-w-0 justify-start gap-1 border-none bg-transparent px-1 text-xs leading-tight text-muted-foreground shadow-none hover:text-muted-foreground [&_[data-icon-root]]:size-3.5 max-md:pointer-coarse:h-9"
          >
            <Icon name="MessageSquare" aria-hidden />
            <span className="truncate">{selected.label}</span>
            <Icon name="ChevronDown" aria-hidden />
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            aria-label="Chat mode"
            align="start"
            side="top"
            sideOffset={4}
            collisionPadding={8}
            className="channel-popover channel-mode-menu"
          >
            <DropdownMenu.Label className="channel-menu-label">
              Chat mode
            </DropdownMenu.Label>
            <p className="channel-mode-default-hint">
              New channels start in {selected.label} mode.
            </p>
            <DropdownMenu.RadioGroup
              value={value}
              onValueChange={(next) => void changeMode(next)}
            >
              {modes.map((mode) => (
                <DropdownMenu.RadioItem
                  key={mode.value}
                  value={mode.value}
                  disabled={pending || !!room.archived}
                  textValue={mode.label}
                  aria-describedby={`${hintId}-${mode.value}`}
                  className="channel-menu-row"
                >
                  <span className="channel-mode-mark" aria-hidden>
                    <DropdownMenu.ItemIndicator>
                      <Icon name="Check" />
                    </DropdownMenu.ItemIndicator>
                  </span>
                  <span className="channel-bot-name">
                    {mode.label}
                    <small id={`${hintId}-${mode.value}`}>{mode.hint}</small>
                  </span>
                </DropdownMenu.RadioItem>
              ))}
            </DropdownMenu.RadioGroup>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <ErrorMessage error={error} />
    </>
  );
}
