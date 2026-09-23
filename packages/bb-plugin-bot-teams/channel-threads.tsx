import { useEffect, useState } from "react";
import {
  experimental_Icon as Icon,
  experimental_useSidebarThreadActions as useSidebarThreadActions,
  experimental_useSidebarThreadSplit as useSidebarThreadSplit,
  useBbContext,
  useBbNavigate,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./contract";

const expandedKey = "bb:bots:expanded-channels";
const revealEvent = "bb:bots:reveal-thread";

type ChannelThread = {
  threadId: string;
  botId: string;
  name: string;
  avatar: string;
  active: boolean;
  needsApproval: boolean;
};

/** Open a bot's work thread and show it nested under its channel. */
export function openWorkThread(
  navigate: { toThread(threadId: string): void },
  threadId: string,
  roomId: string | null | undefined,
) {
  if (roomId)
    window.dispatchEvent(new CustomEvent(revealEvent, { detail: { roomId } }));
  navigate.toThread(threadId);
}

/** Which channels show their bot threads. Persists per device. */
export function useExpandedChannels() {
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(expandedKey) ?? "[]"));
    } catch {
      return new Set();
    }
  });
  const update = (roomId: string, open: boolean) =>
    setExpanded((old) => {
      if (old.has(roomId) === open) return old;
      const next = new Set(old);
      if (open) next.add(roomId);
      else next.delete(roomId);
      try {
        localStorage.setItem(expandedKey, JSON.stringify([...next]));
      } catch {}
      return next;
    });
  useEffect(() => {
    const reveal = (event: Event) => {
      const roomId = (event as CustomEvent<{ roomId: string }>).detail?.roomId;
      if (roomId) update(roomId, true);
    };
    window.addEventListener(revealEvent, reveal);
    return () => window.removeEventListener(revealEvent, reveal);
  }, []);
  return { expanded, setExpanded: update };
}

export function ChannelThreadList({
  roomId,
  refreshKey,
}: {
  roomId: string;
  refreshKey: string;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [threads, setThreads] = useState<ChannelThread[] | null>(null);
  useEffect(() => {
    let live = true;
    void rpc.call("channelThreads", { id: roomId }).then(
      (next) => live && setThreads(next),
      () => live && setThreads([]),
    );
    return () => {
      live = false;
    };
  }, [roomId, refreshKey, rpc]);
  if (!threads) return null;
  if (!threads.length)
    return <p className="channel-thread-empty">No bot threads yet</p>;
  return (
    <ul className="channel-thread-list" aria-label="Bot threads">
      {threads.map((t) => (
        <ChannelThreadRow key={t.threadId} thread={t} />
      ))}
    </ul>
  );
}

function ChannelThreadRow({ thread }: { thread: ChannelThread }) {
  const { threadId } = useBbContext();
  const navigate = useBbNavigate();
  const actions = useSidebarThreadActions();
  const split = useSidebarThreadSplit(thread.threadId);
  const current = threadId === thread.threadId;
  return (
    <li>
      <button
        type="button"
        className="channel-nav-row channel-thread-row"
        aria-current={current ? "page" : undefined}
        title={split.isAvailable ? "Drag or ⌘-click to open in a split" : undefined}
        {...split.splitProps}
        onClick={(event) => {
          if (split.isAvailable && (event.metaKey || event.ctrlKey))
            actions.open(thread.threadId, { split: true });
          else navigate.toThread(thread.threadId);
        }}
      >
        <span className="channel-thread-avatar" aria-hidden>
          {thread.avatar}
        </span>
        <span className="channel-nav-name">{thread.name}</span>
        {thread.needsApproval && (
          <span
            className="channel-needs-attention"
            role="img"
            aria-label="Waiting for your approval"
            title="Waiting for your approval"
          >
            <Icon name="BellDot" />
          </span>
        )}
        {thread.active && (
          <span className="channel-nav-status">
            <span className="channel-working" role="img" aria-label="Working" title="Working">
              <Icon name="Loading" />
            </span>
          </span>
        )}
      </button>
    </li>
  );
}
