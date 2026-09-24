import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  experimental_Icon as Icon,
  experimental_useAppPanel as useAppPanel,
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
import type { PluginFixedTabRegistration } from "@get-bb/plugin-sdk/app";
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
  | "members"
  | "automation"
  | "output"
  | "usage";

const sectionTitles: Record<SectionId, string> = {
  live: "Live now",
  attention: "Needs you",
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

/**
 * A channel nowhere near its ceiling has nothing to report. Speak up only once
 * the day's usage is worth a glance, or something actually failed.
 */
const usageWorthShowing = (usage: {
  turns: number;
  errors: number;
  limits: { turnsPerDay: number };
}) =>
  usage.errors > 0 ||
  usage.turns >= Math.max(1, usage.limits.turnsPerDay) * 0.25;

/** Mirrors the container query that switches the card to a full-width sheet. */
const overlayBelow = 560;

const previewLimit = 4;

/** Long lists stay short; the rest is one muted click away. */
function RailList<T>({
  items,
  render,
  keyOf,
}: {
  items: T[];
  render: (item: T) => ReactNode;
  keyOf: (item: T) => string;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, previewLimit);
  return (
    <>
      {shown.map((item) => (
        <Fragment key={keyOf(item)}>{render(item)}</Fragment>
      ))}
      {items.length > previewLimit && (
        <button
          type="button"
          className="channel-rail-more"
          onClick={() => setAll((shown) => !shown)}
        >
          {all ? "Show less" : `View all ${items.length}`}
        </button>
      )}
    </>
  );
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
          {/* A count only earns its place when the rows it counts are hidden. */}
          {collapsed && count !== undefined && count > 0 && (
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
        title={entry.threadId ? "Open this bot's DM" : undefined}
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

/**
 * A member and their DM are the same bot, so this is one row: it carries the
 * bot's state and opens its DM when there is one.
 */
function MemberRow({
  member,
  thread,
  roomId,
}: {
  member: RailMember;
  thread: ChannelThread | undefined;
  roomId: string;
}) {
  const { threadId } = useBbContext();
  const navigate = useBbNavigate();
  const actions = useSidebarThreadActions();
  const dm = thread?.threadId ?? member.threadId;
  const split = useSidebarThreadSplit(dm ?? "");
  const stateLabels = {
    working: "Working",
    queued: "Queued",
    attention: "Needs attention",
    paused: "Paused",
    idle: "Idle",
  } as const;
  // An idle bot is the resting case; saying so on every row is just noise.
  const showState = member.state !== "idle";
  const splittable = !!dm && split.isAvailable;
  return (
    <button
      type="button"
      className="channel-rail-row"
      aria-current={dm && threadId === dm ? "page" : undefined}
      title={
        splittable
          ? "Drag or ⌘-click to open in a split"
          : // Live activity already reads in Live now; only a fault is worth a tooltip.
            (member.state === "attention" ? (member.detail ?? undefined) : undefined)
      }
      {...(dm ? split.splitProps : {})}
      onClick={(event) => {
        if (!dm)
          return navigate.toPluginPanel("bots", {
            subPath: `${member.bot.id}/profile`,
          });
        if (splittable && (event.metaKey || event.ctrlKey))
          actions.open(dm, { split: true });
        else openWorkThread(navigate, dm, roomId);
      }}
    >
      <span className="channel-rail-avatar" aria-hidden>
        {member.bot.avatar || <Icon name="Bot" />}
      </span>
      <span className="channel-rail-name">{member.bot.name}</span>
      {thread?.needsApproval && (
        <span
          className="channel-needs-attention"
          role="img"
          aria-label="Waiting for your approval"
        >
          <Icon name="BellDot" />
        </span>
      )}
      {showState && (
        <span className="channel-rail-state" data-state={member.state}>
          {stateLabels[member.state]}
        </span>
      )}
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


export function ChannelRail({
  automationsTab,
  room,
  bots,
  jobs,
  runs,
  approvals,
  messageIds,
  onChanged,
  onClose,
}: {
  automationsTab: PluginFixedTabRegistration;
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
  const appPanel = useAppPanel();
  const card = useRef<HTMLElement>(null);
  // Too narrow for a gutter, the card becomes a sheet over the whole channel.
  const [overlay, setOverlay] = useState(false);
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

  useEffect(() => {
    const host = card.current?.parentElement;
    if (!host) return;
    const observer = new ResizeObserver(([entry]) =>
      setOverlay(entry!.contentRect.width < overlayBelow),
    );
    observer.observe(host);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!overlay) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", dismiss);
    return () => window.removeEventListener("keydown", dismiss);
  }, [overlay, onClose]);

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
    <aside
      ref={card}
      className="channel-rail"
      data-overlay={overlay ? "" : undefined}
      aria-label={`#${room.name} details`}
    >
      <div className="channel-rail-header">
        <Button
          variant="ghost"
          size="sm"
          className="channel-rail-close"
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
                  <Icon name="AlertTriangle" />
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
            <RailList
              items={members}
              keyOf={(member) => member.bot.id}
              render={(member) => (
                <MemberRow
                  member={member}
                  thread={threads.find((dm) => dm.botId === member.bot.id)}
                  roomId={room.id}
                />
              )}
            />
          ) : (
            <p className="channel-rail-empty">No bots in this channel yet.</p>
          )}
        </RailSection>
        {upcoming && (
          <section className="channel-rail-section" data-section="automation">
            <div className="channel-rail-automation">
              <button
                type="button"
                className="channel-rail-row"
                title="Open automations"
                onClick={() => {
                  // BB owns the workbench; select our Automations tab there
                  // rather than stacking a second copy of it in a dialog.
                  if (
                    !appPanel.openFixedTab({
                      surface: { kind: "current" },
                      tab: automationsTab,
                    })
                  )
                    setAutomationsOpen(true);
                }}
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
          </section>
        )}
        {files.length > 0 && (
          <RailSection
            id="output"
            count={files.length}
            collapsed={isCollapsed("output")}
            onToggle={toggle}
          >
            <RailList
              items={files}
              keyOf={(file) => file.id}
              render={(file) => (
                <a
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
              )}
            />
          </RailSection>
        )}
        {usage && usageWorthShowing(usage) && (
          <RailSection
            id="usage"
            collapsed={isCollapsed("usage")}
            onToggle={toggle}
          >
            <p className="channel-rail-usage">
              {usage.turns} / {usage.limits.turnsPerDay} turns today
              {usage.errors > 0 && ` · ${usage.errors} failed`}
            </p>
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
