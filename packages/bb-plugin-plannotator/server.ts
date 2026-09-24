// BB's Plannotator integration is intentionally a bridge, not a second
// review product. The released upstream binary owns the plan renderer,
// annotations, history, and feedback formatting. BB only supplies the agent
// tool, embeds the upstream session, and keeps the provider tool call alive.
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
  WAIT_RENDERER_ID,
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
  cancelledByUser: boolean;
};

/** The host caps a composer form at one hour; the review itself has no deadline. */
const WAIT_FORM_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * Keep a composer form open for the lifetime of the review. Opening it
 * detaches the tool call from the daemon's HTTP request, so a review longer
 * than that request's body timeout still reaches the agent as a late result.
 * Only an explicit dismissal by the user cancels the review.
 */
function holdReviewOpen(
  bb: BbPluginApi,
  args: { threadId: string; sessionId: string; title: string; signal: AbortSignal },
  onUserCancel: () => void,
): void {
  let waiting: ReturnType<BbPluginApi["ui"]["requestInput"]>;
  try {
    waiting = bb.ui.requestInput(
      {
        threadId: args.threadId,
        rendererId: WAIT_RENDERER_ID,
        title: args.title,
        payload: { sessionId: args.sessionId, title: args.title },
        timeoutMs: WAIT_FORM_TIMEOUT_MS,
      },
      { signal: args.signal },
    );
  } catch (error) {
    waiting = Promise.reject(error);
  }
  void waiting.then(
    (result) => {
      if (result.outcome === "cancelled" && result.reason === "user") onUserCancel();
    },
    (error: unknown) => {
      if (args.signal.aborted) return;
      bb.log.warn(
        `Plannotator review is waiting in-band; the composer form did not open: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    },
  );
}

/**
 * Map BB's provider ids to the identities the upstream UI knows how to name.
 * The child must not infer this from ambient OPENCODE/CODEX_* environment
 * variables: BB is the owner of the waiting tool call.
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

function toolResponse(decision: UpstreamDecision): string {
  return JSON.stringify({
    decision: decisionLabel(decision),
    source: "plannotator",
    ...(decision.feedback ? { feedback: decision.feedback } : {}),
    ...(decision.savedPath ? { savedPath: decision.savedPath } : {}),
    ...(decision.agentSwitch ? { agentSwitch: decision.agentSwitch } : {}),
  });
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
  const relaySessions = new Map<string, string>();

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
      "Optionally open the upstream Plannotator plan-review UI in BB and return its decision or feedback.",
    instructions:
      "This is an optional tool, not an authorization gate. Use it only when the user explicitly asks for Plannotator or a plan review; never require it before editing, and proceed normally when it is not used. Native Plan mode is separate and remains provider-controlled. When invoked, pass the complete Markdown plan and report the returned decision or feedback; a cancelled review does not block implementation.",
    presentation: {
      label: {
        pending: "Waiting for Plannotator",
        completed: "Plannotator review completed",
      },
    },
    parameters: reviewToolParametersSchema,
    async execute(params, context) {
      if (activeReviews.has(context.threadId)) {
        return errorResponse("A Plannotator review is already active in this thread.");
      }

      const configuredPath = await getConfiguredPath(settings);
      let binaryPath: string;
      try {
        binaryPath = await resolveRuntimeBinary(bb, configuredPath, context.signal);
      } catch (error) {
        return errorResponse(error instanceof Error ? error.message : String(error));
      }

      const sessionId = randomUUID();
      let upstream: RunningUpstreamReview;
      try {
        const [origin, runtimeConfig] = await Promise.all([
          resolveUpstreamOrigin(bb, context.threadId, context.signal),
          resolveUpstreamRuntimeConfig(bb, context.signal),
        ]);
        upstream = await startUpstreamPlanReview({
          binaryPath,
          planMarkdown: params.planMarkdown,
          timeoutSeconds: null,
          signal: context.signal,
          origin,
          dataDir: runtimeConfig.dataDir,
          remote: runtimeConfig.remote,
          embedHost: resolveEmbedHost(bb),
        });
      } catch (error) {
        return errorResponse(error instanceof Error ? error.message : String(error));
      }

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
        sessionId,
        payload,
        review: upstream,
        cancelledByUser: false,
      };
      activeReviews.set(context.threadId, active);
      const waitForm = new AbortController();

      try {
        await openReviewPanel(bb, context.threadId, payload);
        bb.realtime.publish(PLANNOTATOR_REALTIME_CHANNEL, {
          kind: "review-opened",
          payload,
        });
        holdReviewOpen(
          bb,
          {
            threadId: context.threadId,
            sessionId,
            title,
            signal: AbortSignal.any([context.signal, waitForm.signal]),
          },
          () => {
            active.cancelledByUser = true;
            void upstream.stop();
          },
        );
        return toolResponse(await upstream.result);
      } catch (error) {
        if (active.cancelledByUser) return toolResponse({ approved: false });
        return errorResponse(error instanceof Error ? error.message : String(error));
      } finally {
        waitForm.abort();
        activeReviews.delete(context.threadId);
        relaySessions.delete(sessionId);
        await closeReviewPanel(bb, context.threadId, sessionId);
        await upstream.stop();
      }
    },
  });

  bb.agents.configure(() => ({
    tools: ["plannotator_review_plan"],
    skills: [],
  }));

  bb.events.on("thread.deleted", ({ thread }) => {
    const active = activeReviews.get(thread.id);
    if (active) {
      // Remove the lookup before asynchronous cleanup starts. A deleted
      // thread must not be eligible for panel reconciliation while the
      // upstream process is winding down.
      activeReviews.delete(thread.id);
      void Promise.all([
        closeReviewPanel(bb, thread.id, active.sessionId),
        active.review.stop(),
      ]);
      relaySessions.delete(active.sessionId);
    }
  });

  bb.onDispose(async () => {
    await Promise.all(
      [...activeReviews.entries()].map(([threadId, { sessionId, review }]) =>
        Promise.all([
          closeReviewPanel(bb, threadId, sessionId),
          review.stop(),
        ]),
      ),
    );
    activeReviews.clear();
    relaySessions.clear();
  });

  bb.log.info("loaded upstream Plannotator bridge");
}
