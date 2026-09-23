import type { Bot, ChannelApproval, Job, RoomRun } from "./contract";
import type { ChannelAutomation } from "./automation-contract";
import { channelQueues, channelWorkActivity } from "./channel-work";

/** One live session in the rail: the running head plus what waits behind it. */
export type RailLiveEntry = {
  jobId: string;
  botId: string;
  threadId: string | null;
  activity: string;
  running: boolean;
  startedAt: number | null;
  queuedBehind: number;
  stoppable: boolean;
};

export function railLive(jobs: Job[]): RailLiveEntry[] {
  return channelQueues(jobs).map(({ head, queued }) => ({
    jobId: head.id,
    botId: head.botId,
    threadId: head.threadId,
    activity: channelWorkActivity(head),
    running: head.status === "running",
    startedAt: head.startedAt ?? head.dispatchStartedAt,
    queuedBehind: queued.length,
    stoppable: !head.cancellationPending,
  }));
}

/**
 * Runs still choosing recipients. Without this the gap between sending and a
 * bot appearing looks like nothing happened.
 */
export const railRoutingCount = (runs: RoomRun[]) =>
  runs.filter((run) => run.routing === "pending" && run.status === "running")
    .length;

export type RailMemberState =
  | "working"
  | "queued"
  | "attention"
  | "paused"
  | "idle";

export type RailMember = {
  bot: Bot;
  state: RailMemberState;
  detail: string | null;
  threadId: string | null;
};

const memberOrder: Record<RailMemberState, number> = {
  working: 0,
  queued: 1,
  attention: 2,
  paused: 3,
  idle: 4,
};

/** Who is in the room and what each one is doing right now. */
export function railMembers(
  bots: Bot[],
  memberIds: string[],
  jobs: Job[],
): RailMember[] {
  const live = railLive(jobs);
  return memberIds
    .flatMap((id) => {
      const bot = bots.find((candidate) => candidate.id === id);
      if (!bot || bot.retired) return [];
      const entry = live.find((job) => job.botId === id) ?? null;
      const state: RailMemberState = entry
        ? entry.running
          ? "working"
          : "queued"
        : bot.paused
          ? "paused"
          : bot.error
            ? "attention"
            : "idle";
      return [
        {
          bot,
          state,
          detail: entry?.activity ?? (state === "attention" ? bot.error : null),
          threadId: entry?.threadId ?? null,
        },
      ];
    })
    .sort(
      (a, b) =>
        memberOrder[a.state] - memberOrder[b.state] ||
        a.bot.name.localeCompare(b.bot.name),
    );
}

/** The soonest scheduled run. Paused automations never count as "next". */
export function nextAutomation(
  automations: ChannelAutomation[],
  now: number,
): ChannelAutomation | null {
  return (
    automations
      .filter(
        (automation) =>
          automation.enabled &&
          automation.nextRunAt !== null &&
          automation.nextRunAt >= now,
      )
      .sort((a, b) => a.nextRunAt! - b.nextRunAt!)[0] ?? null
  );
}

const units: [limit: number, size: number, suffix: string][] = [
  [60_000, 1000, "s"],
  [3_600_000, 60_000, "m"],
  [86_400_000, 3_600_000, "h"],
  [Number.POSITIVE_INFINITY, 86_400_000, "d"],
];

/** Coarse "2h 14m" style duration. Two units is all a glanceable rail needs. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return "0s";
  const index = units.findIndex(([limit]) => ms < limit);
  const [, size, suffix] = units[index]!;
  const whole = Math.floor(ms / size);
  const rest = units[index - 1];
  if (!rest) return `${whole}${suffix}`;
  const remainder = Math.floor((ms - whole * size) / rest[1]);
  return remainder ? `${whole}${suffix} ${remainder}${rest[2]}` : `${whole}${suffix}`;
}

export const formatCountdown = (ms: number) =>
  ms <= 1000 ? "now" : `in ${formatDuration(ms)}`;

/** Requests blocking a bot, newest last so the rail reads like the transcript. */
export const railApprovals = (approvals: ChannelApproval[]) =>
  [...approvals].sort((a, b) => a.createdAt - b.createdAt);

/**
 * A rail that looks the same busy and idle is just another tab. Sections with
 * nothing to say stay closed so the rail empties out with the channel.
 */
export function railHasLiveWork(
  jobs: Job[],
  runs: RoomRun[],
  approvals: ChannelApproval[],
  attentionCount: number,
) {
  return (
    railLive(jobs).length > 0 ||
    railRoutingCount(runs) > 0 ||
    approvals.length > 0 ||
    attentionCount > 0
  );
}
