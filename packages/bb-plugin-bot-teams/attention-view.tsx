import { useCallback, useEffect, useRef, useState } from "react";
import {
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  experimental_Icon as Icon,
} from "@get-bb/plugin-sdk/app";
import type { Attention, AttentionView, rpcContract } from "./contract";
import { Button } from "./components/ui/button";
import { ErrorMessage, message } from "./bot-ui";

export function useAttention(
  status: Attention["status"] = "open",
  limit = 30,
  offset = 0,
  channelId?: string,
) {
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();
  const [data, setData] = useState<{
    items: AttentionView[];
    openCount: number;
    nextOffset: number | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  const load = useCallback(() => {
    const seq = ++sequence.current;
    return rpc
      .call("attentionList", {
        status,
        limit,
        offset,
        ...(channelId ? { channelId } : {}),
      })
      .then(
        (result) => {
          if (seq === sequence.current) {
            setData(result);
            setError(null);
          }
        },
        (cause) => {
          if (seq === sequence.current) setError(message(cause));
        },
      );
  }, [rpc, status, limit, offset, channelId]);
  useEffect(() => {
    setData(null);
    void load();
    return () => {
      sequence.current++;
    };
  }, [load]);
  useEffect(() => {
    if (connection === "connected") void load();
  }, [connection, load]);
  useRealtime("changed", load);
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== "hidden") void load();
    };
    const timer = setInterval(refresh, 15000);
    window.addEventListener("focus", refresh);
    window.addEventListener("pageshow", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("pageshow", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [load]);
  return { data, error, load };
}

export const attentionReasons = {
  decision: "Decision needed",
  blocker: "Blocked",
  update: "Important update",
};
const reasons = attentionReasons;

export function MessageAttention({ id, status }: { id: string; status?: Attention["status"] }) {
  const rpc = useRpc<typeof rpcContract>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = status === "open";
  const act = async (action: "acknowledge" | "snooze" | "reopen") => {
    setPending(true);
    setError(null);
    try {
      await rpc.call("attentionUpdate", {
        id,
        action,
        ...(action === "snooze" ? { minutes: 60 } : {}),
      });
    } catch (cause) {
      setError(message(cause));
    } finally {
      setPending(false);
    }
  };
  return <div className="message-attention" data-open={open || undefined}>
    <span className="message-attention-label">
      <Icon name={open ? "BellDot" : status === "acknowledged" ? "Check" : status === "snoozed" ? "Clock" : "AtSign"} />
      {open ? "Needs you" : status === "acknowledged" ? "Acknowledged" : status === "snoozed" ? "Snoozed" : "Mentioned you"}
    </span>
    {open && <>
      <Button size="sm" variant="ghost" disabled={pending} onClick={() => void act("acknowledge")}>Acknowledge</Button>
      <Button size="sm" variant="ghost" disabled={pending} onClick={() => void act("snooze")}>Snooze 1 hour</Button>
    </>}
    {(status === "snoozed" || status === "acknowledged") &&
      <Button size="sm" variant="ghost" disabled={pending} onClick={() => void act("reopen")}>Bring back</Button>}
    {error && <span role="alert">{error}</span>}
  </div>;
}

export function ChannelAttentionBanner({
  roomId,
  messageId,
}: {
  roomId: string;
  messageId?: string;
}) {
  const { data, load } = useAttention("open", 50, 0, roomId);
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const item = messageId
    ? data?.items.find((item) => item.id === messageId)
    : null;
  const pendingReplies = data?.items.filter((entry) => entry.pendingReply) ?? [];
  if (!data?.items.length) return null;
  return (
    <div className="channel-attention-banner">
      <span>
        {item
          ? reasons[item.reason]
          : `${data.items.length === 50 ? "50+" : data.items.length} ${data.items.length === 1 ? "request needs" : "requests need"} you`}
      </span>
      {item && (
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={async () => {
            setPending(true);
            setError(null);
            try {
              await rpc.call("attentionUpdate", {
                id: item.id,
                action: "acknowledge",
              });
              await load();
            } catch (cause) {
              setError(message(cause));
            } finally {
              setPending(false);
            }
          }}
        >
          Acknowledge
        </Button>
      )}
      {!item && <Button
        size="sm"
        variant="ghost"
        onClick={() => navigate.toPluginPanel("channels", {
          subPath: `${roomId}/message/${encodeURIComponent(data.items[0]!.message.id)}`,
        })}
      >
        Go to request
      </Button>}
      {pendingReplies.length > 0 && <div className="channel-pending-replies">
        {pendingReplies.map((entry) => <div key={entry.id} role={entry.pendingReply!.error ? "alert" : "status"}>
          <span>{entry.pendingReply!.error
            ? `Your answer to ${entry.message.speaker} has not been sent: ${entry.pendingReply!.error}`
            : `Sending your answer to ${entry.message.speaker}…`}</span>
          <blockquote>{entry.pendingReply!.text}</blockquote>
          {entry.pendingReply!.error && <Button size="sm" variant="outline" disabled={pending} onClick={async () => {
            setPending(true);
            setError(null);
            try {
              await rpc.call("attentionDiscardReply", { id: entry.pendingReply!.id });
              await load();
            } catch (cause) {
              setError(message(cause));
            } finally {
              setPending(false);
            }
          }}>Discard unsent reply</Button>}
        </div>)}
      </div>}
      <ErrorMessage error={error} />
    </div>
  );
}
