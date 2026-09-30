// Explore workers: a hidden fork of the thread at the message, which
// investigates one finding and replies with the page. These are the BB
// specifics ExploreService takes as deps.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { CollectedContext, WorkerProgress } from "./service";
import { WORKER_METADATA_KEY } from "./shared";
import type { ExplainerRow } from "./store";
import { countReads, findMessage, olderCursor, turnHints, type MessageAnchor } from "./timeline";

/** A worker that hasn't finished in this long is stuck (waiting on an approval, say). */
export const WORKER_TIMEOUT_MS = 20 * 60_000;
const POLL_MS = 2_000;
/** Older timeline pages to read looking for the message. */
const MAX_TIMELINE_PAGES = 8;

const ACTIVE_THREAD = new Set(["pending", "starting", "active", "stopping"]);

function isSessionUnavailable(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "fork_source_session_unavailable";
}

/** Whether a thread's `pluginMetadata` (Pages' namespace) marks it as an Explore worker. */
export function isExploreWorker(metadata: Readonly<Record<string, unknown>>): boolean {
  return typeof metadata[WORKER_METADATA_KEY] === "string";
}

/**
 * The fork's final message once its own turn is done. The text a fork
 * inherits from its source thread (the source's last answer) is never it.
 */
export function workerOutput(input: { text: string | null; inherited: string | null }): string | null {
  const text = input.text?.trim() ? input.text : null;
  if (!text || (input.inherited !== null && text === input.inherited)) return null;
  return text;
}

