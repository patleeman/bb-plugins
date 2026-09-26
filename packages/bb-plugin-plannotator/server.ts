// BB's Plannotator integration is intentionally a bridge, not a second
// review product. The released upstream binary owns the plan renderer,
// annotations, history, and feedback formatting. BB supplies the agent tool,
// embeds the upstream session, and delivers decisions in a later thread message.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  defineRpcContract,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  BUNDLED_BINARY,
  DEFAULT_BINARY,
  ensureBundledPlannotatorBinary,
  missingBinaryMessage,
  resolvePlannotatorBinary,
  startUpstreamPlanReview,
  type RunningUpstreamReview,
  type UpstreamDecision,
  type UpstreamOrigin,
} from "./src/bridge";
import {
  PANEL_ACTION_ID,
  PLANNOTATOR_RELAY_PATH,
  PLANNOTATOR_REALTIME_CHANNEL,
} from "./src/constants";
import { isLocalBindHostname } from "./src/embedded";
import {
  registerPlannotatorRelayRoutes,
} from "./src/relay";

const reviewToolParametersSchema = z
  .object({
    planMarkdown: z.string().trim().min(1).max(1_000_000),
    title: z.string().trim().min(1).max(200).optional(),
    previousPlanMarkdown: z.string().max(1_000_000).optional(),
  })
  .strict();

const interactionPayloadSchema = z
  .object({
    kind: z.literal("plannotator"),
    sessionId: z.string().min(1),
    threadId: z.string().min(1),
    sessionUrl: z.string().url(),
    relayPath: z.literal(PLANNOTATOR_RELAY_PATH),
    title: z.string().min(1),
  })
  .strict();
type ReviewPanelPayload = z.infer<typeof interactionPayloadSchema>;

export const rpcContract = defineRpcContract({
  /** A health check for the right-panel shell and plugin tests. */
  status: {
    input: z.object({}).strict(),
    output: z
      .object({
        binary: z.string().nullable(),
        configuredPath: z.string(),
      })
      .strict(),
  },
  getActiveReview: {
    input: z
      .object({
        threadId: z.string().min(1),
      })
      .strict(),
    output: interactionPayloadSchema.nullable(),
  },
  cancelReview: {
    input: z
      .object({
        threadId: z.string().min(1),
        sessionId: z.string().min(1),
      })
      .strict(),
    output: z.object({ cancelled: z.boolean() }).strict(),
  },
});

type ActiveReview = {
  sessionId: string;
  payload: ReviewPanelPayload;
  review: RunningUpstreamReview;
  controller: AbortController;
  cancelledByUser: boolean;
  deleted: boolean;
  settled?: Promise<void>;
};

type ReviewResult = {
  reviewId: string;
  source: "plannotator";
  decision: "approved" | "changes_requested" | "cancelled";
  feedback?: string;
  savedPath?: string;
  agentSwitch?: string;
  error?: string;
};

const storedReviewSchema = z.object({
  id: z.string().uuid(),
  threadId: z.string().min(1),
  status: z.enum(["pending", "ready", "delivered"]),
  result: z.object({
    reviewId: z.string().uuid(),
    source: z.literal("plannotator"),
    decision: z.enum(["approved", "changes_requested", "cancelled"]),
    feedback: z.string().optional(),
    savedPath: z.string().optional(),
    agentSwitch: z.string().optional(),
    error: z.string().optional(),
  }).optional(),
  updatedAt: z.number(),
});
type StoredReview = z.infer<typeof storedReviewSchema>;
const REVIEW_KEY_PREFIX = "review:";
const DELIVERED_REVIEW_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const DELIVERY_RETRY_MS = 30_000;

/**
 * Map BB's provider ids to the identities the upstream UI knows how to name.
 * The child must not infer this from ambient OPENCODE/CODEX_* environment
 * variables: BB owns the review session and its follow-up message.
 */
