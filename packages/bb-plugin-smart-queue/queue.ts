import type { MessageDispatchHookContext, MessageDispatchHookDecision } from "@get-bb/plugin-sdk";
import type { Verdict } from "./classifier";

export type QueuedRow = MessageDispatchHookContext["queuedMessages"][number];
export type ThreadInfo = MessageDispatchHookContext["thread"];
export type DecisionRecord = {
  at: number;
  threadId: string;
  queuedMessageId: string;
  preview: string;
  verdict: Verdict;
};

type Tracking = {
  threadId: string;
  createdAt: number;
  /** When Smart Queue first saw the row, so a queue snapshot taken earlier cannot prune it. */
  seenAt: number;
  /** Resolves once this row's decision, including any steer, has been applied. */
  applied: Promise<void>;
  finish: () => void;
};
type Entry =
  | (Tracking & { state: "pending"; startedAt: number; controller: AbortController })
  | (Tracking & { state: "decided"; verdict: Verdict })
  /** A core-queued row Smart Queue leaves alone, remembered so the watcher does not re-read it. */
  | (Tracking & { state: "ignored" });

export type SmartQueueDeps = {
  pluginId: string;
  enabled: () => Promise<boolean>;
  thread: (threadId: string) => Promise<ThreadInfo>;
  classify: (row: QueuedRow, thread: ThreadInfo, signal: AbortSignal) => Promise<Verdict>;
  steer: (row: QueuedRow) => Promise<void>;
  recheck: () => Promise<void>;
  record: (record: DecisionRecord) => Promise<void>;
  warn: (message: string) => void;
  now?: () => number;
};

/**
 * Core paces re-attempts per thread and can drop a recheck that arrives right
 * after a row queued, so every hold also carries its own re-ask time. While
 * deciding it is short, so the queued card shows the decision promptly.
 */
export const holdMs = 5_000;
/** A held follow-up is normally released by the idle recheck; this is the backstop. */
export const followupRecheckMs = 60_000;
/** A decision older than this is abandoned in favor of follow-up. */
export const maxDecideMs = 90_000;
export const decidingReason = "Smart Queue is deciding whether to steer or follow up.";

export function describeVerdict(verdict: Verdict) {
  const via = verdict.via ? ` via ${verdict.via}` : "";
  if (verdict.source === "jev")
    return `Jev${verdict.confidence === null ? "" : ` ${Math.round(verdict.confidence * 100)}%`}${via}`;
  return verdict.source === "model" ? `fallback model${via}` : "no classifier answered";
}
export const followupReason = (verdict: Verdict) =>
  `Smart Queue: follow-up after the current turn (${describeVerdict(verdict)}).`;

export const isBusy = (status: ThreadInfo["status"]) => status === "active" || status === "starting";
export const rowText = (row: Pick<QueuedRow, "content">) =>
  row.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");

const lostVerdict: Verdict = {
  action: "followup",
  source: "default",
  confidence: null,
  note: "The decision was lost when Smart Queue restarted.",
};

/**
 * Holds owner messages sent to a busy thread until a classifier decides.
 * Steer delivers the row into the running turn now; follow-up keeps it held
 * until the thread is no longer busy. Core-queued rows (Enter set to queue)
 * are classified too, but only a steer changes them.
 */
export class SmartQueue {
  readonly entries = new Map<string, Entry>();
  private readonly now: () => number;

  constructor(private readonly deps: SmartQueueDeps) {
    this.now = deps.now ?? Date.now;
  }

  eligibleThread(thread: ThreadInfo) {
    // Classifier sessions are ours, and Bot Teams routes its own sessions.
    return (
      thread.visibility !== "hidden" &&
      thread.originPluginId !== this.deps.pluginId &&
      thread.originPluginId !== "bot-teams"
    );
  }

  heldByUs(row: Pick<QueuedRow, "waitingOn">) {
    return row.waitingOn?.kind === "plugin" && row.waitingOn.pluginId === this.deps.pluginId;
  }

  /** Answers `message.dispatch`. Only memory and settings are read: the hook runs under core's lock. */
  async dispatch(context: MessageDispatchHookContext): Promise<MessageDispatchHookDecision> {
    const proceed = { action: "proceed" } as const;
    if (!this.eligibleThread(context.thread) || !(await this.deps.enabled())) return proceed;
    const busy = isBusy(context.thread.status);
    if (!context.queuedMessages.length) {
      const human =
        context.initiator === "user" &&
        context.senderThreadId === null &&
        context.experimental_submission === null;
      if (!human || (context.attempt !== "join-turn" && !busy)) return proceed;
      return { action: "wait", reason: decidingReason, sendAt: this.now() + holdMs };
    }
    // A thread that is free needs no decision: deliver what is waiting.
    if (!busy) return proceed;
    let pending = false;
    let followup: Verdict | null = null;
    for (const row of context.queuedMessages) {
      // Core owns the waits it created; a decision only changes those by steering.
      if (!this.heldByUs(row)) continue;
      let entry = this.entries.get(row.id);
      if (entry?.state === "pending" && this.now() - entry.startedAt >= maxDecideMs) {
        entry.controller.abort();
        entry = {
          ...entry,
          state: "decided",
          verdict: { action: "followup", source: "default", confidence: null, note: "The classifier timed out." },
        };
        this.entries.set(row.id, entry);
      }
      if (entry?.state === "pending") pending = true;
      else if (entry?.state === "decided" && entry.verdict.action === "followup") followup ??= entry.verdict;
      else if (!entry) followup ??= lostVerdict;
    }
    if (pending) return { action: "wait", reason: decidingReason, sendAt: this.now() + holdMs };
    if (followup) return { action: "wait", reason: followupReason(followup), sendAt: this.now() + followupRecheckMs };
    return proceed;
  }

