// Pure computation for the token-throughput display.
//
// A turn consists of a sequence of provider responses. `last.outputTokens` is
// the output-token delta for the response represented by the provider's usage
// update (reasoning + visible text), not a running total. The badge subtracts
// `last.reasoningOutputTokens` so it measures the visible output stream.
//
// The host event log also contains the time spent executing commands and other
// tools. Usage updates may arrive after those items, so using
// `item/started → tokenUsage` as the denominator makes a fast provider look
// slow. Instead, this module sums the durations of completed assistant-message
// items and deliberately leaves hidden reasoning and host-executed items out
// of the denominator.
//
// The value shown in the assistant hover menu is pooled visible-output speed:
// visible output tokens divided by active agent-message time. It is a useful
// provider decode-speed indicator, not a hardware benchmark or end-to-end
// wall-clock measurement.

/** A single provider usage sample inside a turn, with its measured timing. */
export interface ResponseSample {
  /** Item kind that anchored the response. */
  kind: string;
  /** Item id that anchored the response. */
  itemId: string;
  /** Visible output tokens reported by the sample. */
  outputTokens: number;
  /** Active assistant-message duration in milliseconds. */
  durationMs: number;
}

/** Throughput summary for one turn, keyed by the thread-scoped turn id. */
export interface TurnRate {
  turnId: string;
  /** Pooled visible output tokens / measured message time, or null if the provider
   *  did not report usable usage for this turn. */
  rate: number | null;
  /** Sum of the sampled output tokens, for the tooltip. */
  totalOutputTokens: number;
  /** Number of usage samples included in the pooled rate. */
  responseCount: number;
}

/** Event-row shapes the algorithm consumes (a structural subset of the SDK's
 *  `ThreadEventRow`, so tests can feed plain objects). */
export interface EventRow {
  seq: number;
  createdAt: number;
  type: string;
  scope?: { kind?: string; turnId?: string } | null;
  data?: {
    providerThreadId?: string;
    target?: { expectedTurnId?: string } | null;
    item?: { type?: string; id?: string } | null;
    tokenUsage?: {
      last?: {
        outputTokens?: number | null;
        reasoningOutputTokens?: number | null;
      } | null;
    } | null;
  } | null;
}

export interface ComputeTurnRatesArgs {
  /** Thread-scoped turn ids (as they appear in the `item/started` scope). */
  turnIds: Iterable<string>;
  /** All events of one thread, in ascending sequence order. */
  events: readonly EventRow[];
  /** Ignore provider samples longer than this (a cancelled/stalled sample is
   *  not meaningful throughput). Defaults to 30 minutes. */
  maxResponseMs?: number;
  /** Ignore samples faster than this; a sub-50ms sample is a usage
   *  report flushed before the item-start was recorded. */
  minResponseMs?: number;
}

interface OpenAnchor {
  turnId: string;
  kind: string;
  itemId: string;
  startedAt: number;
}

interface ProviderInterval {
  kind: string;
  itemId: string;
  startedAt: number;
  completedAt: number;
}

// Only visible provider output anchors the badge. Reasoning and tool-call
// items are provider work, but their lifecycle measures hidden thinking or
// structured tool-request generation rather than the text stream the user is
// watching. Host-executed items such as `commandExecution`, `fileChange`,
// `mcpToolCall`, `delegation`, and `webFetch` are also intentionally absent.
const PROVIDER_ITEM_KINDS = new Set([
  "agentMessage",
]);

/**
 * Compute pooled throughput for each requested turn from the thread's event
 * stream.
 *
 * The walk is linear in the event count. Responses are matched to turns by the
 * *turn-scoped* item and usage scopes, so interleaved delegation turns in the
 * same thread are kept distinct. Completed provider-item intervals are
 * assigned to the next usage update for their turn; hidden reasoning and host
 * item lifecycles are never added to the denominator.
 */