export function exploreWorkers(bb: BbPluginApi) {
  /** Workers that settled (idle or failed) since their poller last looked, and wake-ups for their pollers. */
  const settled = new Map<string, { failed: boolean; text: string | null }>();
  const wakers = new Map<string, () => void>();

  const settle = (threadId: string, outcome: { failed: boolean; text: string | null }) => {
    const wake = wakers.get(threadId);
    if (!wake) return;
    settled.set(threadId, outcome);
    wake();
  };
  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => settle(thread.id, { failed: false, text: lastAssistantText ?? null }));
  bb.events.on("thread.failed", ({ thread, error }) => settle(thread.id, { failed: true, text: error }));

  const sleep = (workerId: string, ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener("abort", done, { once: true });
      wakers.set(workerId, done);
    });

  async function findAnchor(threadId: string, messageId: string, signal: AbortSignal): Promise<{ anchor: MessageAnchor | null; rows: unknown[] }> {
    const rows: unknown[] = [];
    let cursor: { beforeAnchorId: string; beforeAnchorSeq: string } | null = null;
    for (let page = 0; page < MAX_TIMELINE_PAGES; page += 1) {
      const timeline = await bb.sdk.threads.timeline({ threadId, includeNestedRows: "true", segmentLimit: "100", ...(cursor ?? {}), signal });
      rows.push(...timeline.rows);
      const anchor = findMessage(timeline.rows, messageId);
      if (anchor) return { anchor, rows };
      cursor = olderCursor(timeline);
      if (!cursor) break;
    }
    return { anchor: null, rows };
  }

  async function collect(explainer: ExplainerRow, signal: AbortSignal): Promise<CollectedContext> {
    const thread = await bb.sdk.threads.get({ threadId: explainer.thread_id, signal });
    const { anchor, rows } = await findAnchor(explainer.thread_id, explainer.message_id, signal);
    return {
      projectId: thread.projectId ?? explainer.project_id,
      hints: turnHints(rows, explainer.turn_id ?? anchor?.turnId ?? null),
      fork: { sourceSeqEnd: anchor?.sourceSeqEnd ?? null, environmentId: thread.environmentId ?? null },
    };
  }

  async function startWorker(explainer: ExplainerRow, prompt: string, context: CollectedContext): Promise<string> {
    const args = {
      sourceThreadId: explainer.thread_id,
      // Archived with the thread it explores.
      lifecycleOwnerThreadId: explainer.thread_id,
      visibility: "hidden" as const,
      title: `Explore: ${explainer.label}`.slice(0, 120),
      input: [{ type: "text" as const, text: prompt, mentions: [] }],
      // Marks it as ours for `bb.agents.configure`: no Explore instructions or tool.
      pluginMetadata: { [WORKER_METADATA_KEY]: explainer.id },
      ...(context.fork.environmentId ? { environment: { type: "reuse" as const, environmentId: context.fork.environmentId } } : {}),
    };
    const { sourceSeqEnd } = context.fork;
    try {
      const worker = await bb.sdk.threads.fork(sourceSeqEnd !== null ? { ...args, sourceSeqEnd } : args);
      return worker.id;
    } catch (error) {
      // The provider can't resume from that point: fork the whole thread instead.
      if (sourceSeqEnd === null || !isSessionUnavailable(error)) throw error;
      return (await bb.sdk.threads.fork(args)).id;
    }
  }

  async function awaitWorker(workerId: string, signal: AbortSignal, progress: (update: WorkerProgress) => void): Promise<string> {
    const started = Date.now();
    let sawActive = false;
    let polls = 0;
    let reads = 0;
    // Registered before anything is awaited, so a quick worker's idle event isn't missed.
    wakers.set(workerId, () => undefined);
    try {
      // A fork copies the source thread's events, so until the worker writes its
      // own message its output is the source's last answer. Remember that text:
      // a turn that ends without a message (stopped, cut off) must not save it.
      const inherited = (await bb.sdk.threads.output({ threadId: workerId, signal }).catch(() => null))?.output ?? null;
      while (!signal.aborted) {
        const elapsed = Date.now() - started;
        if (elapsed > WORKER_TIMEOUT_MS) throw new Error("The explainer took too long. Try again.");
        const event = settled.get(workerId);
        settled.delete(workerId);
        const thread = await bb.sdk.threads.get({ threadId: workerId, signal });
        if (ACTIVE_THREAD.has(thread.status)) sawActive = true;
        if (thread.status === "error") throw new Error("The explainer's agent failed. Try again.");
        if (thread.status === "idle" && (event || sawActive)) {
          const text = workerOutput({ text: event && !event.failed ? event.text : null, inherited }) ?? workerOutput({ text: (await bb.sdk.threads.output({ threadId: workerId, signal })).output, inherited });
          if (text) return text;
          // Idle after its own turn, with nothing new: it wrote nothing.
          if (sawActive) throw new Error("The explainer's agent finished without writing anything.");
          // Otherwise the idle came before its turn started: keep waiting.
        }
        if (polls % 3 === 0) {
          try {
            const timeline = await bb.sdk.threads.timeline({ threadId: workerId, includeNestedRows: "true", segmentLimit: "20", signal });
            reads = countReads(timeline.rows, started) || reads;
          } catch {
            // progress detail is advisory
          }
        }
        polls += 1;
        progress({
          fraction: 1 - Math.exp(-elapsed / 150_000),
          detail: reads ? `Investigating · looked at ${reads} ${reads === 1 ? "file" : "files"}` : "Investigating",
        });
        await sleep(workerId, POLL_MS, signal);
      }
      throw new Error("Stopped.");
    } finally {
      wakers.delete(workerId);
      settled.delete(workerId);
    }
  }

  /** Stops and archives a worker, so a stopped or failed job leaves no hidden thread running. */
  async function disposeWorker(workerId: string): Promise<void> {
    await bb.sdk.threads.stop({ threadId: workerId }).catch(() => undefined);
    await bb.sdk.threads.archive({ threadId: workerId }).catch(() => undefined);
  }

  return {
    collect,
    startWorker,
    awaitWorker,
    disposeWorker,
    dispose() {
      for (const wake of wakers.values()) wake();
      wakers.clear();
      settled.clear();
    },
  };
}
