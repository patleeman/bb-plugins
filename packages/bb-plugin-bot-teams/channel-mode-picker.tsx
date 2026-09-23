import { useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { Room, rpcContract } from "./contract";
import { OptionPicker } from "./components/ui/option-picker";
import { ErrorMessage, message } from "./bot-ui";

const modes = [
  { value: "smart", label: "Smart", description: "Choose relevant bots" },
  {
    value: "directed",
    label: "Directed",
    description: "Only mentions and replies",
  },
  { value: "everyone", label: "Everyone", description: "All bots can respond" },
] as const;

export function ChannelModePicker({
  room,
  onChanged,
}: {
  room: Room;
  onChanged: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
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
      <OptionPicker
        label="Chat mode"
        note={`New channels start in ${selected.label} mode.`}
        value={value}
        options={modes}
        icon="MessageSquare"
        muted
        busy={pending}
        disabled={pending || !!room.archived}
        onChange={(next) => void changeMode(next)}
        className="h-6"
        caretClassName="text-subtle-foreground/75"
        contentClassName="max-w-72"
      />
      <ErrorMessage error={error} />
    </>
  );
}
