// bb-plugin-tok-speed — backend entry.
//
// Answers the app content script's `turnRates` RPC: for the requested threads,
// page through the event log (`bb.sdk.threads.events.list`) and, per turn,
// compute the pooled visible provider-output speed of that turn (see src/rate.ts
// for the exact definition). The app paints the result in each
// assistant message's hover menu. The pure computation is unit-tested and dependency-free;
// this file only does I/O and the event → EventRow mapping.

import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { computeTurnRates, type EventRow } from "./src/rate";

const MAX_THREAD_IDS = 8;
const EVENTS_PAGE_LIMIT = "500";
const MAX_EVENTS_PAGES = 40;
/** Re-fetch a thread's events at most this often. Events only grow at the tail
 *  while a turn is live, so once a turn's last response is closed its value is
 *  stable; the TTL bounds how quickly a *new* turn's figure appears. */
const EVENT_CACHE_TTL_MS = 10_000;

export const rpcContract = defineRpcContract({
  turnRates: {
    input: z
      .object({
        threadIds: z.array(z.string().min(1)).min(1).max(MAX_THREAD_IDS),
      })
      .strict(),
    output: z.object({
      turns: z.array(
        z.object({
          threadId: z.string(),
          turnId: z.string(),
          rate: z.number().nullable(),
          totalOutputTokens: z.number(),
          responseCount: z.number(),
        }),
      ),
    }),
  },
});

interface CachedThread {
  fetchedAt: number;
  events: readonly EventRow[];
}

export interface ThreadRateResult {
  threadId: string;
  turnId: string;
  rate: number | null;
  totalOutputTokens: number;
  responseCount: number;
}

const eventCache = new Map<string, CachedThread>();

/**
 * Page through the thread's events, newest first (the SDK pages backward from
 * the newest sequence), then reverse into ascending order for the rate walk.
 * Only the event types the walk needs are requested: provider item lifecycle
 * events and `thread/tokenUsage/updated` (provider usage snapshots).
 */
async function fetchThreadEvents(
  bb: BbPluginApi,
  threadId: string,
): Promise<readonly EventRow[]> {
  const collected: EventRow[] = [];
  let beforeSeq: string | undefined;
  let pages = 0;
  for (;;) {
    const page = (await bb.sdk.threads.events.list({
      threadId,
      order: "desc",
      limit: EVENTS_PAGE_LIMIT,
      types: [
        "client/turn/requested",
        "item/started",
        "item/completed",
        "thread/tokenUsage/updated",
      ],
      ...(beforeSeq ? { beforeSeq } : {}),
    })) as unknown as EventRow[];
    collected.push(...page);
    pages += 1;
    const oldest = page[page.length - 1];
    if (
      page.length < Number(EVENTS_PAGE_LIMIT) ||
      pages >= MAX_EVENTS_PAGES ||
      !oldest
    ) {
      break;
    }
    beforeSeq = String(oldest.seq);
  }
  return collected.reverse();
}

async function loadThreadEvents(
  bb: BbPluginApi,
  threadId: string,
  now: number,
): Promise<readonly EventRow[]> {
  const cached = eventCache.get(threadId);
  if (cached && now - cached.fetchedAt < EVENT_CACHE_TTL_MS) {
    return cached.events;
  }
  const events = await fetchThreadEvents(bb, threadId);
  eventCache.set(threadId, { fetchedAt: now, events });
  return events;
}

/** Convert one thread's event stream into the RPC's thread-qualified rows. */
export function computeThreadRates(
  threadId: string,
  events: readonly EventRow[],
): ThreadRateResult[] {
  // A turn is the scope carried by its tokenUsage events; asking the
  // computation for every turn that reports usage yields exactly the turns
  // that can produce a rate (no pre-filter needed).
  const turnIds = new Set<string>();
  for (const event of events) {
    if (
      event.type === "thread/tokenUsage/updated" &&
      event.scope?.kind === "turn" &&
      event.scope.turnId
    ) {
      turnIds.add(event.scope.turnId);
    }
  }
  if (turnIds.size === 0) return [];

  return Array.from(computeTurnRates({ turnIds, events }).values(), (turnRate) => ({
    threadId,
    ...turnRate,
  }));
}

export default function plugin(bb: BbPluginApi): void {
  bb.rpc.register(rpcContract, {
    async turnRates({ threadIds }) {
      const now = Date.now();
      const turns: ThreadRateResult[] = [];

      for (const threadId of threadIds) {
        let events: readonly EventRow[];
        try {
          events = await loadThreadEvents(bb, threadId, now);
        } catch (error) {
          const detail = error instanceof Error ? `: ${error.message}` : "";
          bb.log.warn(`turnRates: could not read events for ${threadId}${detail}`);
          continue;
        }
        if (events.length === 0) continue;

        turns.push(...computeThreadRates(threadId, events));
      }

      return { turns };
    },
  });

  bb.onDispose(() => {
    eventCache.clear();
  });
}
