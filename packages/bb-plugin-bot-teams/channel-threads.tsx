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

type ChannelThread = {
  threadId: string;
  botId: string;
  name: string;
  avatar: string;
  active: boolean;
  needsApproval: boolean;
};

/** Open a bot DM. The sidebar shows DMs for the selected channel. */
export function openWorkThread(
  navigate: { toThread(threadId: string): void },
  threadId: string,
  _roomId: string | null | undefined,
) {
  navigate.toThread(threadId);
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
    return <p className="channel-thread-empty">No bot DMs yet</p>;
  return (
    <ul className="channel-thread-list" aria-label="Bot DMs">
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
        aria-label={`Open DM with ${thread.name}`}
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
