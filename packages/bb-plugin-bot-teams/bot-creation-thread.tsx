import { useEffect, useState } from "react";
import {
  experimental_NewThreadComposer as NewThreadComposer,
  useBbNavigate,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { Room, rpcContract } from "./contract";
import { botCreationPrompt } from "./bot-creation";
import { BackButton, ErrorMessage, message } from "./bot-ui";

export function BotCreationThread({ roomId }: { roomId?: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [room, setRoom] = useState<Room | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!roomId) return;
    let active = true;
    rpc.call("room", { id: roomId }).then(
      (data) => {
        if (active) setRoom(data.room);
      },
      (cause) => {
        if (active) setError(message(cause));
      },
    );
    return () => {
      active = false;
    };
  }, [rpc, roomId]);
  return (
    <div className="flex h-full min-h-0 flex-col" data-bot-creation-thread>
      <header className="flex items-center gap-2 px-4 py-3">
        <BackButton
          label={roomId ? "Back to channel" : "All bots"}
          onClick={() =>
            roomId
              ? navigate.toPluginPanel("channels", { subPath: roomId })
              : navigate.toPluginPanel("bots")
          }
        />
        <h1 className="text-sm font-medium">Create a bot</h1>
      </header>
      <ErrorMessage error={error} />
      {!roomId || room ? (
        <NewThreadComposer
          className="mx-auto min-h-0 w-full max-w-5xl flex-1 px-4 pb-4"
          draftKey={`bot-creation:${roomId ?? "standalone"}`}
          initialPrompt={botCreationPrompt(room ?? undefined)}
          focusRequest={1}
          onSubmit={async (request) => {
            setError(null);
            try {
              const { threadId } = await rpc.call("createBotSetupThread", request);
              navigate.toThread(threadId);
            } catch (cause) {
              setError(message(cause));
              throw cause; // Keep the host composer draft for retry.
            }
          }}
        />
      ) : !error ? (
        <p role="status">Loading channel…</p>
      ) : null}
    </div>
  );
}
