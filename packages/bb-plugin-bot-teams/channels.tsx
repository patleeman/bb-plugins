import {
  UsagePanel,
  workbenchLabels,
  type WorkbenchPanel,
} from "./channel-workbench";
import { Textarea } from "./components/ui/textarea";
import { sharedReads } from "./shared-read";
import {
  extendTranscript,
  TRANSCRIPT_PAGE_SIZE,
  type TranscriptPage,
} from "./transcript-window";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import * as Popover from "@radix-ui/react-popover";
import {
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  Markdown,
  experimental_Icon as Icon,
  type PluginFixedTabRegistration,
  type PluginNavPanelProps,
  type PluginThreadListProps,
  type ExperimentalSidebarNavigationProps,
} from "@get-bb/plugin-sdk/app";
import type {
  Bot,
  Room,
  RoomMessage,
  Job,
  RoomRun,
  rpcContract,
  ChannelApproval,
} from "./contract";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "./components/ui/context-menu";
import { WorkList, ErrorMessage, message } from "./bot-ui";
import {
  ChannelThreadList,
  openWorkThread,
  useExpandedChannels,
} from "./channel-threads";
import { channelQueues, channelResponseFailures, channelWork, channelWorkActivity } from "./channel-work";
import { ChannelRail, useChannelRail } from "./channel-rail-view";
import { railHasLiveWork } from "./channel-rail";
import {
  ChannelApprovalDeck,
  approvalFor,
  revealApproval,
} from "./channel-approvals";
import { ChannelSearch } from "./channel-search";
import { useAttention, ChannelAttentionBanner, MessageAttention } from "./attention-view";
import { ChannelSidebarRow } from "./channel-sidebar-row";
import { ChannelPermissionPicker } from "./channel-permissions";
import {
  channelLinkDestination,
  channelMessageReference,
} from "./channel-links";
import { ChannelAutomationsView } from "./channel-automations-view";
import { ChannelAttachments } from "./channel-attachments";
import { GroupComposer } from "./composer";
import { ChannelModePicker } from "./channel-mode-picker";
import {
  IconActionTooltip,
  Menu,
  Modal,
  InvitePicker,
  ReactionPicker,
} from "./channel-controls";
import { isForkConversation, type SendMode } from "./send-mode";
import { classifierActionAnnotation } from "./classifier-action";

const uuid = /^[a-f0-9-]{36}$/;
const channelId = (subPath: string) =>
  uuid.test(subPath.split("/")[0] ?? "") ? subPath.split("/")[0]! : null;
function useRoster(reconcile = false) {
  const rpc = useRpc<typeof rpcContract>();
  const connectionState = useRealtimeConnectionState();
  const [data, setData] = useState<{
    bots: Bot[];
    rooms: Room[];
    activeRoomIds: string[];
    attentionCounts: Record<string, number>;
    approvalCounts: Record<string, number>;
  }>({
    bots: [],
    rooms: [],
    activeRoomIds: [],
    attentionCounts: {},
    approvalCounts: {},
  });
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const load = useCallback(() => {
    const seq = ++request.current;
    sharedReads
      .read("roster", () => rpc.call("list"))
      .then(
        (d) => {
          if (seq === request.current) {
            setData(d);
            setError(null);
          }
        },
        (e) => {
          if (seq === request.current) setError(message(e));
        },
      );
  }, [rpc]);
  useEffect(() => {
    load();
    return () => {
      request.current++;
    };
  }, [load]);
  useRealtime("changed", (event) => {
    sharedReads.invalidate(
      event && typeof event === "object" && "revision" in event
        ? event.revision
        : undefined,
    );
    void load();
  });
  useEffect(() => {
    if (reconcile && connectionState === "connected") load();
  }, [reconcile, connectionState, load]);
  const hasActiveWork = data.activeRoomIds.length > 0;
  useEffect(() => {
    if (!reconcile) return;
    const refresh = () => {
      if (document.visibilityState !== "hidden") load();
    };
    const timer = window.setInterval(refresh, hasActiveWork ? 2_500 : 15_000);
    window.addEventListener("pageshow", refresh);
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("pageshow", refresh);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [reconcile, hasActiveWork, load]);
  return { ...data, error, load };
}
export function ChannelLinkNavigation() {
  const { rooms } = useRoster();
  const navigate = useBbNavigate();
  useEffect(() => {
    const knownChannelIds = new Set(rooms.map((room) => room.id));
    const restoreLegacyLink = () => {
      if (!window.location.pathname.startsWith("/plugins/bots/channels/"))
        return;
      const destination = channelLinkDestination(
        window.location.href,
        window.location.origin,
        knownChannelIds,
      );
      if (destination)
        navigate.toPluginPanel("channels", {
          subPath: destination,
          replace: true,
        });
    };
    restoreLegacyLink();
    window.addEventListener("popstate", restoreLegacyLink);
    const openLink = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      )
        return;
      const anchor =
        event.target instanceof Element
          ? event.target.closest<HTMLAnchorElement>("a[href]")
          : null;
      if (!anchor || anchor.hasAttribute("download")) return;
      const destination = channelLinkDestination(
        anchor.getAttribute("href") ?? "",
        window.location.origin,
        knownChannelIds,
      );
      if (!destination) return;
      event.preventDefault();
      event.stopPropagation();
      navigate.toPluginPanel("channels", { subPath: destination });
      const [roomId, , ...messageParts] = destination.split("/");
      const messageId = messageParts.join("/");
      if (messageId)
        window.dispatchEvent(
          new CustomEvent("bb:bots:jump", {
            detail: { roomId, messageId },
          }),
        );
    };
    document.addEventListener("click", openLink, true);
    return () => {
      document.removeEventListener("click", openLink, true);
      window.removeEventListener("popstate", restoreLegacyLink);
    };
  }, [rooms, navigate]);
  return null;
}
type ChannelData = TranscriptPage & {
  room: Room;
  jobs: Job[];
  runs: RoomRun[];
  approvals: ChannelApproval[];
};
function MessageActionButtons({
  message,
  job,
  copied,
  onReact,
  onReply,
  onCopy,
  onView,
}: {
  message: RoomMessage;
  job?: Job;
  copied: string | null;
  onReact: (emoji: string) => void;
  onReply: () => void;
  onCopy: () => void;
  onView: () => void;
}) {
  return (
    <>
      <ReactionPicker
        label={`Add reaction to ${message.speaker}'s message`}
        onReact={onReact}
      />
      <Button
        variant="ghost"
        size="icon"
        aria-label={`Reply to ${message.speaker}`}
        onClick={onReply}
      >
        <IconActionTooltip label="Reply">
          <Icon name="CornerDownRight" />
        </IconActionTooltip>
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label={`Copy ${message.speaker}'s message`}
        onClick={onCopy}
      >
        <IconActionTooltip label={copied === message.id ? "Copied" : "Copy"}>
          <Icon name={copied === message.id ? "Check" : "Copy"} />
        </IconActionTooltip>
      </Button>
      {(job?.threadId || message.sourceThreadId) && (
        <Button
          variant="ghost"
          size="icon"
          aria-label={`View ${message.speaker}'s work`}
          onClick={onView}
        >
          <IconActionTooltip label="See work">
            <Icon name="ExternalLink" />
          </IconActionTooltip>
        </Button>
      )}
    </>
  );
}

