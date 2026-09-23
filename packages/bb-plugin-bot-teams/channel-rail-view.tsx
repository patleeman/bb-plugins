import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  experimental_Icon as Icon,
  experimental_useSidebarThreadActions as useSidebarThreadActions,
  experimental_useSidebarThreadSplit as useSidebarThreadSplit,
  useBbContext,
  useBbNavigate,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type {
  Attachment,
  Bot,
  ChannelApproval,
  Job,
  Room,
  RoomRun,
  rpcContract,
} from "./contract";
import type { ChannelAutomation } from "./automation-contract";
import { Button } from "./components/ui/button";
import { message } from "./bot-ui";
import { attachmentUrl } from "./channel-attachments";
import { revealApproval } from "./channel-approvals";
import { ChannelAutomationsView } from "./channel-automations-view";
import { openWorkThread } from "./channel-threads";
import { attentionReasons, useAttention } from "./attention-view";
import {
  formatCountdown,
  formatDuration,
  nextAutomation,
  railApprovals,
  railLive,
  railMembers,
  railRoutingCount,
  type RailLiveEntry,
  type RailMember,
} from "./channel-rail";

const railOpenKey = "bb:bots:rail-open";
const collapsedKey = "bb:bots:rail-collapsed";

type SectionId =
  | "live"
  | "attention"
  | "threads"
  | "members"
  | "automation"
  | "output"
  | "usage";

const sectionTitles: Record<SectionId, string> = {
  live: "Live now",
  attention: "Needs you",
  threads: "Threads",
  members: "Members",
  automation: "Next automation",
  output: "Output",
  usage: "Usage",
};