export function upstreamOriginForProvider(
  providerId: string | null | undefined,
): UpstreamOrigin {
  const normalized = providerId?.trim().toLowerCase() ?? "";
  if (normalized === "opencode" || normalized.includes("open-code")) {
    return "opencode";
  }
  if (normalized === "claude" || normalized.includes("claude-code")) {
    return "claude-code";
  }
  if (normalized === "copilot" || normalized.includes("copilot-cli")) {
    return "copilot-cli";
  }
  if (normalized === "gemini" || normalized.includes("gemini-cli")) {
    return "gemini-cli";
  }
  if (
    normalized === "pi" ||
    normalized === "omp" ||
    normalized.includes("oh-my-pi")
  ) {
    return "pi";
  }
  return "codex";
}

async function resolveUpstreamOrigin(
  bb: BbPluginApi,
  threadId: string,
  signal: AbortSignal,
): Promise<UpstreamOrigin> {
  try {
    const thread = await bb.sdk.threads.get({ threadId, signal });
    return upstreamOriginForProvider(thread.providerId);
  } catch {
    // The provider identity is presentation-only. A failed metadata lookup
    // must not prevent the review gate from opening.
    return "codex";
  }
}

export function shouldUseRemotePlannotatorMode(
  serverUrl: string | undefined,
  env: Partial<Pick<NodeJS.ProcessEnv, "BB_APP_URL" | "BB_SERVER_BIND_HOST">> = process.env,
): boolean {
  const configuredUrl = env.BB_APP_URL?.trim() || serverUrl?.trim();
  if (configuredUrl) {
    try {
      if (!isLocalBindHostname(new URL(configuredUrl).hostname)) return true;
    } catch {
      // Fall through to the explicit bind-host signal below.
    }
  }
  return env.BB_SERVER_BIND_HOST?.trim() === "0.0.0.0";
}

async function resolveUpstreamRuntimeConfig(
  bb: BbPluginApi,
  signal: AbortSignal,
): Promise<{ dataDir?: string; remote: boolean }> {
  try {
    const systemConfig = await bb.sdk.system.config({ signal });
    return {
      dataDir: join(systemConfig.dataDir, "plugins", bb.pluginId, "plannotator"),
      remote: shouldUseRemotePlannotatorMode(systemConfig.serverUrl),
    };
  } catch {
    // External runtimes remain usable if an older host does not expose the
    // system data directory. The bundled runtime already needs this lookup.
    return {
      remote: shouldUseRemotePlannotatorMode(undefined),
    };
  }
}

function resolveEmbedHost(bb: BbPluginApi): string | undefined {
  try {
    return new URL(bb.server.loopbackBaseUrl).hostname;
  } catch {
    return undefined;
  }
}

function panelSessionId(paramsJson: string | null): string | null {
  if (!paramsJson) return null;
  try {
    const value = JSON.parse(paramsJson) as unknown;
    return isRecord(value) && typeof value.sessionId === "string"
      ? value.sessionId
      : null;
  } catch {
    return null;
  }
}