function MessageContextActions({
  onPermalink,
  onEdit,
  hasWork,
  onFork,
  selectedText,
  onReply,
  onAddSelected,
  onEmoji,
  onCopy,
  onView,
}: {
  onPermalink: () => void;
  onEdit?: () => void;
  hasWork: boolean;
  onFork?: () => void;
  selectedText: string;
  onReply: () => void;
  onAddSelected: () => void;
  onEmoji: () => void;
  onCopy: () => void;
  onView: () => void;
}) {
  return (
    <>
      <ContextMenuItem onSelect={onReply}>
        <Icon name="CornerDownRight" />
        Reply
      </ContextMenuItem>
      {onFork && (
        <ContextMenuItem onSelect={onFork}>
          <Icon name="GitFork" />
          Ask separately
        </ContextMenuItem>
      )}
      {!!selectedText && (
        <ContextMenuItem onSelect={onAddSelected}>
          <Icon name="Copy" />
          Add selected text to chat
        </ContextMenuItem>
      )}
      <ContextMenuItem onSelect={onEmoji}>
        <Icon name="Plus" />
        Emoji…
      </ContextMenuItem>
      <ContextMenuItem onSelect={onCopy}>
        <Icon name="Copy" />
        Copy
      </ContextMenuItem>
      <ContextMenuItem onSelect={onPermalink}>
        Copy message link
      </ContextMenuItem>
      {onEdit && (
        <ContextMenuItem onSelect={onEdit}>Edit message</ContextMenuItem>
      )}
      {hasWork && (
        <ContextMenuItem onSelect={onView}>
          <Icon name="ExternalLink" />
          See thread
        </ContextMenuItem>
      )}
    </>
  );
}
function useChannel(id: string | null, poll = true) {
  const rpc = useRpc<typeof rpcContract>(),
    request = useRef(0);
  const realtimeConnectionState = useRealtimeConnectionState();
  const previousRealtimeConnectionState = useRef(realtimeConnectionState);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const pageRequest = useRef<symbol | null>(null);
  const followingLatest = useRef(true);
  const currentData = useRef<ChannelData | null>(null);
  const [data, setData] = useState<ChannelData | null>(null),
    [error, setError] = useState<string | null>(null);
  const load = useCallback((): Promise<void> => {
    if (!id) {
      setData(null);
      return Promise.resolve();
    }
    if (pageRequest.current) return Promise.resolve();
    const seq = ++request.current;
    const previous =
      currentData.current?.room.id === id ? currentData.current : null;
    const options = {
      id,
      ...(previous?.messages.length && !followingLatest.current
        ? { start: previous.messages[0]!.id }
        : {}),
      limit: Math.max(TRANSCRIPT_PAGE_SIZE, previous?.messages.length ?? 0),
    };
    const promise = sharedReads
      .read(`channel:${JSON.stringify(options)}`, () =>
        rpc.call("room", options),
      )
      .then(
        (d) => {
          if (seq === request.current) {
            currentData.current = d;
            setData(d);
            setError(null);
          }
        },
        (e) => {
          if (seq === request.current) {
            setError(message(e));
            // Do not leave a deleted channel's transcript and composer on screen.
            if (message(e).includes("Channel not found")) setData(null);
          }
        },
      );
    return promise;
  }, [rpc, id]);
  useEffect(() => {
    currentData.current = null;
    followingLatest.current = true;
    pageRequest.current = null;
    setLoadingOlder(false);
    setData(null);
    load();
    return () => {
      request.current++;
    };
  }, [load]);
  useRealtime("changed", (event) => {
    sharedReads.invalidate(
      event && typeof event === "object" && "revision" in event
        ? event.revision
        : undefined,
    );
    void load();
  });
  useEffect(() => {
    const previous = previousRealtimeConnectionState.current;
    previousRealtimeConnectionState.current = realtimeConnectionState;
    if (realtimeConnectionState !== "connected" || previous === "connected")
      return;
    // Realtime signals are intentionally ephemeral. Reconcile the room after
    // a connection becomes usable, including reconnects that pass through
    // `connecting`.
    load();
  }, [load, realtimeConnectionState]);
  useEffect(() => {
    const refreshWhenVisible = () => {
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
      )
        return;
      load();
    };
    const refreshOnVisibility = () => {
      if (document.visibilityState === "visible") refreshWhenVisible();
    };
    window.addEventListener("pageshow", refreshWhenVisible);
    window.addEventListener("focus", refreshWhenVisible);
    window.addEventListener("online", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshOnVisibility);
    return () => {
      window.removeEventListener("pageshow", refreshWhenVisible);
      window.removeEventListener("focus", refreshWhenVisible);
      window.removeEventListener("online", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshOnVisibility);
    };
  }, [load]);
  // Realtime notifications are deliberately ephemeral. A suspended mobile
  // WebView can miss the idle notification that settles a bot response, so
  // keep reconciling the open channel while it is visible. Poll more often
  // during active work and back off once the channel is quiet.
  const hasActiveWork =
    !!data &&
    (data.jobs.some((job) =>
      ["queued", "dispatching", "running"].includes(job.status),
    ) ||
      data.runs.some((run) => ["queued", "running"].includes(run.status)));
  useEffect(() => {
    if (!poll || !id) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      if (disposed) return;
      const hidden =
        typeof document !== "undefined" &&
        document.visibilityState === "hidden";
      if (hidden) {
        timer = setTimeout(refresh, 30_000);
        return;
      }
      const schedule = () => {
        if (!disposed)
          timer = setTimeout(refresh, hasActiveWork ? 2_500 : 15_000);
      };
      void load().then(schedule, schedule);
    };
    timer = setTimeout(refresh, hasActiveWork ? 2_500 : 15_000);
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [hasActiveWork, id, load, poll]);
  const loadPage = useCallback(
    async (direction: "older" | "newer" | "around", target?: string) => {
      const previous = currentData.current;
      if (!id || previous?.room.id !== id || pageRequest.current) return;
      if (
        (direction === "older" && !previous.hasOlder) ||
        (direction === "newer" && !previous.hasNewer)
      )
        return;
      const token = Symbol();
      pageRequest.current = token;
      const seq = ++request.current;
      followingLatest.current = false;
      setLoadingOlder(true);
      try {
        const page = await rpc.call("transcript", {
          id,
          ...(direction === "older"
            ? { before: previous.messages[0]!.id }
            : {}),
          ...(direction === "newer"
            ? { after: previous.messages.at(-1)!.id }
            : {}),
          ...(direction === "around" && target ? { around: target } : {}),
        });
        if (seq !== request.current) return;
        const next = {
          ...previous,
          ...(direction === "older" || direction === "newer"
            ? extendTranscript(previous, page, direction)
            : page),
        };
        currentData.current = next;
        setData(next);
      } finally {
        if (pageRequest.current === token) {
          pageRequest.current = null;
          setLoadingOlder(false);
        }
      }
    },
    [id, rpc],
  );
  const loadOlder = useCallback(() => loadPage("older"), [loadPage]);
  const loadNewer = useCallback(() => loadPage("newer"), [loadPage]);
  const loadAround = useCallback(
    (target: string) => loadPage("around", target),
    [loadPage],
  );
  const loadLatest = useCallback(() => {
    // Sending or jumping to the end supersedes any older-page request.
    request.current++;
    pageRequest.current = null;
    setLoadingOlder(false);
    followingLatest.current = true;
    return load();
  }, [load]);
  return {
    data: data?.room.id === id ? data : null,
    error,
    load,
    loadOlder,
    loadNewer,
    loadAround,
    loadLatest,
    followingLatest,
    loadingOlder,
  };
}
export function ChannelRedirect({ subPath }: { subPath?: string }) {
  const navigate = useBbNavigate();
  useEffect(
    () =>
      navigate.toPluginPanel("channels", {
        subPath: subPath ?? "new",
        replace: true,
      }),
    [navigate, subPath],
  );
  return null;
}
export function ChannelsNavigation(props: ExperimentalSidebarNavigationProps) {
  const [expanded, setExpanded] = useState(false);
  const { data: attention } = useAttention("open", 1);
  const inbox = props.items.find(item => item.action.kind === "open-plugin-panel" && item.action.pluginId === "bot-teams" && item.action.panelId === "for-you");
  const channel = props.items.find(
    (item) =>
      item.action.kind === "open-plugin-panel" &&
      item.action.pluginId === "bot-teams" &&
      item.action.panelId === "channels",
  );
  const rest = props.items.filter((item) => item !== channel && item !== inbox);
  const ordered = [rest[0], inbox, channel, ...rest.slice(1)].filter((item): item is typeof props.items[number] => !!item);
  const visible = expanded ? ordered : ordered.slice(0, 10);
  return (
    <nav className="channels-navigation" aria-label="Main navigation">
      {visible.map((item) => {
        const icon =
          item === channel
            ? "MessageSquare"
            : item.icon.kind === "plugin"
              ? item.icon.icon || "Puzzle"
              : {
                  "new-thread": "MessageCirclePlus",
                  search: "Search",
                  extensions: "Puzzle",
                }[item.icon.name];
        return (
          <button
            key={item.id}
            {...item.experimental_splitProps}
            className="channel-nav-row"
            disabled={item.isDisabled}
            aria-current={
              item !== channel && props.activeItemId === item.id
                ? "page"
                : undefined
            }
            aria-keyshortcuts={item.shortcut?.ariaKeyShortcuts}
            onClick={(e) =>
              props.experimental_activate(item.id, {
                openInSplit: e.metaKey || e.ctrlKey,
              })
            }
          >
            <Icon name={icon} />
            <span>{item === channel ? "New channel" : item.label}</span>
            {item === inbox && !!attention?.openCount && <span className="attention-count" aria-label={`${attention.openCount} requests need you`}>{attention.openCount}</span>}
          </button>
        );
      })}
      {ordered.length > 10 && (
        <button
          className="channel-nav-row"
          onClick={() => setExpanded(!expanded)}
        >
          <Icon name="MoreHorizontal" />
          {expanded ? "Less" : "More"}
        </button>
      )}
    </nav>
  );
}
export function ChannelsSidebar({
  Original,
  onNavigate,
  activeThreadId,
}: PluginThreadListProps) {
  const { expanded, setExpanded } = useExpandedChannels();
  const { rooms, activeRoomIds, attentionCounts, approvalCounts, error } =
      useRoster(true),
    rpc = useRpc<typeof rpcContract>(),
    navigate = useBbNavigate();
  const [selected, setSelected] = useState<string | null>(null),
    [search, setSearch] = useState(""),
    [searching, setSearching] = useState(false),
    [archived, setArchived] = useState(false),
    [renaming, setRenaming] = useState<Room | null>(null),
    [deleting, setDeleting] = useState<Room | null>(null),
    [failure, setFailure] = useState<string | null>(null),
    [pending, setPending] = useState(false);
  const archive = async (room: Room) => {
    setPending(true);
    setFailure(null);
    try {
      await rpc.call("channelState", { id: room.id, archived: !room.archived });
    } catch (e) {
      setFailure(message(e));
    } finally {
      setPending(false);
    }
  };
  const copyChannelId = async (id: string) => {
    setFailure(null);
    try {
      await navigator.clipboard.writeText(id);
    } catch (e) {
      setFailure(`Could not copy channel ID: ${message(e)}`);
    }
  };
  useEffect(() => {
    const listener = (e: Event) =>
      setSelected((e as CustomEvent<string | null>).detail);
    window.addEventListener("bots:channel-selection", listener);
    return () => window.removeEventListener("bots:channel-selection", listener);
  }, []);
  useEffect(() => {
    if (activeThreadId) setSelected(null);
  }, [activeThreadId]);
  const open = (id: string) => {
    setSelected(id);
    navigate.toPluginPanel("channels", { subPath: id });
    onNavigate();
  };
  const query = search.trim().toLowerCase();
  const list = rooms
    .filter(
      (r) =>
        (query ? true : !!r.archived === archived) &&
        r.name.toLowerCase().includes(query),
    )
    .sort(
      (a, b) =>
        Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt - a.updatedAt,
    );
  return (
    <>
      <section className="channels-sidebar" aria-label="Channels">
        <header>
          <span className="channels-sidebar-heading">
            {archived ? "Archived channels" : "Channels"}
          </span>
          <IconActionTooltip
            label={archived ? "Show active channels" : "Show archived channels"}
          >
            <Button
              variant="ghost"
              size="icon"
              aria-label={archived ? "Show active channels" : "Show archived channels"}
              aria-pressed={archived}
              onClick={() => {
                setArchived(!archived);
                setSearch("");
              }}
            >
              <Icon name={archived ? "ListView" : "Archive"} />
            </Button>
          </IconActionTooltip>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Search channels"
            aria-expanded={searching}
            onClick={() => {
              setSearching(!searching);
              setSearch("");
            }}
          >
            <Icon name="Search" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="New channel"
            onClick={() => open("new")}
          >
            <Icon name="Plus" />
          </Button>
        </header>
        {searching && (
          <Input
            autoFocus
            aria-label="Search all channels"
            placeholder="Search all channels…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        )}
        {query && (
          <p className="channels-search-scope">
            Searching active and archived channels
          </p>
        )}
        {error && <ErrorMessage error={error} />}
        <ErrorMessage error={failure} />
        {list.map((r) => (
          <ChannelSidebarRow
            key={r.id}
            room={r}
            selected={selected === r.id}
            working={activeRoomIds.includes(r.id)}
            attentionCount={attentionCounts[r.id] ?? 0}
            approvalCount={approvalCounts[r.id] ?? 0}
            pending={pending}
            onOpen={() => open(r.id)}
            onRename={() => setRenaming(r)}
            onCopyId={() => void copyChannelId(r.id)}
            onArchive={() => void archive(r)}
            onDelete={() => setDeleting(r)}
            expanded={expanded.has(r.id)}
            onToggleExpanded={() => setExpanded(r.id, !expanded.has(r.id))}
          >
            <ChannelThreadList
              roomId={r.id}
              refreshKey={`${activeRoomIds.includes(r.id)}:${approvalCounts[r.id] ?? 0}:${r.updatedAt}`}
            />
          </ChannelSidebarRow>
        ))}
        {!list.length && (
          <p className="channel-menu-label">
            {query
              ? "No matching channels"
              : archived
                ? "No archived channels"
                : "No active channels"}
          </p>
        )}
      </section>
      {renaming && (
        <RenameChannel
          key={renaming.id}
          room={renaming}
          onClose={() => setRenaming(null)}
        />
      )}
      {deleting && (
        <DeleteChannel room={deleting} onClose={() => setDeleting(null)} />
      )}
      <div className="channels-thread-list">
        <Original />
      </div>
    </>
  );
}
function DeleteChannel({ room, onClose }: { room: Room; onClose: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal
      title="Delete channel?"
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <div className="bot-form">
        <p className="text-sm leading-5">
          Permanently delete <strong>{room.name}</strong> and its messages,
          reactions, and channel activity? This stops unfinished responses. Your
          bots and their workspaces are kept. This cannot be undone.
        </p>
        <ErrorMessage error={error} />
        <div className="channel-rename-actions">
          <Button
            autoFocus
            variant="ghost"
            disabled={pending}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={pending}
            onClick={async () => {
              setPending(true);
              setError(null);
              try {
                await rpc.call("deleteRoom", { id: room.id });
                localStorage.removeItem(`bb:bots:draft:${room.id}`);
                onClose();
              } catch (e) {
                setError(message(e));
              } finally {
                setPending(false);
              }
            }}
          >
            {pending ? "Deleting…" : "Delete channel"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
function RenameChannel({ room, onClose }: { room: Room; onClose: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [name, setName] = useState(room.name);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal
      title="Rename channel"
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <form
        className="bot-form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (pending || !name.trim()) return;
          setPending(true);
          setError(null);
          try {
            await rpc.call("updateRoom", { id: room.id, name: name.trim() });
            onClose();
          } catch (e) {
            setError(message(e));
          } finally {
            setPending(false);
          }
        }}
      >
        <Input
          autoFocus
          aria-label="Channel name"
          required
          maxLength={80}
          value={name}
          disabled={pending}
          onFocus={(e) => e.target.select()}
          onChange={(e) => setName(e.target.value)}
        />
        <ErrorMessage error={error} />
        <div className="channel-rename-actions">
          <Button
            type="button"
            variant="ghost"
            disabled={pending}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={pending || !name.trim()}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
function stateFor(bot: Bot, data: ChannelData) {
  const job = channelWork(data.jobs).find((j) => j.botId === bot.id);
  return job?.status === "running" && job.startedAt
    ? "Working"
    : job
      ? "Waiting"
      : bot.error
        ? "Needs attention"
        : "Idle";
}
// BB owns tab selection, persistence, resizing, splits, and the compact drawer.
export const channelWorkbenchTabs: PluginFixedTabRegistration[] = (
  ["activity", "automations", "usage"] as const
).map((panel) => ({
  id: panel,
  panelId: "channels",
  title: workbenchLabels[panel],
  icon: {
    activity: "Activity",
    automations: "Clock",
    usage: "ChartNoAxesCombined",
  }[panel],
  layout: "flush",
  component: function ChannelWorkbenchTab({ subPath }) {
    const id = channelId(subPath);
    return id ? (
      <ChannelWorkbench key={id} id={id} panel={panel} />
    ) : (
      <p className="p-4 text-sm text-muted-foreground">Open a channel to see its details.</p>
    );
  },
}));

function ChannelWorkbench({ id, panel }: { id: string; panel: WorkbenchPanel }) {
  const { data, error } = useChannel(id, panel === "activity");
  const { bots } = useRoster();
  return (
    <section className="channel-workbench" data-channel-id={id} aria-label={workbenchLabels[panel]}>
      <ErrorMessage error={error} />
      {!data ? (
        !error && <p role="status">Loading channel…</p>
      ) : panel === "usage" ? (
        <UsagePanel id={id} kind="channel" />
      ) : panel === "automations" ? (
        <ChannelAutomationsView
          id={id}
          bots={bots.filter((b) => data.room.memberIds.includes(b.id))}
          open
          onOpenChange={() => {}}
          presentation="panel"
        />
      ) : (
        <WorkList jobs={data.jobs} bots={bots} />
      )}
    </section>
  );
}

export function ChannelsHeader({ subPath }: PluginNavPanelProps) {
  const id = channelId(subPath),
    { data, error, load } = useChannel(id, false),
    { bots } = useRoster();
  const rpc = useRpc<typeof rpcContract>(),
    navigate = useBbNavigate();
  const [searchOpen, setSearchOpen] = useState(false);
  const rail = useChannelRail();
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false),
    [inviteOpen, setInviteOpen] = useState(false),
    [deleteOpen, setDeleteOpen] = useState(false),
    [settingsOpen, setSettingsOpen] = useState(false);
  const [failure, setFailure] = useState<string | null>(null),
    [pending, setPending] = useState(false);
  useEffect(() => {
    setMembersOpen(false);
    setInviteOpen(false);
    setOptionsOpen(false);
    setDeleteOpen(false);
    setSettingsOpen(false);
    setFailure(null);
  }, [id]);
  if (!data) return error ? <span role="alert">{error}</span> : null;
  const { room } = data,
    members = bots.filter((b) => room.memberIds.includes(b.id));
  const act = async (fn: () => Promise<unknown>) => {
    setPending(true);
    setFailure(null);
    try {
      await fn();
      load();
    } catch (e) {
      setFailure(message(e));
    } finally {
      setPending(false);
    }
  };
  const removeBot = (botId: string) =>
    void act(async () => {
      await rpc.call("member", {
        id: room.id,
        botId,
        present: false,
      });
      setMembersOpen(false);
    });
  return (
    <div className="channel-header">
      <div className="channel-heading">
        <Button
          variant="ghost"
          className="channel-title"
          aria-label={`Rename channel: ${room.name}`}
          onClick={() => setSettingsOpen(true)}
        >
          <span className="channel-hash" aria-hidden>
            #
          </span>
          <span className="channel-title-name">{room.name}</span>
        </Button>
        {room.archived && <small>Archived</small>}
      </div>
      <Menu
        label="Channel members"
        open={membersOpen}
        onOpenChange={setMembersOpen}
        trigger={
          <Button
            variant="ghost"
            className="channel-avatar-stack"
            aria-label={`Channel members: ${members.length} ${members.length === 1 ? "bot" : "bots"}`}
          >
            {members.length ? (
              members.slice(0, 4).map((b) => (
                <span
                  className="channel-avatar"
                  key={b.id}
                  title={`${b.name}: ${stateFor(b, data)}`}
                >
                  {b.avatar}
                  <i
                    className={`bot-presence-dot state-${stateFor(b, data).toLowerCase().replaceAll(" ", "-")}`}
                  />
                </span>
              ))
            ) : (
              <Icon name="UserRoundPlus" />
            )}
            {members.length > 4 && (
              <span className="channel-avatar channel-overflow">
                +{members.length - 4}
              </span>
            )}
            <span className="channel-member-summary" aria-hidden>
              <Icon name="Bot" />
              {members.length}
            </span>
          </Button>
        }
      >
        <div className="channel-member-list">
          {members.map((b) => (
            <div className="channel-member-row" key={b.id}>
              <span className="channel-avatar" aria-hidden>
                {b.avatar}
              </span>
              <span className="channel-bot-name">
                {b.name}
                <small>@{b.handle}</small>
              </span>
              <small>
                <i
                  className={`bot-presence-dot state-${stateFor(b, data).toLowerCase()}`}
                />{" "}
                {stateFor(b, data)}
              </small>
              <Button
                variant="ghost"
                size="icon"
                className="channel-member-remove text-destructive"
                aria-label={`Remove ${b.name} from channel`}
                disabled={pending || !!room.archived}
                onClick={() => removeBot(b.id)}
              >
                <Icon name="X" />
              </Button>
              <Menu
                label={`${b.name} options`}
                trigger={
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`${b.name} options`}
                  >
                    <Icon name="MoreHorizontal" />
                  </Button>
                }
              >
                <button
                  className="channel-menu-row"
                  onClick={() =>
                    navigate.toPluginPanel("bots", {
                      subPath: `${b.id}/profile`,
                    })
                  }
                >
                  Configure bot
                </button>

                <button
                  className="channel-menu-row"
                  disabled={pending || !!room.archived}
                  onClick={() => removeBot(b.id)}
                >
                  Remove from channel
                </button>
              </Menu>
            </div>
          ))}
        </div>
        {!members.length && (
          <p className="channel-menu-label">No bots in this channel yet.</p>
        )}
        <button
          className="channel-menu-row channel-menu-footer"
          disabled={!!room.archived}
          onClick={() => {
            setMembersOpen(false);
            setInviteOpen(true);
          }}
        >
          <Icon name="Plus" />
          Add bot
        </button>
        <ErrorMessage error={failure} />
      </Menu>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Search channel"
        onClick={() => setSearchOpen(true)}
      >
        <Icon name="Search" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="channel-rail-toggle"
        aria-label={rail.open ? "Hide channel details" : "Show channel details"}
        aria-pressed={rail.open}
        onClick={rail.toggle}
      >
        <Icon name="ListTree" />
        {!rail.open &&
          railHasLiveWork(data.jobs, data.runs, data.approvals, 0) && (
            <i className="channel-rail-toggle-dot" aria-hidden />
          )}
      </Button>
      <ChannelSearch
        id={room.id}
        open={searchOpen}
        onOpenChange={setSearchOpen}
      />
      <Menu
        label="Channel options"
        open={optionsOpen}
        onOpenChange={setOptionsOpen}
        trigger={
          <Button variant="ghost" size="icon" aria-label="Channel options">
            <Icon name="MoreHorizontal" />
          </Button>
        }
      >
        <button
          className="channel-menu-row"
          onClick={() => setSettingsOpen(true)}
        >
          <Icon name="Edit" />
          Rename channel
        </button>
        <button
          className="channel-menu-row"
          disabled={pending}
          onClick={() =>
            void act(() =>
              rpc.call("channelState", { id: room.id, pinned: !room.pinned }),
            )
          }
        >
          <Icon name="Pin" />
          {room.pinned ? "Unpin channel" : "Pin channel"}
        </button>

        <button
          className="channel-menu-row"
          disabled={pending}
          onClick={() =>
            void act(() =>
              rpc.call("channelState", {
                id: room.id,
                archived: !room.archived,
              }),
            )
          }
        >
          <Icon name="Archive" />
          {room.archived ? "Restore channel" : "Archive channel"}
        </button>
        <button
          className="channel-menu-row text-destructive"
          onClick={() => setDeleteOpen(true)}
        >
          <Icon name="Trash2" />
          Delete channel
        </button>
        <ErrorMessage error={failure} />
      </Menu>
      <Modal title="Add a bot" open={inviteOpen} onOpenChange={setInviteOpen}>
        <InvitePicker
          bots={bots}
          memberIds={room.memberIds}
          onSelect={(b) =>
            void act(async () => {
              await rpc.call("member", {
                id: room.id,
                botId: b.id,
                present: true,
              });
              setInviteOpen(false);
            })
          }
          onCreate={() => {
            setInviteOpen(false);
            navigate.toPluginPanel("bots", { subPath: `new/${room.id}` });
          }}
        />
        <ErrorMessage error={failure} />
      </Modal>
      {settingsOpen && (
        <RenameChannel
          key={room.id}
          room={room}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {deleteOpen && (
        <DeleteChannel room={room} onClose={() => setDeleteOpen(false)} />
      )}
    </div>
  );
}
function CreateChannel() {
  const rpc = useRpc<typeof rpcContract>(),
    navigate = useBbNavigate();
  const opening = useRef<Promise<Room> | null>(null);
  const [attempt, setAttempt] = useState(0),
    [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    // Reuse the request if React replays the effect while mounting.
    opening.current ??= rpc.call("createRoom", {
      memberIds: [],
    });
    opening.current.then(
      (room) => {
        if (active)
          navigate.toPluginPanel("channels", {
            subPath: room.id,
            replace: true,
          });
      },
      (e) => {
        if (active) setError(message(e));
      },
    );
    return () => {
      active = false;
    };
  }, [attempt, rpc, navigate]);
  return (
    <div className="bot-page">
      {error ? (
        <>
          <ErrorMessage error={error} />
          <Button
            onClick={() => {
              opening.current = null;
              setError(null);
              setAttempt((n) => n + 1);
            }}
          >
            Try again
          </Button>
        </>
      ) : (
        <p role="status">Opening channel…</p>
      )}
    </div>
  );
}
export function ChannelsPage({ subPath }: PluginNavPanelProps) {
  const id = channelId(subPath);
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent("bots:channel-selection", { detail: id }),
    );
    return () => {
      window.dispatchEvent(
        new CustomEvent("bots:channel-selection", { detail: null }),
      );
    };
  }, [id]);
  let messageId: string | undefined;
  try {
    if (subPath.split("/")[1] === "message")
      messageId = decodeURIComponent(subPath.split("/").slice(2, subPath.endsWith("/reply") ? -1 : undefined).join("/"));
  } catch {}
  return id ? (
    <ChannelChat key={id} id={id} messageId={messageId} replyToMessage={subPath.endsWith("/reply")} />
  ) : (
    <CreateChannel />
  );
}
function ChannelChat({ id, messageId, replyToMessage }: { id: string; messageId?: string; replyToMessage?: boolean }) {
  const {
      data,
      error,
      load,
      loadOlder,
      loadNewer,
      loadAround,
      loadLatest,
      followingLatest,
      loadingOlder,
    } = useChannel(id),
    { bots, rooms } = useRoster(),
    rpc = useRpc<typeof rpcContract>(),
    navigate = useBbNavigate();
  const [reply, setReply] = useState<RoomMessage | null>(null),
    [insertion, setInsertion] = useState<{
      text: string;
      nonce: number;
      sendMode?: SendMode;
      reply?: RoomMessage;
    } | null>(null),
    [failure, setFailure] = useState<string | null>(null),
    [copied, setCopied] = useState<string | null>(null);
  const [jumpTarget, setJumpTarget] = useState<string | null>(
    messageId ?? null,
  );
  const [editing, setEditing] = useState<RoomMessage | null>(null),
    [editedText, setEditedText] = useState(""),
    [editPending, setEditPending] = useState(false);
  useEffect(() => {
    if (messageId) {
      atBottom.current = false;
      setJumpTarget(messageId);
    }
  }, [messageId]);
  const [retrying, setRetrying] = useState<string | null>(null);
  const rail = useChannelRail();
  const [showAllResponseErrors, setShowAllResponseErrors] = useState(false);
  const [mobileActionsMessage, setMobileActionsMessage] = useState<
    string | null
  >(null);
  const [contextSelection, setContextSelection] = useState("");
  const transcript = useRef<HTMLDivElement>(null),
    atBottom = useRef(!messageId),
    marked = useRef(0);
  const scrollAnchor = useRef<{ id: string; top: number } | null>(null);
  const pageInFlight = useRef<symbol | null>(null);
  const loadHistory = useCallback(
    async (direction: "older" | "newer") => {
      if (pageInFlight.current || loadingOlder || !transcript.current) return;
      const token = Symbol();
      pageInFlight.current = token;
      atBottom.current = false;
      followingLatest.current = false;
      const top = transcript.current.getBoundingClientRect().top;
      const anchor = Array.from(
        transcript.current.querySelectorAll<HTMLElement>(
          "[data-channel-message]",
        ),
      ).find((el) => el.getBoundingClientRect().bottom > top);
      scrollAnchor.current = anchor
        ? {
            id: anchor.dataset.channelMessage!,
            top: anchor.getBoundingClientRect().top,
          }
        : null;
      try {
        await (direction === "older" ? loadOlder() : loadNewer());
      } catch (e) {
        if (pageInFlight.current === token) {
          scrollAnchor.current = null;
          setFailure(message(e));
        }
      } finally {
        if (pageInFlight.current === token) pageInFlight.current = null;
      }
    },
    [loadOlder, loadNewer, loadingOlder, followingLatest],
  );
  useLayoutEffect(() => {
    const anchor = scrollAnchor.current;
    if (!anchor || !transcript.current) return;
    const element = Array.from(
      transcript.current.querySelectorAll<HTMLElement>(
        "[data-channel-message]",
      ),
    ).find((el) => el.dataset.channelMessage === anchor.id);
    if (element)
      transcript.current.scrollTop +=
        element.getBoundingClientRect().top - anchor.top;
    scrollAnchor.current = null;
  }, [data?.messages]);
  const [readPosition, setReadPosition] = useState(0);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressPoint = useRef<{ x: number; y: number } | null>(null);
  const longPressTriggered = useRef(false);
  const mobileActionsOpenedByKeyboard = useRef(false);
  const cancelLongPress = useCallback(() => {
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
    longPressTimer.current = null;
    longPressPoint.current = null;
  }, []);
  const startLongPress = useCallback(
    (event: ReactPointerEvent<HTMLElement>, messageId: string) => {
      if (
        !window.matchMedia("(pointer: coarse)").matches ||
        (event.pointerType !== "touch" && event.pointerType !== "pen")
      )
        return;
      if (
        event.target instanceof Element &&
        event.target.closest(
          'button, a, input, textarea, select, summary, [role="button"], [contenteditable="true"]',
        )
      ) {
        cancelLongPress();
        return;
      }
      cancelLongPress();
      longPressTriggered.current = false;
      longPressPoint.current = { x: event.clientX, y: event.clientY };
      longPressTimer.current = setTimeout(() => {
        longPressTimer.current = null;
        longPressPoint.current = null;
        longPressTriggered.current = true;
        mobileActionsOpenedByKeyboard.current = false;
        setMobileActionsMessage(messageId);
      }, 550);
    },
    [cancelLongPress],
  );
  const moveLongPress = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const point = longPressPoint.current;
      if (
        point &&
        Math.hypot(event.clientX - point.x, event.clientY - point.y) > 10
      )
        cancelLongPress();
    },
    [cancelLongPress],
  );
  const finishLongPress = useCallback(() => {
    cancelLongPress();
    if (longPressTriggered.current)
      window.setTimeout(() => {
        longPressTriggered.current = false;
      }, 0);
  }, [cancelLongPress]);
  useEffect(() => cancelLongPress, [cancelLongPress]);
  useEffect(() => {
    const visible = () => setReadPosition((n) => n + 1);
    window.addEventListener("focus", visible);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.removeEventListener("focus", visible);
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);
  useEffect(() => {
    const onJump = (event: Event) => {
      const detail = (
        event as CustomEvent<{ roomId: string; messageId: string }>
      ).detail;
      if (detail.roomId === id) {
        atBottom.current = false;
        setJumpTarget(detail.messageId);
      }
    };
    window.addEventListener("bb:bots:jump", onJump);
    return () => window.removeEventListener("bb:bots:jump", onJump);
  }, [id]);
  useEffect(() => {
    if (!jumpTarget || !data || loadingOlder) return;
    const el = document.getElementById(`channel-message-${jumpTarget}`);
    if (el) {
      el.scrollIntoView({ block: "center" });
      el.focus();
      if (replyToMessage) {
        const target = data.messages.find(m => m.id === jumpTarget);
        if (target) setReply(target);
      }
      setJumpTarget(null);
    } else
      void loadAround(jumpTarget).catch((e) => {
        setFailure(message(e));
        setJumpTarget(null);
      });
  }, [jumpTarget, data, loadAround, loadingOlder, replyToMessage]);
  useEffect(() => {
    const el = transcript.current;
    if (el && atBottom.current && !jumpTarget) el.scrollTop = el.scrollHeight;
  }, [data?.messages.at(-1)?.id, jumpTarget]);
  useEffect(() => {
    if (
      !data ||
      data.hasNewer ||
      !atBottom.current ||
      document.visibilityState !== "visible" ||
      !document.hasFocus() ||
      marked.current >= data.room.updatedAt
    )
      return;
    marked.current = data.room.updatedAt;
    rpc
      .call("channelState", { id, lastReadAt: data.room.updatedAt })
      .catch(() => {
        marked.current = 0;
      });
  }, [id, data?.room.updatedAt, rpc, readPosition]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 1800);
    return () => clearTimeout(timer);
  }, [copied]);
  useEffect(() => {
    if (!error?.includes("Channel not found")) return;
    // Works for deletion from either menu, the CLI, or another BB window.
    // Never follow the /new route here: deleting must not create another room.
    let active = true;
    rpc
      .call("list")
      .then(({ rooms }) => {
        if (!active) return;
        const next = rooms
          .filter((r) => !r.archived && r.id !== id)
          .sort((a, b) => b.updatedAt - a.updatedAt)[0];
        localStorage.removeItem(`bb:bots:draft:${id}`);
        if (next)
          navigate.toPluginPanel("channels", {
            subPath: next.id,
            replace: true,
          });
        else navigate.toPluginPanel("bots", { replace: true });
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [error, rpc, navigate, id]);
  if (!data)
    return (
      <div className="bot-page">
        <ErrorMessage error={error} />
        {!error && <p role="status">Loading channel…</p>}
      </div>
    );
  const { room, messages, reactions, jobs } = data;
  const react = async (m: RoomMessage, emoji: string) => {
    try {
      await rpc.call("reaction", {
        id,
        messageId: m.id,
        emoji,
        active: !reactions.some(
          (r) =>
            r.messageId === m.id && r.emoji === emoji && r.actorId === "user",
        ),
      });
    } catch (e) {
      setFailure(message(e));
    }
  };
  const copy = async (m: RoomMessage) => {
    try {
      await navigator.clipboard.writeText(m.text);
      setCopied(m.id);
    } catch (e) {
      setFailure(message(e));
    }
  };
  const permalink = async (m: RoomMessage) => {
    try {
      await navigator.clipboard.writeText(
        channelMessageReference(id, room.name, m.id),
      );
      setCopied(m.id);
    } catch (e) {
      setFailure(message(e));
    }
  };
  const edit = (m: RoomMessage) => {
    setEditing(m);
    setEditedText(m.text);
    setMobileActionsMessage(null);
  };
  const jump = (messageId: string) => {
    atBottom.current = false;
    setJumpTarget(messageId);
  };
  const queues = channelQueues(jobs);
  const responseErrors = channelResponseFailures(jobs, jobs.length);
  const visibleResponseErrors = showAllResponseErrors
    ? responseErrors
    : responseErrors.slice(-5);
  return (
    <div className="bot-room" data-rail={rail.open ? "open" : undefined}>
      {(failure || error) && (
        <div className="bot-error">
          <ErrorMessage error={failure || error} />
        </div>
      )}
      <div className="bot-room-layout">
        <div className="bot-room-main">
          <ChannelAttentionBanner roomId={id} messageId={messageId} />
          <div
            ref={transcript}
            className="bot-room-messages"
            role="log"
            aria-label="Channel conversation"
            aria-live="polite"
            onScroll={() => {
              const el = transcript.current;
              if (!el) return;
              const distanceToBottom =
                el.scrollHeight - el.scrollTop - el.clientHeight;
              atBottom.current = !data.hasNewer && distanceToBottom < 100;
              followingLatest.current = atBottom.current;
              if (atBottom.current) setReadPosition((n) => n + 1);
              if (!loadingOlder && !jumpTarget) {
                if (el.scrollTop < 160 && data.hasOlder)
                  void loadHistory("older");
                else if (distanceToBottom < 160 && data.hasNewer)
                  void loadHistory("newer");
              }
            }}
          >
            {data.hasOlder && (
              <div className="flex justify-center py-2">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={loadingOlder}
                  onClick={() => void loadHistory("older")}
                  aria-label="Load earlier messages"
                >
                  {loadingOlder
                    ? "Loading earlier messages…"
                    : "Load earlier messages"}
                </Button>
              </div>
            )}
            {jumpTarget && (
              <p role="status" className="text-xs text-muted-foreground">
                Finding message…
              </p>
            )}
            {!messages.length && (
              <div className="channel-empty">
                <span className="channel-hash" aria-hidden>
                  #
                </span>
                <h2>{room.name}</h2>
                <p>Use @ to invite a bot and start the conversation.</p>
              </div>
            )}
            {messages.map((m, i) => {
              const bot = bots.find((b) => b.id === m.botId),
                previous = messages[i - 1];
              const isUser = m.botId === null && !m.sourceThreadId;
              const day = new Date(m.createdAt).toLocaleDateString(),
                newDay =
                  !previous ||
                  new Date(previous.createdAt).toLocaleDateString() !== day;
              const compact =
                !newDay &&
                previous?.botId === m.botId &&
                previous?.sourceThreadId === m.sourceThreadId &&
                previous?.speaker === m.speaker &&
                m.createdAt - previous.createdAt < 5 * 60000 &&
                !m.replyTo;
              const messageClasses = [
                "bot-room-message",
                compact ? "is-continuation" : "is-message-start",
                !previous ? "is-first-message" : "",
                newDay ? "is-day-start" : "",
                isUser ? "is-user-message" : "is-bot-message",
                m.attentionStatus === "open" ? "needs-owner-attention" : "",
              ]
                .filter(Boolean)
                .join(" ");
              const parent = m.replyTo
                  ? (messages.find((x) => x.id === m.replyTo) ??
                    data.parents.find((x) => x.id === m.replyTo))
                  : null,
                job = jobs.find((j) => j.id === m.id);
              const classifierAnnotation = classifierActionAnnotation(
                m.classifierActions,
                bots,
              );
              const grouped = [
                ...new Set(
                  reactions
                    .filter((r) => r.messageId === m.id)
                    .map((r) => r.emoji),
                ),
              ];
              if (m.system === "bot_joined" || m.system === "bot_timeout") {
                const timedOut = m.system === "bot_timeout";
                return (
                  <div key={m.id} data-channel-message={m.id}>
                    {newDay && (
                      <div className="channel-date">
                        <span>
                          {new Intl.DateTimeFormat(undefined, {
                            dateStyle: "medium",
                          }).format(m.createdAt)}
                        </span>
                      </div>
                    )}
                    <div
                      id={`channel-message-${m.id}`}
                      className={`channel-system-message${
                        timedOut ? " channel-timeout-message" : ""
                      }`}
                      role="status"
                    >
                      <Icon name={timedOut ? "Clock" : "UserRoundPlus"} />
                      <span>{m.text}</span>
                    </div>
                  </div>
                );
              }
              return (
                <div key={m.id} data-channel-message={m.id}>
                  {newDay && (
                    <div className="channel-date">
                      <span>
                        {new Intl.DateTimeFormat(undefined, {
                          dateStyle: "medium",
                        }).format(m.createdAt)}
                      </span>
                    </div>
                  )}
                  <ContextMenu
                    onOpenChange={(open) => {
                      if (open)
                        setContextSelection(
                          window.getSelection()?.toString().trim() ?? "",
                        );
                      else setContextSelection("");
                    }}
                  >
                    <Popover.Root
                      open={mobileActionsMessage === m.id}
                      onOpenChange={(open) => {
                        if (!open) setMobileActionsMessage(null);
                      }}
                    >
                      <ContextMenuTrigger asChild>
                        <Popover.Anchor asChild>
                          <article
                            id={`channel-message-${m.id}`}
                            className={messageClasses}
                            tabIndex={0}
                            aria-haspopup="dialog"
                            onPointerDown={(event) =>
                              startLongPress(event, m.id)
                            }
                            onPointerMove={moveLongPress}
                            onPointerUp={finishLongPress}
                            onPointerCancel={finishLongPress}
                            onPointerLeave={finishLongPress}
                            onClickCapture={(event) => {
                              if (!longPressTriggered.current) return;
                              event.preventDefault();
                              event.stopPropagation();
                              longPressTriggered.current = false;
                            }}
                            onKeyDown={(event) => {
                              if (
                                event.key === "ContextMenu" ||
                                (event.key === "F10" && event.shiftKey)
                              ) {
                                event.preventDefault();
                                if (
                                  window.matchMedia("(pointer: coarse)").matches
                                ) {
                                  mobileActionsOpenedByKeyboard.current = true;
                                  setMobileActionsMessage(m.id);
                                } else {
                                  const rect =
                                    event.currentTarget.getBoundingClientRect();
                                  event.currentTarget.dispatchEvent(
                                    new MouseEvent("contextmenu", {
                                      bubbles: true,
                                      clientX: rect.left + 16,
                                      clientY: rect.bottom,
                                    }),
                                  );
                                }
                              }
                            }}
                            onContextMenu={(event) => {
                              setContextSelection(
                                window.getSelection()?.toString().trim() ?? "",
                              );
                              if (
                                window.matchMedia("(pointer: coarse)").matches
                              ) {
                                event.preventDefault();
                                event.stopPropagation();
                                mobileActionsOpenedByKeyboard.current = false;
                                setMobileActionsMessage(m.id);
                              }
                            }}
                          >
                            {!isUser && (
                              <span className="bot-message-avatar" aria-hidden>
                                {compact
                                  ? ""
                                  : (bot?.avatar ?? (
                                      <Icon
                                        name={
                                          m.sourceThreadId ? "Bot" : "UserRound"
                                        }
                                      />
                                    ))}
                              </span>
                            )}
                            <div className="bot-message-body">
                              {(!compact || isUser || classifierAnnotation) && (
                                <header>
                                  <strong
                                    className={isUser ? "sr-only" : undefined}
                                  >
                                    {bot?.name ?? m.speaker}
                                  </strong>
                                  <time
                                    dateTime={new Date(
                                      m.createdAt,
                                    ).toISOString()}
                                    title={new Date(
                                      m.createdAt,
                                    ).toLocaleString()}
                                  >
                                    {new Intl.DateTimeFormat(undefined, {
                                      hour: "numeric",
                                      minute: "2-digit",
                                    }).format(m.createdAt)}
                                  </time>
                                  {classifierAnnotation && (
                                    <IconActionTooltip label={classifierAnnotation.description}>
                                      <span
                                        className="channel-classifier-action"
                                        tabIndex={0}
                                        aria-label={classifierAnnotation.description}
                                      >
                                        {classifierAnnotation.label}
                                      </span>
                                    </IconActionTooltip>
                                  )}
                                </header>
                              )}
                              <div className="bot-message-content">
                                {(m.attentionStatus || m.ownerMention) && <MessageAttention id={m.id} status={m.attentionStatus} />}
                                {parent && (
                                  <button
                                    className="bot-message-reference"
                                    onClick={() => jump(parent.id)}
                                  >
                                    <Icon name="CornerDownRight" />
                                    <span>
                                      {parent.speaker}:{" "}
                                      {parent.text.slice(0, 160) ||
                                        "Attachment"}
                                    </span>
                                  </button>
                                )}
                                {(m.sendMode === "fork" ||
                                  isForkConversation(
                                    m.conversationKey ??
                                      job?.conversationKey ??
                                      "",
                                  )) && (
                                  <span className="channel-fork-label">
                                    Fork
                                  </span>
                                )}
                                {m.editedAt && (
                                  <small className="text-muted-foreground">
                                    Edited
                                  </small>
                                )}
                                {m.text && (
                                  <Markdown
                                    className="bot-message-markdown text-sm leading-5"
                                    content={m.text}
                                  />
                                )}
                                {!!m.attachments.length && (
                                  <ChannelAttachments
                                    attachments={m.attachments}
                                    onImageLoad={() => {
                                      const el = transcript.current;
                                      if (el && atBottom.current && !jumpTarget)
                                        el.scrollTop = el.scrollHeight;
                                    }}
                                  />
                                )}
                              </div>
                              {!!grouped.length && (
                                <div className="channel-reactions">
                                  {grouped.map((emoji) => {
                                    const people = reactions.filter(
                                        (r) =>
                                          r.messageId === m.id &&
                                          r.emoji === emoji,
                                      ),
                                      mine = people.some(
                                        (r) => r.actorId === "user",
                                      );
                                    return (
                                      <button
                                        key={emoji}
                                        aria-label={`${emoji}: ${people.map((r) => r.actorName).join(", ")}`}
                                        title={people
                                          .map((r) => r.actorName)
                                          .join(", ")}
                                        aria-pressed={mine}
                                        onClick={() => void react(m, emoji)}
                                      >
                                        {emoji} <span>{people.length}</span>
                                      </button>
                                    );
                                  })}
                                  <ReactionPicker
                                    label={`Add reaction to ${m.speaker}'s message`}
                                    onReact={(emoji) => void react(m, emoji)}
                                  />
                                </div>
                              )}
                              <div
                                className="bot-message-actions rounded-md border border-border bg-popover text-popover-foreground shadow-md"
                                aria-label={`Actions for ${m.speaker}'s message`}
                              >
                                <MessageActionButtons
                                  message={m}
                                  job={job}
                                  copied={copied}
                                  onReact={(emoji) => void react(m, emoji)}
                                  onReply={() => {
                                    setReply(m);
                                    if (bot)
                                      setInsertion({
                                        text: `@${bot.handle} `,
                                        nonce: Date.now(),
                                      });
                                  }}
                                  onCopy={() => void copy(m)}
                                  onView={() =>
                                    openWorkThread(navigate, (job?.threadId ?? m.sourceThreadId)!, id)
                                  }
                                />
                              </div>
                            </div>
                          </article>
                        </Popover.Anchor>
                      </ContextMenuTrigger>
                      {mobileActionsMessage === m.id && (
                        <Popover.Portal>
                          <Popover.Content
                            side="top"
                            align="end"
                            sideOffset={6}
                            collisionPadding={8}
                            className="channel-popover mobile-message-menu"
                            aria-label={`Actions for ${m.speaker}'s message`}
                            data-mobile-message-actions
                            onOpenAutoFocus={(event) => {
                              if (!mobileActionsOpenedByKeyboard.current)
                                event.preventDefault();
                            }}
                            onCloseAutoFocus={(event) => {
                              event.preventDefault();
                              if (mobileActionsOpenedByKeyboard.current)
                                document
                                  .getElementById(`channel-message-${m.id}`)
                                  ?.focus();
                              mobileActionsOpenedByKeyboard.current = false;
                            }}
                          >
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                setMobileActionsMessage(null);
                                void permalink(m);
                              }}
                            >
                              Copy link
                            </Button>
                            {!m.botId &&
                              !m.sourceThreadId &&
                              !m.automationId &&
                              !room.archived && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => edit(m)}
                                >
                                  Edit
                                </Button>
                              )}
                            <div className="mobile-message-menu-actions">
                              <MessageActionButtons
                                message={m}
                                job={job}
                                copied={copied}
                                onReact={(emoji) => {
                                  setMobileActionsMessage(null);
                                  void react(m, emoji);
                                }}
                                onReply={() => {
                                  setMobileActionsMessage(null);
                                  setReply(m);
                                  if (bot)
                                    setInsertion({
                                      text: `@${bot.handle} `,
                                      nonce: Date.now(),
                                    });
                                }}
                                onCopy={() => {
                                  setMobileActionsMessage(null);
                                  void copy(m);
                                }}
                                onView={() => {
                                  setMobileActionsMessage(null);
                                  openWorkThread(navigate, (job?.threadId ?? m.sourceThreadId)!, id);
                                }}
                              />
                            </div>
                          </Popover.Content>
                        </Popover.Portal>
                      )}
                    </Popover.Root>
                    <ContextMenuContent
                      aria-label={`Actions for ${m.speaker}'s message`}
                      onCloseAutoFocus={(event) => {
                        event.preventDefault();
                        document
                          .getElementById(`channel-message-${m.id}`)
                          ?.focus();
                      }}
                    >
                      <MessageContextActions
                        onPermalink={() => void permalink(m)}
                        onEdit={
                          !m.botId &&
                          !m.sourceThreadId &&
                          !m.automationId &&
                          !room.archived
                            ? () => edit(m)
                            : undefined
                        }
                        hasWork={!!(job?.threadId || m.sourceThreadId)}
                        onFork={
                          bot
                            ? () =>
                                setInsertion({
                                  text: `@${bot.handle} `,
                                  nonce: Date.now(),
                                  sendMode: "fork",
                                  reply: m,
                                })
                            : undefined
                        }
                        selectedText={contextSelection}
                        onReply={() => {
                          setReply(m);
                          if (bot)
                            setInsertion({
                              text: `@${bot.handle} `,
                              nonce: Date.now(),
                            });
                        }}
                        onAddSelected={() => {
                          if (contextSelection)
                            setInsertion({
                              text: contextSelection,
                              nonce: Date.now(),
                            });
                        }}
                        onEmoji={() => {
                          mobileActionsOpenedByKeyboard.current = false;
                          setMobileActionsMessage(m.id);
                        }}
                        onCopy={() => void copy(m)}
                        onView={() =>
                          openWorkThread(navigate, (job?.threadId ?? m.sourceThreadId)!, id)
                        }
                      />
                    </ContextMenuContent>
                  </ContextMenu>
                </div>
              );
            })}
            {data.hasNewer && (
              <div className="flex justify-center py-2">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={loadingOlder}
                  aria-label="Load newer messages"
                  onClick={() => void loadHistory("newer")}
                >
                  {loadingOlder ? "Loading messages…" : "Load newer messages"}
                </Button>
              </div>
            )}
            {visibleResponseErrors.map((j) => {
              const bot = bots.find((b) => b.id === j.botId);
              const canRetry =
                !room.archived &&
                room.memberIds.includes(j.botId) &&
                !!bot &&
                !bot.retired;
              return (
                <div key={j.id} className="channel-response-error" role="status">
                  <span className="channel-response-error-icon" aria-hidden>
                    {bot?.avatar ?? <Icon name="Bot" />}
                  </span>
                  <div className="channel-response-error-body">
                    <strong>
                      {bot?.name ?? "Bot"}{" "}
                      {j.timedOut ? "timed out" : "couldn’t finish"}
                    </strong>
                    {j.error && <p>{j.error}</p>}
                    {!canRetry && (
                      <p>
                        {room.archived
                          ? "Restore this channel to retry."
                          : "Restore and invite this bot to retry."}
                      </p>
                    )}
                    <div className="channel-response-error-actions">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={!!retrying || !!j.cancellationPending || !canRetry}
                        onClick={async () => {
                          setRetrying(j.id);
                          try {
                            await rpc.call("retryJob", { id: j.id });
                            load();
                          } catch (e) {
                            setFailure(message(e));
                          } finally {
                            setRetrying(null);
                          }
                        }}
                      >
                        {j.cancellationPending
                          ? "Stopping…"
                          : j.timedOut
                            ? "Resume response"
                            : "Retry response"}
                      </Button>
                      {j.threadId && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openWorkThread(navigate, j.threadId!, id)}
                        >
                          View work
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
            {responseErrors.length > 5 && (
              <div className="channel-response-overflow">
                <Button
                  variant="ghost"
                  size="sm"
                  aria-expanded={showAllResponseErrors}
                  onClick={() => setShowAllResponseErrors((shown) => !shown)}
                >
                  {showAllResponseErrors
                    ? "Show recent failures"
                    : `Show ${responseErrors.length - 5} earlier failed ${responseErrors.length - 5 === 1 ? "response" : "responses"}`}
                </Button>
              </div>
            )}
            {data.runs.some(
              (r) => r.routing === "pending" && r.status === "running",
            ) && (
              <p className="channel-routing-status" role="status">
                Choosing recipients and delivery…
              </p>
            )}
            {data.runs
              .filter((r) => r.routing === "error")
              .slice(-3)
              .map((r) => (
                <div
                  key={r.id}
                  className="channel-response-error"
                  role="status"
                >
                  <span className="channel-response-error-icon" aria-hidden>
                    <Icon name="TriangleAlert" />
                  </span>
                  <div className="channel-response-error-body">
                    <strong>Couldn’t choose recipients</strong>
                    {r.routingError && <p>{r.routingError}</p>}
                    <div className="channel-response-error-actions">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!!room.archived || !!retrying}
                        onClick={async () => {
                          setRetrying(r.id);
                          try {
                            await rpc.call("retryRouting", { id, requestId: r.id });
                            load();
                          } catch (e) {
                            setFailure(message(e));
                          } finally {
                            setRetrying(null);
                          }
                        }}
                      >
                        Retry routing
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            <ChannelApprovalDeck
              roomId={id}
              approvals={data.approvals}
              bots={bots}
              archived={!!room.archived}
              onFailure={setFailure}
              onResolved={load}
            />
          </div>
          {data.hasNewer && (
            <div className="channel-latest">
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  scrollAnchor.current = null;
                  pageInFlight.current = null;
                  setJumpTarget(null);
                  atBottom.current = true;
                  try {
                    await loadLatest();
                  } catch (e) {
                    setFailure(message(e));
                  }
                }}
              >
                Jump to latest
              </Button>
            </div>
          )}
          <GroupComposer
            key={id}
            shelf={
              queues.length > 0 ? (
            <section className="channel-work-shelf" aria-label="Bot work and queue">
              {queues.map(({ head: current, queued }) => {
                const b = bots.find((b) => b.id === current.botId);
                if (!b) return null;
                const approval = approvalFor(data.approvals, current);
                const activity = approval
                  ? "Needs approval"
                  : channelWorkActivity(current);
                const stopLabel = `${current.cancellationPending ? "Stopping" : "Stop"} ${b.name}'s response`;
                return (
                  <div className="channel-work-group" key={current.id}>
                    <div
                      className="channel-agent-stub"
                      data-waiting={approval ? "approval" : undefined}
                      role="status"
                      aria-label={`${b.name}: ${activity}`}
                    >
                      <span className="channel-agent-avatar" aria-hidden>
                        {b.avatar}
                      </span>
                      <strong className="channel-agent-name" title={b.name}>
                        {b.name}
                      </strong>
                      {isForkConversation(current.conversationKey) && (
                        <span className="channel-fork-label">Fork</span>
                      )}
                      <span className="channel-activity-snippet" title={activity}>
                        {activity}
                      </span>
                      {queued.length > 0 && (
                        <span className="channel-queue-count">
                          {queued.length} queued
                        </span>
                      )}
                      {approval && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="channel-review-button"
                          onClick={() => revealApproval(approval.id)}
                        >
                          Review
                        </Button>
                      )}
                      <IconActionTooltip label={stopLabel}>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="channel-stop-button"
                          aria-label={stopLabel}
                          disabled={!!current.cancellationPending}
                          onClick={() => {
                            if (current.cancellationPending) return;
                            void rpc
                              .call("cancelJob", { id: current.id })
                              .catch((e) => setFailure(message(e)));
                          }}
                        >
                          <Icon name="Square" />
                        </Button>
                      </IconActionTooltip>
                    </div>
                    {queued.length > 0 && (
                      <ol className="channel-queue" aria-label={`Queued for ${b.name}`}>
                        {queued.map((q) => {
                          const text =
                            messages.find((m) => m.id === q.triggerMessageId)?.text ||
                            q.taskTitle ||
                            "Queued request";
                          return (
                            <li className="channel-queue-item" key={q.id}>
                              <span className="channel-queue-text" title={text}>
                                {text}
                              </span>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="channel-queue-remove"
                                aria-label={`Remove queued request for ${b.name}`}
                                onClick={() =>
                                  void rpc
                                    .call("cancelJob", { id: q.id })
                                    .catch((e) => setFailure(message(e)))
                                }
                              >
                                <Icon name="X" />
                              </Button>
                            </li>
                          );
                        })}
                      </ol>
                    )}
                  </div>
                );
              })}
            </section>
              ) : null
            }
            autoFocus={!messages.length}
            roomId={id}
            roomName={room.name}
            paused={!!room.archived}
            bots={bots}
            memberIds={room.memberIds}
            rooms={rooms}
            footer={
              <>
                <ChannelModePicker room={room} onChanged={load} />
                <ChannelPermissionPicker
                  room={room}
                  bots={bots}
                  onChanged={load}
                />
              </>
            }
            onCreateBot={() =>
              navigate.toPluginPanel("bots", { subPath: `new/${room.id}` })
            }
            reply={reply}
            onClearReply={() => setReply(null)}
            insertion={insertion}
            onInserted={() => setInsertion(null)}
            onSent={() => {
              scrollAnchor.current = null;
              pageInFlight.current = null;
              setJumpTarget(null);
              atBottom.current = true;
              void loadLatest();
            }}
          />
        </div>
        {rail.open && (
          <ChannelRail
            room={room}
            bots={bots}
            jobs={jobs}
            runs={data.runs}
            approvals={data.approvals}
            messageIds={messages.map((m) => m.id)}
            onChanged={load}
            onClose={rail.close}
          />
        )}
      </div>
      <Modal
        title="Edit message"
        open={!!editing}
        onOpenChange={(open) => {
          if (!open && !editPending) setEditing(null);
        }}
      >
        <p className="text-sm text-muted-foreground">
          Edits update the transcript. Existing tasks keep the original request
          and are not rerun.
        </p>
        <Textarea
          aria-label="Message text"
          value={editedText}
          maxLength={16000}
          disabled={editPending}
          onChange={(e) => setEditedText(e.target.value)}
        />
        <div className="mt-3 flex justify-end gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={editPending}
            onClick={() => setEditing(null)}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={editPending || !editedText.trim()}
            onClick={async () => {
              if (!editing) return;
              setEditPending(true);
              try {
                await rpc.call("editMessage", {
                  id,
                  messageId: editing.id,
                  text: editedText,
                  expectedText: editing.text,
                });
                setEditing(null);
                await load();
              } catch (e) {
                setFailure(message(e));
              } finally {
                setEditPending(false);
              }
            }}
          >
            Save message
          </Button>
        </div>
        <ErrorMessage error={failure} />
      </Modal>
    </div>
  );
}