  /**
   * The app's composer queues a busy-thread message by creating the row
   * directly, which runs no hook and fires no `message.queued`. A periodic
   * snapshot of every live row finds those, and forgets rows that left the
   * queue without an event.
   */
  sync(rows: readonly QueuedRow[], listedAt: number) {
    const live = new Set(rows.map((row) => row.id));
    for (const [id, entry] of this.entries)
      if (!live.has(id) && entry.seenAt < listedAt) {
        if (entry.state === "pending") entry.controller.abort();
        entry.finish();
        this.entries.delete(id);
      }
    for (const row of rows) this.queued(row);
  }

  /** `message.queued`: start one classification per owner row waiting on a busy thread. */
  queued(row: QueuedRow) {
    if (this.entries.has(row.id)) return;
    if (row.initiator !== "user" || row.senderThreadId !== null || row.originPluginId !== null) return;
    if (row.payload.kind !== "inline") return;
    const held = this.heldByUs(row);
    if (!held && row.waitingOn?.kind !== "thread-busy") return;
    const controller = new AbortController();
    let finish!: () => void;
    const applied = new Promise<void>((resolve) => (finish = resolve));
    this.entries.set(row.id, {
      state: "pending",
      threadId: row.threadId,
      createdAt: row.createdAt,
      seenAt: this.now(),
      applied,
      finish,
      startedAt: this.now(),
      controller,
    });
    void this.decide(row, held, controller).finally(finish);
  }

  /** Steers land in the order the owner sent them, even when a later classification finishes first. */
  private async earlierApplied(row: QueuedRow) {
    const earlier = [...this.entries.entries()].filter(
      ([id, entry]) =>
        id !== row.id &&
        entry.threadId === row.threadId &&
        (entry.createdAt < row.createdAt || (entry.createdAt === row.createdAt && id < row.id)),
    );
    await Promise.all(earlier.map(([, entry]) => entry.applied));
  }

  private async decide(row: QueuedRow, held: boolean, controller: AbortController) {
    const current = () => {
      const entry = this.entries.get(row.id);
      return entry?.state === "pending" && entry.controller === controller;
    };
    let verdict: Verdict;
    try {
      const thread = await this.deps.thread(row.threadId);
      if (!current()) return;
      if (!isBusy(thread.status) || (!held && (!this.eligibleThread(thread) || !(await this.deps.enabled())))) {
        if (held) {
          this.entries.delete(row.id);
          await this.deps.recheck();
        } else if (current()) this.entries.set(row.id, { ...this.entries.get(row.id)!, state: "ignored" });
        return;
      }
      verdict = await this.deps.classify(row, thread, controller.signal);
    } catch (error) {
      if (controller.signal.aborted || !current()) return;
      verdict = { action: "followup", source: "default", confidence: null, note: String(error) };
      this.deps.warn(`Smart Queue could not classify ${row.id}: ${String(error)}`);
    }
    const decided = (verdict: Verdict) => {
      const entry = this.entries.get(row.id);
      if (entry) this.entries.set(row.id, { ...entry, state: "decided", verdict });
    };
    if (!current()) return;
    decided(verdict);
    if (verdict.action === "steer") {
      try {
        await this.earlierApplied(row);
        if (!this.entries.has(row.id)) return;
        await this.deps.steer(row);
      } catch (error) {
        if (/not found|HTTP 404/i.test(String(error))) {
          this.entries.delete(row.id);
          return;
        }
        this.deps.warn(`Smart Queue could not steer ${row.id}: ${String(error)}`);
        verdict = { ...verdict, action: "followup", note: `Steer failed: ${String(error)}` };
        decided(verdict);
      }
    }
    try {
      await this.deps.record({
        at: this.now(),
        threadId: row.threadId,
        queuedMessageId: row.id,
        preview: rowText(row).replace(/\s+/g, " ").trim().slice(0, 120),
        verdict,
      });
    } catch (error) {
      this.deps.warn(`Smart Queue could not record a decision: ${String(error)}`);
    }
    // Refresh the queued card's reason, or release the row if the turn ended meanwhile.
    if (held && verdict.action === "followup") await this.deps.recheck();
  }

  /** `message.dispatched` and `message.cancelled`. */
  gone(row: Pick<QueuedRow, "id">) {
    const entry = this.entries.get(row.id);
    if (entry?.state === "pending") entry.controller.abort();
    entry?.finish();
    this.entries.delete(row.id);
  }

  /** `thread.idle` and `thread.failed`: release the follow-ups held for this thread. */
  async settled(threadId: string) {
    if ([...this.entries.values()].some((entry) => entry.threadId === threadId)) await this.deps.recheck();
  }

  /** `thread.archived` and `thread.deleted`: rows vanish without a queue event. */
  forget(threadId: string) {
    for (const [id, entry] of this.entries)
      if (entry.threadId === threadId) {
        if (entry.state === "pending") entry.controller.abort();
        entry.finish();
        this.entries.delete(id);
      }
  }

  dispose() {
    for (const entry of this.entries.values()) {
      if (entry.state === "pending") entry.controller.abort();
      entry.finish();
    }
    this.entries.clear();
  }
}