export function computeTurnRates(args: ComputeTurnRatesArgs): Map<string, TurnRate> {
  const { events } = args;
  const turnIds = new Set(args.turnIds);
  const maxResponseMs = args.maxResponseMs ?? 30 * 60 * 1000;
  const minResponseMs = args.minResponseMs ?? 50;

  const openByItem = new Map<string, OpenAnchor>();
  const intervalsByTurn = new Map<string, ProviderInterval[]>();
  const samplesByTurn = new Map<string, ResponseSample[]>();

  for (const event of events) {
    const scopeTurnId = event.scope?.kind === "turn" ? event.scope.turnId : undefined;

    if (event.type === "client/turn/requested") {
      // A single BB turn may receive a steer or a system follow-up without a
      // new turn id. Drop provider intervals from the previous request so its
      // later usage update cannot be charged to the new response.
      const expectedTurnId = event.data?.target?.expectedTurnId;
      if (expectedTurnId && turnIds.has(expectedTurnId)) {
        openByItem.forEach((open, itemKey) => {
          if (open.turnId === expectedTurnId) openByItem.delete(itemKey);
        });
        intervalsByTurn.delete(expectedTurnId);
        samplesByTurn.delete(expectedTurnId);
      }
      continue;
    }

    if (event.type === "item/started") {
      const item = event.data?.item;
      const kind = item?.type;
      const itemId = item?.id;
      if (!scopeTurnId || !kind || !itemId || !turnIds.has(scopeTurnId)) continue;
      if (!PROVIDER_ITEM_KINDS.has(kind)) continue;
      const itemKey = scopeTurnId + "\u0000" + itemId;
      if (!openByItem.has(itemKey)) {
        openByItem.set(itemKey, {
          turnId: scopeTurnId,
          kind,
          itemId,
          startedAt: event.createdAt,
        });
      }
      continue;
    }

    if (event.type === "item/completed") {
      const item = event.data?.item;
      const kind = item?.type;
      const itemId = item?.id;
      if (!scopeTurnId || !kind || !itemId || !turnIds.has(scopeTurnId)) continue;
      if (!PROVIDER_ITEM_KINDS.has(kind)) continue;

      const itemKey = scopeTurnId + "\u0000" + itemId;
      const open = openByItem.get(itemKey);
      if (!open) continue;
      openByItem.delete(itemKey);

      if (event.createdAt < open.startedAt) continue;
      let intervals = intervalsByTurn.get(scopeTurnId);
      if (!intervals) {
        intervals = [];
        intervalsByTurn.set(scopeTurnId, intervals);
      }
      intervals.push({
        kind: open.kind,
        itemId: open.itemId,
        startedAt: open.startedAt,
        completedAt: event.createdAt,
      });
      continue;
    }

    if (event.type !== "thread/tokenUsage/updated") continue;
    if (!scopeTurnId) continue;

    const pending = intervalsByTurn.get(scopeTurnId) ?? [];
    const ready: ProviderInterval[] = [];
    const remaining: ProviderInterval[] = [];
    for (const interval of pending) {
      // Normally event timestamps and sequence order agree. Keep a late
      // completion for the following usage update instead of assigning it to
      // a usage snapshot that predates its actual completion.
      if (interval.completedAt <= event.createdAt) {
        ready.push(interval);
      } else {
        remaining.push(interval);
      }
    }
    if (remaining.length > 0) {
      intervalsByTurn.set(scopeTurnId, remaining);
    } else {
      intervalsByTurn.delete(scopeTurnId);
    }

    const usageLast = event.data?.tokenUsage?.last;
    const reportedOutputTokens = usageLast?.outputTokens ?? 0;
    const reasoningOutputTokens = usageLast?.reasoningOutputTokens ?? 0;
    const outputTokens = reportedOutputTokens - reasoningOutputTokens;
    if (!Number.isFinite(outputTokens) || outputTokens <= 0 || ready.length === 0) {
      continue;
    }

    // Item lifecycles are usually sequential, but union them defensively so a
    // provider that overlaps two streams cannot make the denominator too
    // large by double-counting the overlap.
    ready.sort((left, right) => left.startedAt - right.startedAt);
    let activeStart = ready[0]!.startedAt;
    let activeEnd = ready[0]!.completedAt;
    let durationMs = 0;
    for (const interval of ready.slice(1)) {
      if (interval.startedAt <= activeEnd) {
        activeEnd = Math.max(activeEnd, interval.completedAt);
      } else {
        durationMs += activeEnd - activeStart;
        activeStart = interval.startedAt;
        activeEnd = interval.completedAt;
      }
    }
    durationMs += activeEnd - activeStart;
    if (durationMs < minResponseMs || durationMs > maxResponseMs) continue;

    let samples = samplesByTurn.get(scopeTurnId);
    if (!samples) {
      samples = [];
      samplesByTurn.set(scopeTurnId, samples);
    }
    samples.push({
      kind: ready[0]!.kind,
      itemId: ready[0]!.itemId,
      outputTokens,
      durationMs,
    });
  }

  const result = new Map<string, TurnRate>();
  for (const [turnId, samples] of samplesByTurn) {
    if (!turnIds.has(turnId) || samples.length === 0) continue;
    const totalOutputTokens = samples.reduce(
      (sum, sample) => sum + sample.outputTokens,
      0,
    );
    const totalDurationMs = samples.reduce(
      (sum, sample) => sum + sample.durationMs,
      0,
    );
    const rate = totalOutputTokens / (totalDurationMs / 1000);
    result.set(turnId, {
      turnId,
      rate: Number.isFinite(rate) ? rate : null,
      totalOutputTokens,
      responseCount: samples.length,
    });
  }
  return result;
}

/**
 * Extract the thread-scoped turn id that a timeline row's id embeds.
 *
 * Assistant row ids look like
 *   `<threadId>:assistant:kind:assistant|turn:<T>|parent:root|item:<I>`
 * and the named `turn:` marker is the one the tokenUsage events' turn scopes
 * use. Returns undefined when the id carries no recognizable turn marker.
 */
export function turnIdFromRowId(rowId: string): string | undefined {
  const match = rowId.match(/\|turn:([^|]+)/);
  return match?.[1];
}

/**
 * Format a tokens-per-second value for display: 1 decimal below 100, whole
 * digits at or above, with thousands grouping for large values.
 */
export function formatRate(rate: number | null | undefined): string {
  if (rate == null || !Number.isFinite(rate)) return "";
  if (rate < 100) return rate.toFixed(1);
  if (rate < 1000) return rate.toFixed(0);
  return Math.round(rate).toLocaleString("en-US");
}