/** Persist and focus the upstream review in the thread's right-panel tabs. */
async function openReviewPanel(
  bb: BbPluginApi,
  threadId: string,
  payload: ReviewPanelPayload,
): Promise<void> {
  const tab = {
    kind: "plugin-panel" as const,
    id: `plugin-panel:${bb.pluginId}:${PANEL_ACTION_ID}:${payload.sessionId}`,
    actionId: PANEL_ACTION_ID,
    pluginId: bb.pluginId,
    title: payload.title,
    paramsJson: JSON.stringify(payload),
  };

  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const current = await bb.sdk.threads.tabs.get({ threadId });
      const alreadyOpen = current.tabs.some(
        (existing) =>
          existing.kind === "plugin-panel" &&
          existing.pluginId === bb.pluginId &&
          existing.actionId === PANEL_ACTION_ID &&
          panelSessionId(existing.paramsJson) === payload.sessionId,
      );
      if (alreadyOpen) return;

      await bb.sdk.threads.tabs.update({
        threadId,
        expectedRevision: current.revision,
        tabs: [...current.tabs, tab],
      });
      return;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Could not open the Plannotator tab: ${String(lastError)}`);
}

/** Remove only this review's persisted right-panel tab, retrying CAS races. */
async function closeReviewPanel(
  bb: BbPluginApi,
  threadId: string,
  sessionId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const current = await bb.sdk.threads.tabs.get({ threadId });
      const remaining = current.tabs.filter((tab) => {
        if (tab.kind !== "plugin-panel") return true;
        return !(
          tab.pluginId === bb.pluginId &&
          tab.actionId === PANEL_ACTION_ID &&
          panelSessionId(tab.paramsJson) === sessionId
        );
      });
      if (remaining.length === current.tabs.length) return;

      await bb.sdk.threads.tabs.update({
        threadId,
        expectedRevision: current.revision,
        tabs: remaining,
      });
      return;
    } catch (error) {
      if (attempt === 2) {
        bb.log.warn(
          `Could not close Plannotator tab for ${threadId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decisionLabel(decision: UpstreamDecision): "approved" | "changes_requested" | "cancelled" {
  if (decision.approved) return "approved";
  return decision.feedback?.trim() ? "changes_requested" : "cancelled";
}

function reviewResult(reviewId: string, decision: UpstreamDecision): ReviewResult {
  return {
    reviewId,
    source: "plannotator",
    decision: decisionLabel(decision),
    ...(decision.feedback ? { feedback: decision.feedback } : {}),
    ...(decision.savedPath ? { savedPath: decision.savedPath } : {}),
    ...(decision.agentSwitch ? { agentSwitch: decision.agentSwitch } : {}),
  };
}

function reviewMessage(result: ReviewResult): string {
  return [
    `Plannotator review ${result.reviewId} has finished.`,
    JSON.stringify(result),
    "This answers the earlier plannotator_review_plan call. Continue the original task if approved; revise the plan if changes were requested. Cancellation is not approval. Do not repeat this review unless asked.",
  ].join("\n\n");
}

function errorResponse(message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ decision: "cancelled", source: "plannotator", error: message }) }],
    isError: true,
  };
}

async function getConfiguredPath(settings: { get(): Promise<{ binaryPath: string }> }): Promise<string> {
  const configured = await settings.get();
  return configured.binaryPath.trim() || BUNDLED_BINARY;
}

