import { useEffect, useRef } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "./contract";
import { emptyDraft } from "./draft";

const eventName = "bb:bots:handoff-to-channel";

export function requestChannelHandoff(threadId: string) {
  window.dispatchEvent(new CustomEvent(eventName, { detail: threadId }));
}

export function ChannelHandoffController() {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const pending = useRef(false);

  useEffect(() => {
    const handoff = async (event: Event) => {
      const threadId = (event as CustomEvent<unknown>).detail;
      if (typeof threadId !== "string" || !threadId || pending.current) return;
      pending.current = true;
      try {
        const source = await rpc.call("handoffSource", { threadId });
        const room = await rpc.call("createRoom", { memberIds: [] });
        const key = `bb:bots:draft:${room.id}`;
        try {
          localStorage.setItem(
            key,
            JSON.stringify({
              ...emptyDraft(),
              handoffSource: source,
            }),
          );
        } catch {
          await rpc.call("deleteRoom", { id: room.id }).catch(() => {});
          throw new Error("Could not save the channel handoff draft.");
        }
        navigate.toPluginPanel("channels", { subPath: room.id });
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Could not open a channel.",
        );
      } finally {
        pending.current = false;
      }
    };
    window.addEventListener(eventName, handoff);
    return () => window.removeEventListener(eventName, handoff);
  }, [rpc, navigate]);

  return null;
}
