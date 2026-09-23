import { useCallback, useEffect, useRef, useState } from "react";
import {
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  Markdown,
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
  return <div className="message-attention" data-open={open || undefined}>
    <span className="message-attention-label">
      <Icon name={open ? "BellDot" : status === "acknowledged" ? "Check" : status === "snoozed" ? "Clock" : "AtSign"} />
      {open ? "Needs you" : status === "acknowledged" ? "Acknowledged" : status === "snoozed" ? "Snoozed" : "Mentioned you"}
    </span>
    {open && <Button size="sm" variant="ghost" disabled={pending} onClick={async () => {
      setPending(true); setError(null);
      try { await rpc.call("attentionUpdate", { id, action: "acknowledge" }); }
      catch (cause) { setError(message(cause)); }
      finally { setPending(false); }
    }}>Acknowledge</Button>}
    {error && <span role="alert">{error}</span>}
  </div>;
}

export function AttentionInbox() {
  const [status, setStatus] = useState<Attention["status"]>("open");
  const [offset, setOffset] = useState(0);
  const { data, error, load } = useAttention(status, 30, offset);
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [pending, setPending] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const act = async (
    id: string,
    action: "acknowledge" | "snooze" | "reopen",
    minutes?: number,
  ) => {
    setPending(id);
    setFailure(null);
    try {
      await rpc.call("attentionUpdate", {
        id,
        action,
        ...(minutes ? { minutes } : {}),
      });
      if (offset && data?.items.length === 1)
        setOffset(Math.max(0, offset - 30));
      else await load();
    } catch (cause) {
      setFailure(message(cause));
    } finally {
      setPending(null);
    }
  };
  return (
    <div className="attention-inbox">
      <header className="attention-toolbar">
        <h1>For you</h1>
        <div
          className="attention-filters"
          role="group"
          aria-label="Attention status"
        >
          {(["open", "snoozed", "acknowledged"] as const).map((value) => (
            <Button
              key={value}
              size="sm"
              variant={status === value ? "secondary" : "ghost"}
              aria-pressed={status === value}
              onClick={() => {
                setStatus(value);
                setOffset(0);
              }}
            >
              {
                {
                  open: "Needs you",
                  snoozed: "Snoozed",
                  acknowledged: "Acknowledged",
                }[value]
              }
            </Button>
          ))}
        </div>
      </header>
      <ErrorMessage error={failure ?? error} />
      {!data && !error && <p role="status">Loading requests…</p>}
      {data && !data.items.length && (
        <div className="attention-empty">
          <p>
            {status === "open"
              ? "Nothing needs your attention."
              : status === "snoozed"
                ? "No snoozed requests."
                : "No acknowledged requests yet."}
          </p>
          {status === "open" && (
            <p className="text-sm text-muted-foreground">
              Bots can mention @user or request your attention for a decision,
              blocker, or important update.
            </p>
          )}
        </div>
      )}
      <div className="attention-items">
        {data?.items.map((item) => (
          <article
            className="attention-item"
            key={item.id}
            aria-label={`${reasons[item.reason]} from ${item.message.speaker}`}
          >
            <div className="attention-meta">
              <strong>{reasons[item.reason]}</strong>
              <span>
                {item.message.speaker} · #{item.channelName}
              </span>
              <time dateTime={new Date(item.createdAt).toISOString()}>
                {new Date(item.createdAt).toLocaleString()}
              </time>
            </div>
            <div className="attention-body">
              <Markdown content={item.message.text} />
            </div>
            {item.pendingReply && <div role={item.pendingReply.error ? "alert" : "status"}>
              <p>{item.pendingReply.error ? `Your answer has not been sent: ${item.pendingReply.error}` : "Sending your answer to the channel…"}</p>
              <blockquote>{item.pendingReply.text}</blockquote>
              {item.pendingReply.error && <Button size="sm" variant="outline" disabled={pending !== null} onClick={async () => {
                setPending(item.id); setFailure(null);
                try { await rpc.call("attentionDiscardReply", { id: item.pendingReply!.id }); }
                catch (cause) { setFailure(message(cause)); } finally { await load(); setPending(null); }
              }}>Discard unsent reply</Button>}
            </div>}
            {item.snoozedUntil && (
              <p className="text-sm text-muted-foreground">
                Returns {new Date(item.snoozedUntil).toLocaleString()}
              </p>
            )}
            <div className="attention-actions">
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  navigate.toPluginPanel("channels", {
                    subPath: `${item.roomId}/message/${item.id}/reply`,
                  })
                }
              >
                Reply in channel
              </Button>
              {status !== "acknowledged" && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending !== null}
                  onClick={() => act(item.id, "acknowledge")}
                >
                  Acknowledge
                </Button>
              )}
              {status === "open" && (
                <select
                  aria-label={`Snooze request from ${item.message.speaker}`}
                  disabled={pending !== null}
                  value=""
                  onChange={(e) => {
                    if (e.target.value)
                      void act(item.id, "snooze", Number(e.target.value));
                  }}
                >
                  <option value="" disabled>
                    Snooze…
                  </option>
                  <option value="60">1 hour</option>
                  <option value="240">4 hours</option>
                  <option value="1440">1 day</option>
                </select>
              )}
              {status !== "open" && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending !== null}
                  onClick={() => act(item.id, "reopen")}
                >
                  Bring back
                </Button>
              )}
            </div>
          </article>
        ))}
      </div>
      {(offset > 0 ||
        (data?.nextOffset !== null && data?.nextOffset !== undefined)) && (
        <div className="attention-pagination">
          <Button
            variant="ghost"
            disabled={!offset}
            onClick={() => setOffset(Math.max(0, offset - 30))}
          >
            Previous
          </Button>
          <Button
            variant="ghost"
            disabled={data?.nextOffset == null}
            onClick={() => setOffset(data?.nextOffset ?? offset)}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
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
      <Button
        size="sm"
        variant="ghost"
        onClick={() => navigate.toPluginPanel("for-you")}
      >
        For you
      </Button>
      <ErrorMessage error={error} />
    </div>
  );
}