async function resolveRuntimeBinary(
  bb: BbPluginApi,
  configuredPath: string,
  signal: AbortSignal,
): Promise<string> {
  const environmentOverride = process.env.PLANNOTATOR_BIN?.trim();
  if (environmentOverride) {
    const external = resolvePlannotatorBinary(environmentOverride);
    if (!external) throw new Error(missingBinaryMessage(environmentOverride));
    return external;
  }

  // Preserve compatibility with the first adapter release, where the
  // default was the standalone `plannotator` command. Explicit paths remain
  // strict; only the old command name falls back to the bundled runtime.
  if (configuredPath !== BUNDLED_BINARY) {
    const external = resolvePlannotatorBinary(configuredPath, {
      ...process.env,
      PLANNOTATOR_BIN: "",
    });
    if (external) return external;
    if (configuredPath !== DEFAULT_BINARY && configuredPath !== "auto") {
      throw new Error(missingBinaryMessage(configuredPath));
    }
  }

  const systemConfig = await bb.sdk.system.config({ signal });
  try {
    return await ensureBundledPlannotatorBinary({
      runtimeDir: join(systemConfig.dataDir, "plugins", bb.pluginId, "runtime"),
      signal,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${missingBinaryMessage(BUNDLED_BINARY)} ${detail}`, {
      cause: error,
    });
  }
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    binaryPath: {
      type: "string",
      label: "Plannotator binary",
      description:
        `Use the bundled official runtime by default, or enter a path/command to override it. Set to \"${BUNDLED_BINARY}\" to restore the default.`,
      default: BUNDLED_BINARY,
    },
  });

  const activeReviews = new Map<string, ActiveReview>();
  const startingReviews = new Set<string>();
  const relaySessions = new Map<string, string>();
  const delivering = new Set<string>();
  let disposing = false;

  const reviewKey = (id: string) => `${REVIEW_KEY_PREFIX}${id}`;
  async function loadReview(id: string): Promise<StoredReview | null> {
    const parsed = storedReviewSchema.safeParse(await bb.storage.kv.get(reviewKey(id)));
    return parsed.success ? parsed.data : null;
  }

  async function deliverReview(record: StoredReview): Promise<void> {
    if (disposing || record.status !== "ready" || !record.result || delivering.has(record.id)) return;
    delivering.add(record.id);
    try {
      // A queued send waits for the current agent turn to finish. An idle
      // thread starts a new turn immediately. Both paths avoid a long tool call.
      await bb.sdk.threads.send({
        threadId: record.threadId,
        mode: "queue-if-active",
        input: [{ type: "text", text: reviewMessage(record.result), mentions: [] }],
      });
      await bb.storage.kv.set(reviewKey(record.id), {
        ...record,
        status: "delivered",
        updatedAt: Date.now(),
      } satisfies StoredReview);
    } catch (error) {
      bb.log.warn(`Could not deliver Plannotator review ${record.id}: ${String(error)}`);
    } finally {
      delivering.delete(record.id);
    }
  }

  async function recoverReviews(): Promise<void> {
    for (const key of await bb.storage.kv.list(REVIEW_KEY_PREFIX)) {
      if (disposing) return;
      const parsed = storedReviewSchema.safeParse(await bb.storage.kv.get(key));
      if (!parsed.success) {
        bb.log.warn(`Ignoring invalid Plannotator review record ${key}`);
        continue;
      }
      let record = parsed.data;
      if (record.status === "delivered") {
        if (Date.now() - record.updatedAt > DELIVERED_REVIEW_RETENTION_MS) {
          await bb.storage.kv.delete(key);
        }
        continue;
      }
      if (record.status === "pending") {
        if (activeReviews.get(record.threadId)?.sessionId === record.id) continue;
        await closeReviewPanel(bb, record.threadId, record.id);
        record = {
          ...record,
          status: "ready",
          result: {
            reviewId: record.id,
            source: "plannotator",
            decision: "cancelled",
            error: "The review ended when the Plannotator plugin restarted.",
          },
          updatedAt: Date.now(),
        };
        await bb.storage.kv.set(key, record);
      }
      await deliverReview(record);
    }
  }

  bb.background.service("review-delivery", {
    async start(signal) {
      while (!signal.aborted) {
        try {
          await recoverReviews();
        } catch (error) {
          if (!signal.aborted) bb.log.warn(`Could not recover Plannotator reviews: ${String(error)}`);
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, DELIVERY_RETRY_MS);
          signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
        });
      }
    },
  });

  async function settleReview(threadId: string, active: ActiveReview): Promise<void> {
    let result: ReviewResult;
    try {
      result = reviewResult(active.sessionId, await active.review.result);
    } catch (error) {
      result = {
        reviewId: active.sessionId,
        source: "plannotator",
        decision: "cancelled",
        ...(!active.cancelledByUser
          ? { error: error instanceof Error ? error.message : String(error) }
          : {}),
      };
    }
    relaySessions.delete(active.sessionId);
    await closeReviewPanel(bb, threadId, active.sessionId);
    try {
      await active.review.stop();
    } catch (error) {
      bb.log.warn(`Could not stop Plannotator review ${active.sessionId}: ${String(error)}`);
    }
    if (disposing || active.deleted) return;
    const record: StoredReview = {
      id: active.sessionId,
      threadId,
      status: "ready",
      result,
      updatedAt: Date.now(),
    };
    try {
      await bb.storage.kv.set(reviewKey(record.id), record);
    } catch (error) {
      bb.log.warn(`Could not save Plannotator decision ${record.id}: ${String(error)}`);
    }
    await deliverReview(record);
    if (activeReviews.get(threadId) === active) activeReviews.delete(threadId);
  }

  registerPlannotatorRelayRoutes(bb, relaySessions);

  bb.rpc.register(rpcContract, {
    async status() {
      const configuredPath = await getConfiguredPath(settings);
      return {
        configuredPath,
        binary:
          configuredPath === BUNDLED_BINARY
            ? null
          : resolvePlannotatorBinary(configuredPath),
      };
    },
    async getActiveReview({ threadId }) {
      return activeReviews.get(threadId)?.payload ?? null;
    },
    async cancelReview({ threadId, sessionId }) {
      const active = activeReviews.get(threadId);
      if (!active || active.sessionId !== sessionId) {
        return { cancelled: false };
      }
      active.cancelledByUser = true;
      await active.review.stop();
      return { cancelled: true };
    },
  });

  bb.agents.registerTool({
    name: "plannotator_review_plan",
    description:
      "Optionally open the upstream Plannotator plan-review UI in BB. Return a review ID; the decision arrives in a later thread message.",
    instructions:
      "Use this optional tool only when the user explicitly asks for Plannotator or a plan review. Pass the complete Markdown plan. The tool returns a pending review ID promptly: end your turn and wait for the Plannotator decision in a new message on this thread. Do not poll or claim approval while the review is pending. On approval, continue the original task. On requested changes, revise the plan. Cancellation is not approval. Native Plan mode remains separate and provider-controlled.",
    presentation: {
      label: {
        pending: "Waiting for Plannotator",
        completed: "Plannotator review opened",
      },
    },
    parameters: reviewToolParametersSchema,
    async execute(params, context) {
      if (activeReviews.has(context.threadId) || startingReviews.has(context.threadId)) {
        return errorResponse("A Plannotator review is already active in this thread.");
      }
      startingReviews.add(context.threadId);

      let configuredPath: string;
      try {
        configuredPath = await getConfiguredPath(settings);
      } catch (error) {
        startingReviews.delete(context.threadId);
        return errorResponse(error instanceof Error ? error.message : String(error));
      }
      let binaryPath: string;
      try {
        binaryPath = await resolveRuntimeBinary(bb, configuredPath, context.signal);
      } catch (error) {
        startingReviews.delete(context.threadId);
        return errorResponse(error instanceof Error ? error.message : String(error));
      }

      const sessionId = randomUUID();
      const controller = new AbortController();
      const abortStartup = () => controller.abort();
      context.signal.addEventListener("abort", abortStartup, { once: true });
      let upstream: RunningUpstreamReview;
      try {
        const [origin, runtimeConfig] = await Promise.all([
          resolveUpstreamOrigin(bb, context.threadId, controller.signal),
          resolveUpstreamRuntimeConfig(bb, controller.signal),
        ]);
        upstream = await startUpstreamPlanReview({
          binaryPath,
          planMarkdown: params.planMarkdown,
          timeoutSeconds: null,
          signal: controller.signal,
          origin,
          dataDir: runtimeConfig.dataDir,
          remote: runtimeConfig.remote,
          embedHost: resolveEmbedHost(bb),
        });
      } catch (error) {
        context.signal.removeEventListener("abort", abortStartup);
        startingReviews.delete(context.threadId);
        return errorResponse(error instanceof Error ? error.message : String(error));
      }
      // The process can exit while the panel and stored review are opening.
      // Attach a rejection handler before any further awaits.
      void upstream.result.catch(() => undefined);

      const title = params.title?.trim() || "Plannotator review";
      const payload = interactionPayloadSchema.parse({
        kind: "plannotator",
        sessionId,
        threadId: context.threadId,
        sessionUrl: upstream.url,
        relayPath: PLANNOTATOR_RELAY_PATH,
        title,
      });
      relaySessions.set(sessionId, upstream.url);
      const active: ActiveReview = {
        sessionId, payload, review: upstream, controller,
        cancelledByUser: false, deleted: false,
      };
      activeReviews.set(context.threadId, active);
      startingReviews.delete(context.threadId);

      try {
        await openReviewPanel(bb, context.threadId, payload);
        if (context.signal.aborted || active.deleted || controller.signal.aborted) {
          throw new Error("Plannotator review was cancelled before opening");
        }
        await bb.storage.kv.set(reviewKey(sessionId), {
          id: sessionId,
          threadId: context.threadId,
          status: "pending",
          updatedAt: Date.now(),
        } satisfies StoredReview);
        bb.realtime.publish(PLANNOTATOR_REALTIME_CHANNEL, {
          kind: "review-opened",
          payload,
        });
        context.signal.removeEventListener("abort", abortStartup);
        active.settled = settleReview(context.threadId, active).catch((error) => {
          bb.log.error(`Could not settle Plannotator review ${sessionId}: ${String(error)}`);
        });
        return JSON.stringify({
          status: "pending",
          reviewId: sessionId,
          source: "plannotator",
          message: "End this turn. The review decision will arrive as a new message in this thread.",
        });
      } catch (error) {
        context.signal.removeEventListener("abort", abortStartup);
        activeReviews.delete(context.threadId);
        relaySessions.delete(sessionId);
        await Promise.allSettled([
          bb.storage.kv.delete(reviewKey(sessionId)),
          closeReviewPanel(bb, context.threadId, sessionId),
          upstream.stop(),
        ]);
        return errorResponse(error instanceof Error ? error.message : String(error));
      }
    },
  });

  bb.agents.registerTool({
    name: "plannotator_review_status",
    description: "Recover the status or decision of a Plannotator review in this thread. Do not poll while a review is pending.",
    parameters: z.object({ reviewId: z.string().uuid() }).strict(),
    async execute({ reviewId }, context) {
      const record = await loadReview(reviewId);
      if (!record || record.threadId !== context.threadId) {
        return JSON.stringify({ reviewId, status: "not_found" });
      }
      return JSON.stringify({
        reviewId,
        status: record.status,
        ...(record.result ? { result: record.result } : {}),
      });
    },
  });

  bb.agents.configure(() => ({
    tools: ["plannotator_review_plan", "plannotator_review_status"],
    skills: [],
  }));

  bb.events.on("thread.deleted", async ({ thread }) => {
    const active = activeReviews.get(thread.id);
    if (active) {
      // Remove the lookup before asynchronous cleanup starts. A deleted
      // thread must not be eligible for panel reconciliation while the
      // upstream process is winding down.
      activeReviews.delete(thread.id);
      active.deleted = true;
      active.controller.abort();
      await Promise.allSettled([
        closeReviewPanel(bb, thread.id, active.sessionId),
        active.review.stop(),
      ]);
      relaySessions.delete(active.sessionId);
      await bb.storage.kv.delete(reviewKey(active.sessionId));
    }
    for (const key of await bb.storage.kv.list(REVIEW_KEY_PREFIX)) {
      const parsed = storedReviewSchema.safeParse(await bb.storage.kv.get(key));
      if (parsed.success && parsed.data.threadId === thread.id) {
        await bb.storage.kv.delete(key);
      }
    }
  });

  bb.onDispose(async () => {
    disposing = true;
    await Promise.allSettled(
      [...activeReviews.entries()].map(async ([threadId, { sessionId, review, controller, settled }]) => {
        controller.abort();
        await Promise.allSettled([
          closeReviewPanel(bb, threadId, sessionId),
          review.stop(),
        ]);
        if (settled) await settled;
      }),
    );
    activeReviews.clear();
    startingReviews.clear();
    relaySessions.clear();
  });

  bb.log.info("loaded upstream Plannotator bridge");
}