function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function writeStored(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

const railEvent = "bb:bots:rail";

/**
 * Whether the rail is showing. Persists per device, and stays in sync across
 * the header and the transcript, which BB mounts as separate surfaces.
 */
export function useChannelRail() {
  const [open, setOpen] = useState(() => readStored(railOpenKey, true));
  useEffect(() => {
    const sync = (event: Event) =>
      setOpen((event as CustomEvent<{ open: boolean }>).detail.open);
    window.addEventListener(railEvent, sync);
    return () => window.removeEventListener(railEvent, sync);
  }, []);
  const set = useCallback((next: boolean) => {
    writeStored(railOpenKey, next);
    window.dispatchEvent(
      new CustomEvent(railEvent, { detail: { open: next } }),
    );
  }, []);
  const toggle = useCallback(() => set(!readStored(railOpenKey, true)), [set]);
  return { open, toggle, close: useCallback(() => set(false), [set]) };
}

function useCollapsed() {
  const [collapsed, setCollapsed] = useState<string[]>(() =>
    readStored<string[]>(collapsedKey, []),
  );
  const toggle = (id: SectionId) =>
    setCollapsed((old) => {
      const next = old.includes(id)
        ? old.filter((entry) => entry !== id)
        : [...old, id];
      writeStored(collapsedKey, next);
      return next;
    });
  return { collapsed, toggle };
}

/** A tick for elapsed and countdown labels, paused when nothing is running. */
function useClock(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function RailSection({
  id,
  count,
  collapsed,
  onToggle,
  action,
  children,
}: {
  id: SectionId;
  count?: number;
  collapsed: boolean;
  onToggle: (id: SectionId) => void;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="channel-rail-section" data-section={id}>
      <div className="channel-rail-section-header">
        <button
          type="button"
          className="channel-rail-section-toggle"
          aria-expanded={!collapsed}
          onClick={() => onToggle(id)}
        >
          <span className="channel-rail-chevron" aria-hidden>
            <Icon name={collapsed ? "ChevronRight" : "ChevronDown"} />
          </span>
          <span className="channel-rail-section-title">{sectionTitles[id]}</span>
          {count !== undefined && count > 0 && (
            <span className="channel-rail-count">{count}</span>
          )}
        </button>
        {!collapsed && action}
      </div>
      {!collapsed && (
        <div className="channel-rail-section-body">{children}</div>
      )}
    </section>
  );
}

function LiveRow({
  entry,
  bot,
  roomId,
  now,
  onStop,
  stopping,
}: {
  entry: RailLiveEntry;
  bot: Bot | undefined;
  roomId: string;
  now: number;
  onStop: (jobId: string) => void;
  stopping: boolean;
}) {
  const navigate = useBbNavigate();
  const elapsed = entry.startedAt ? now - entry.startedAt : null;
  return (
    <div className="channel-rail-live">
      <button
        type="button"
        className="channel-rail-row channel-rail-live-open"
        disabled={!entry.threadId}
        title={entry.threadId ? "Open this bot's thread" : undefined}
        onClick={() =>
          entry.threadId && openWorkThread(navigate, entry.threadId, roomId)
        }
      >
        <span className="channel-rail-avatar" aria-hidden>
          {bot?.avatar ?? <Icon name="Bot" />}
        </span>
        <span className="channel-rail-live-text">
          <span className="channel-rail-name">
            {bot?.name ?? "Bot"}
            {elapsed !== null && (
              <span className="channel-rail-elapsed">
                {formatDuration(elapsed)}
              </span>
            )}
          </span>
          <span className="channel-rail-activity">{entry.activity}</span>
          {entry.queuedBehind > 0 && (
            <span className="channel-rail-queued">
              {entry.queuedBehind} waiting behind this
            </span>
          )}
        </span>
        {entry.running && (
          <span className="channel-working" role="img" aria-label="Working">
            <Icon name="Loading" />
          </span>
        )}
      </button>
      <Button
        variant="ghost"
        size="sm"
        className="channel-rail-stop"
        disabled={!entry.stoppable || stopping}
        aria-label={`Stop ${bot?.name ?? "bot"}`}
        onClick={() => onStop(entry.jobId)}
      >
        <Icon name="Square" />
      </Button>
    </div>
  );
}

function MemberRow({ member, roomId }: { member: RailMember; roomId: string }) {
  const navigate = useBbNavigate();
  const stateLabels = {
    working: "Working",
    queued: "Queued",
    attention: "Needs attention",
    paused: "Paused",
    idle: "Idle",
  } as const;
  return (
    <button
      type="button"
      className="channel-rail-row"
      title={member.detail ?? stateLabels[member.state]}
      onClick={() =>
        member.threadId
          ? openWorkThread(navigate, member.threadId, roomId)
          : navigate.toPluginPanel("bots", {
              subPath: `${member.bot.id}/profile`,
            })
      }
    >
      <span className="channel-rail-avatar" aria-hidden>
        {member.bot.avatar || <Icon name="Bot" />}
      </span>
      <span className="channel-rail-name">{member.bot.name}</span>
      <span className="channel-rail-state" data-state={member.state}>
        {stateLabels[member.state]}
      </span>
    </button>
  );
}

type ChannelThread = {
  threadId: string;
  botId: string;
  name: string;
  avatar: string;
  active: boolean;
  needsApproval: boolean;
};

function ThreadRow({ thread }: { thread: ChannelThread }) {
  const { threadId } = useBbContext();
  const navigate = useBbNavigate();
  const actions = useSidebarThreadActions();
  const split = useSidebarThreadSplit(thread.threadId);
  return (
    <button
      type="button"
      className="channel-rail-row"
      aria-current={threadId === thread.threadId ? "page" : undefined}
      title={
        split.isAvailable ? "Drag or ⌘-click to open in a split" : undefined
      }
      {...split.splitProps}
      onClick={(event) => {
        if (split.isAvailable && (event.metaKey || event.ctrlKey))
          actions.open(thread.threadId, { split: true });
        else navigate.toThread(thread.threadId);
      }}
    >
      <span className="channel-rail-avatar" aria-hidden>
        {thread.avatar || <Icon name="Bot" />}
      </span>
      <span className="channel-rail-name">{thread.name}</span>
      {thread.needsApproval && (
        <span
          className="channel-needs-attention"
          role="img"
          aria-label="Waiting for your approval"
        >
          <Icon name="BellDot" />
        </span>
      )}
      {thread.active && (
        <span className="channel-working" role="img" aria-label="Working">
          <Icon name="Loading" />
        </span>
      )}
    </button>
  );
}

export function ChannelRail({
  room,
  bots,
  jobs,
  runs,
  approvals,
  messageIds,
  onChanged,
  onClose,
}: {
  room: Room;
  bots: Bot[];
  jobs: Job[];
  runs: RoomRun[];
  approvals: ChannelApproval[];
  messageIds: string[];
  onChanged: () => void;
  onClose: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const { collapsed, toggle } = useCollapsed();
  const [stopping, setStopping] = useState<string | null>(null);
  const [automationsOpen, setAutomationsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [threads, setThreads] = useState<ChannelThread[]>([]);
  const [automations, setAutomations] = useState<ChannelAutomation[]>([]);
  const [files, setFiles] = useState<Attachment[]>([]);
  const [usage, setUsage] = useState<{
    turns: number;
    errors: number;
    limits: { turnsPerDay: number };
  } | null>(null);
  const attention = useAttention("open", 5, 0, room.id);

  const live = railLive(jobs);
  const routing = railRoutingCount(runs);
  const members = railMembers(bots, room.memberIds, jobs);
  const pendingApprovals = railApprovals(approvals);
  const now = useClock(live.length > 0 || routing > 0);
  const upcoming = nextAutomation(automations, now);
  const signature = jobs.map((job) => `${job.id}:${job.status}`).join(",");

  useEffect(() => {
    let current = true;
    void rpc.call("channelThreads", { id: room.id }).then(
      (next) => current && setThreads(next),
      () => current && setThreads([]),
    );
    void rpc
      .call("automationList", { channelId: room.id, limit: 50, offset: 0 })
      .then(
        (next) => current && setAutomations(next.automations),
        () => current && setAutomations([]),
      );
    void rpc.call("channelFiles", { id: room.id }).then(
      (next) => current && setFiles(next.files),
      () => current && setFiles([]),
    );
    void rpc.call("usage", { id: room.id, kind: "channel" }).then(
      (next) => current && setUsage(next),
      () => current && setUsage(null),
    );
    return () => {
      current = false;
    };
  }, [rpc, room.id, signature, messageIds.length]);

  const stop = async (jobId: string) => {
    setStopping(jobId);
    setError(null);
    try {
      await rpc.call("cancelJob", { id: jobId });
      onChanged();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setStopping(null);
    }
  };

  const isCollapsed = (id: SectionId) => collapsed.includes(id);
  const attentionCount =
    (attention.data?.items.length ?? 0) + pendingApprovals.length;

  return (
    <aside className="channel-rail" aria-label={`#${room.name} details`}>
      <div className="channel-rail-header">
        <h2 className="channel-rail-heading">Channel</h2>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Hide channel details"
          onClick={onClose}
        >
          <Icon name="X" />
        </Button>
      </div>
      <div className="channel-rail-scroll">
        {error && (
          <p role="alert" className="channel-rail-error">
            {error}
          </p>
        )}
        {(live.length > 0 || routing > 0) && (
          <RailSection
            id="live"
            count={live.length + routing}
            collapsed={isCollapsed("live")}
            onToggle={toggle}
          >
            {routing > 0 && (
              <p className="channel-rail-routing" role="status">
                <span className="channel-working" aria-hidden>
                  <Icon name="Loading" />
                </span>
                Choosing who answers…
              </p>
            )}
            {live.map((entry) => (
              <LiveRow
                key={entry.jobId}
                entry={entry}
                bot={bots.find((candidate) => candidate.id === entry.botId)}
                roomId={room.id}
                now={now}
                onStop={stop}
                stopping={stopping === entry.jobId}
              />
            ))}
          </RailSection>
        )}
        {attentionCount > 0 && (
          <RailSection
            id="attention"
            count={attentionCount}
            collapsed={isCollapsed("attention")}
            onToggle={toggle}
          >
            {pendingApprovals.map((approval) => (
              <button
                key={approval.id}
                type="button"
                className="channel-rail-row channel-rail-attention"
                onClick={() => revealApproval(approval.id)}
              >
                <span className="channel-rail-avatar" aria-hidden>
                  <Icon name="BellDot" />
                </span>
                <span className="channel-rail-live-text">
                  <span className="channel-rail-name">
                    {bots.find((bot) => bot.id === approval.botId)?.name ??
                      "Bot"}
                  </span>
                  <span className="channel-rail-activity">
                    {approval.title}
                  </span>
                </span>
              </button>
            ))}
            {attention.data?.items.map((item) => (
              <button
                key={item.id}
                type="button"
                className="channel-rail-row channel-rail-attention"
                onClick={() =>
                  navigate.toPluginPanel("channels", {
                    subPath: `${room.id}/message/${encodeURIComponent(item.message.id)}`,
                  })
                }
              >
                <span className="channel-rail-avatar" aria-hidden>
                  <Icon name="TriangleAlert" />
                </span>
                <span className="channel-rail-live-text">
                  <span className="channel-rail-name">
                    {attentionReasons[item.reason]}
                  </span>
                  <span className="channel-rail-activity">
                    {item.message.text}
                  </span>
                </span>
              </button>
            ))}
          </RailSection>
        )}
        {threads.length > 0 && (
          <RailSection
            id="threads"
            count={threads.length}
            collapsed={isCollapsed("threads")}
            onToggle={toggle}
          >
            {threads.map((thread) => (
              <ThreadRow key={thread.threadId} thread={thread} />
            ))}
          </RailSection>
        )}
        <RailSection
          id="members"
          count={members.length}
          collapsed={isCollapsed("members")}
          onToggle={toggle}
          action={
            <Button
              variant="ghost"
              size="sm"
              aria-label="Add a bot to this channel"
              onClick={() =>
                navigate.toPluginPanel("bots", { subPath: `new/${room.id}` })
              }
            >
              <Icon name="Plus" />
            </Button>
          }
        >
          {members.length ? (
            members.map((member) => (
              <MemberRow key={member.bot.id} member={member} roomId={room.id} />
            ))
          ) : (
            <p className="channel-rail-empty">No bots in this channel yet.</p>
          )}
        </RailSection>
        {upcoming && (
          <RailSection
            id="automation"
            collapsed={isCollapsed("automation")}
            onToggle={toggle}
          >
            <div className="channel-rail-automation">
              <button
                type="button"
                className="channel-rail-row"
                title="Open automations"
                onClick={() => setAutomationsOpen(true)}
              >
                <span className="channel-rail-live-text">
                  <span className="channel-rail-name">{upcoming.name}</span>
                  <span className="channel-rail-activity">
                    {formatCountdown(upcoming.nextRunAt! - now)}
                  </span>
                </span>
              </button>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Pause ${upcoming.name}`}
                onClick={async () => {
                  setError(null);
                  try {
                    await rpc.call("automationAction", {
                      channelId: room.id,
                      automationId: upcoming.id,
                      action: "pause",
                    });
                    setAutomations((old) =>
                      old.map((entry) =>
                        entry.id === upcoming.id
                          ? { ...entry, enabled: false }
                          : entry,
                      ),
                    );
                  } catch (cause) {
                    setError(message(cause));
                  }
                }}
              >
                <Icon name="Square" />
              </Button>
            </div>
          </RailSection>
        )}
        {files.length > 0 && (
          <RailSection
            id="output"
            count={files.length}
            collapsed={isCollapsed("output")}
            onToggle={toggle}
          >
            {files.slice(0, 8).map((file) => (
              <a
                key={file.id}
                className="channel-rail-row channel-rail-file"
                href={attachmentUrl(file)}
                download={file.name}
                title={file.name}
              >
                <span className="channel-rail-avatar" aria-hidden>
                  <Icon name="Paperclip" />
                </span>
                <span className="channel-rail-name">{file.name}</span>
              </a>
            ))}
          </RailSection>
        )}
        {usage && (
          <RailSection
            id="usage"
            collapsed={isCollapsed("usage")}
            onToggle={toggle}
          >
            <div className="channel-rail-usage">
              <p className="channel-rail-activity">
                {usage.turns} / {usage.limits.turnsPerDay} turns today
                {usage.errors > 0 && ` · ${usage.errors} failed`}
              </p>
              <div
                className="channel-rail-meter"
                role="img"
                aria-label={`${usage.turns} of ${usage.limits.turnsPerDay} turns used today`}
              >
                <span
                  style={{
                    width: `${Math.min(100, Math.round((usage.turns / Math.max(1, usage.limits.turnsPerDay)) * 100))}%`,
                  }}
                />
              </div>
            </div>
          </RailSection>
        )}
      </div>
      <ChannelAutomationsView
        id={room.id}
        bots={bots.filter((bot) => room.memberIds.includes(bot.id))}
        open={automationsOpen}
        onOpenChange={setAutomationsOpen}
      />
    </aside>
  );
}
