import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { ChecklistStore, migrations } from "./src/store";
import {
  checklistStatuses,
  continuationModes,
  hasIncompleteSteps,
  nextStep,
  userSettableChecklistStatuses,
  type Checklist,
  type ContinuationMode,
} from "./src/types";

const REALTIME_CHANNEL = "checklists";
const DEFAULT_MAX_CONTINUATIONS = 8;

const modeSchema = z.enum(continuationModes);
const statusSchema = z.enum(checklistStatuses);
const userSettableStatusSchema = z.enum(userSettableChecklistStatuses);

const templateStepSchema = z
  .object({
    id: z.string(),
    position: z.number().int().nonnegative(),
    title: z.string(),
    description: z.string(),
  })
  .strict();

const templateStepInputSchema = z
  .object({
    id: z.string().min(1).optional(),
    title: z.string().trim().min(1).max(500),
    description: z.string().trim().max(2_000),
  })
  .strict();

const templateSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    defaultMode: modeSchema,
    steps: z.array(templateStepSchema),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .strict();

const checklistStepSchema = z
  .object({
    id: z.string(),
    templateStepId: z.string(),
    position: z.number().int().nonnegative(),
    title: z.string(),
    description: z.string(),
    checked: z.boolean(),
    note: z.string().nullable(),
    evidence: z.string().nullable(),
    checkedAt: z.number().nullable(),
    updatedAt: z.number(),
  })
  .strict();

const checklistNoteSchema = z
  .object({
    id: z.string(),
    stepId: z.string().nullable(),
    content: z.string(),
    createdAt: z.number(),
  })
  .strict();

const checklistSchema = z
  .object({
    id: z.string(),
    templateId: z.string(),
    threadId: z.string(),
    name: z.string(),
    description: z.string(),
    status: statusSchema,
    continuationMode: modeSchema,
    continuationCount: z.number().int().nonnegative(),
    maxContinuations: z.number().int().positive(),
    lastReminderAt: z.number().nullable(),
    lastError: z.string().nullable(),
    createdAt: z.number(),
    updatedAt: z.number(),
    steps: z.array(checklistStepSchema),
    notes: z.array(checklistNoteSchema),
  })
  .strict();

const threadIdInput = z.object({ threadId: z.string().min(1) }).strict();
const checklistIdInput = z.object({ checklistId: z.string().min(1) }).strict();

const updateSettingsInput = z
  .object({
    checklistId: z.string().min(1),
    continuationMode: modeSchema.optional(),
    status: userSettableStatusSchema.optional(),
  })
  .strict()
  .refine(
    (input) => input.continuationMode !== undefined || input.status !== undefined,
    "Provide a continuation mode or status.",
  );

const attachInput = z
  .object({
    threadId: z.string().min(1),
    templateId: z.string().min(1),
    continuationMode: modeSchema.optional(),
  })
  .strict();

const saveTemplateInput = z
  .object({
    templateId: z.string().trim().min(1).nullable().optional(),
    expectedUpdatedAt: z.number().int().nonnegative().optional(),
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2_000),
    defaultMode: modeSchema,
    steps: z.array(templateStepInputSchema).min(1).max(100),
  })
  .strict()
  .refine(
    (input) => input.templateId == null || input.expectedUpdatedAt !== undefined,
    "An expected revision is required when editing a checklist",
  );

const deleteTemplateInput = z
  .object({
    templateId: z.string().min(1),
    expectedUpdatedAt: z.number().int().nonnegative(),
  })
  .strict();

const agentUpdateInput = z
  .object({
    stepId: z.string().min(1).optional(),
    checked: z.boolean().optional(),
    note: z.string().max(10_000).optional(),
    evidence: z.string().max(10_000).optional(),
    status: z.enum(["active", "paused"]).optional(),
  })
  .strict()
  .refine(
    (input) =>
      input.stepId !== undefined ||
      input.checked !== undefined ||
      input.note !== undefined ||
      input.evidence !== undefined ||
      input.status !== undefined,
    "Provide a step update, note, evidence, or status.",
  )
  .refine(
    (input) => input.checked === undefined || input.stepId !== undefined,
    "A step ID is required when changing a checkbox.",
  )
  .refine(
    (input) =>
      input.stepId === undefined ||
      input.checked !== undefined ||
      input.note !== undefined ||
      input.evidence !== undefined,
    "Provide a checkbox, note, or evidence change for the step.",
  );

export const rpcContract = defineRpcContract({
  listTemplates: {
    input: z.null(),
    output: z.object({ templates: z.array(templateSchema) }).strict(),
  },
  getForThread: {
    input: threadIdInput,
    output: z.object({ checklist: checklistSchema.nullable() }).strict(),
  },
  attach: {
    input: attachInput,
    output: checklistSchema,
  },
  pickTemplate: {
    input: threadIdInput,
    output: z.object({ templateId: z.string().nullable() }).strict(),
  },
  detach: {
    input: checklistIdInput,
    output: z.object({ detached: z.boolean() }).strict(),
  },
  close: {
    input: checklistIdInput,
    output: checklistSchema,
  },
  saveTemplate: {
    input: saveTemplateInput,
    output: templateSchema,
  },
  deleteTemplate: {
    input: deleteTemplateInput,
    output: z.object({ deleted: z.boolean() }).strict(),
  },
  updateSettings: {
    input: updateSettingsInput,
    output: checklistSchema,
  },
  continue: {
    input: checklistIdInput,
    output: z
      .object({
        sent: z.boolean(),
        checklist: checklistSchema.nullable(),
      })
      .strict(),
  },
  resume: {
    input: checklistIdInput,
    output: checklistSchema,
  },
});

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingThreadError(error: unknown): boolean {
  const message = errorText(error).toLowerCase();
  return message.includes("thread not found") || message.includes("thread_not_found");
}

function isUnavailableThread(thread: { archivedAt: number | null; deletedAt: number | null }): boolean {
  return thread.archivedAt !== null || thread.deletedAt !== null;
}

function publish(bb: BbPluginApi, checklist: Checklist | null): void {
  if (!checklist) return;
  bb.realtime.publish(REALTIME_CHANNEL, {
    checklistId: checklist.id,
    threadId: checklist.threadId,
    updatedAt: checklist.updatedAt,
  });
}

function publishTemplate(bb: BbPluginApi, templateId: string): void {
  bb.realtime.publish(REALTIME_CHANNEL, {
    templateId,
    updatedAt: Date.now(),
  });
}

function publishDetached(bb: BbPluginApi, checklist: Checklist): void {
  bb.realtime.publish(REALTIME_CHANNEL, {
    checklistId: checklist.id,
    threadId: checklist.threadId,
    detached: true,
    updatedAt: Date.now(),
  });
}

function reminderText(checklist: Checklist): string {
  const next = nextStep(checklist);
  const complete = checklist.steps.filter((step) => step.checked).length;
  const total = checklist.steps.length;
  const remaining = total - complete;
  return [
    "Checklist continuation",
    `BB resumed this thread because the attached Checklist "${checklist.name}" is still incomplete (${complete} of ${total} steps complete; ${remaining} remaining). This is not a new user request. Do not stop merely because the previous turn became idle.`,
    next
      ? `Continue the current task from the next unchecked step: "${next.title}".${next.description ? `\n${next.description}` : ""}`
      : "The checklist has no remaining unchecked steps; verify its state with agent_checklist_get before stopping.",
    "Call agent_checklist_get if you need the full current state. After completing the step, call agent_checklist_update with checked: true. If user input or an external dependency blocks progress, leave the step unchecked and add a note.",
  ].join("\n\n");
}

async function reconcilePersistedThreads(bb: BbPluginApi, store: ChecklistStore): Promise<void> {
  await Promise.all(
    store.listAttachedThreadIds().map(async (threadId) => {
      try {
        const thread = await bb.sdk.threads.get({ threadId });
        if (isUnavailableThread(thread)) store.markOrphaned(threadId);
      } catch (error) {
        if (isMissingThreadError(error)) {
          store.markOrphaned(threadId);
        } else {
          bb.log.warn(`Could not reconcile Checklist thread ${threadId}: ${errorText(error)}`);
        }
      }
    }),
  );
}

async function sendContinuation(
  bb: BbPluginApi,
  store: ChecklistStore,
  checklistId: string,
  manual: boolean,
  canSend: (claimed: Checklist, manual: boolean) => boolean,
): Promise<{ sent: boolean; checklist: Checklist | null }> {
  const claimed = store.claimContinuation(checklistId, manual);
  if (!claimed) {
    return { sent: false, checklist: claimed };
  }
  if (claimed.status === "limit_reached" || !hasIncompleteSteps(claimed)) {
    publish(bb, claimed);
    return { sent: false, checklist: claimed };
  }

  let thread;
  try {
    thread = await bb.sdk.threads.get({ threadId: claimed.threadId });
  } catch (error) {
    if (isMissingThreadError(error)) {
      const orphaned = store.markOrphaned(claimed.threadId);
      const released = store.releaseContinuationClaim(
        claimed.id,
        claimed.lastReminderAt,
        "The attached thread became unavailable before the reminder was delivered.",
      );
      publish(bb, released ?? orphaned);
      return { sent: false, checklist: released ?? orphaned };
    }
    const paused = store.releaseContinuationClaim(
      claimed.id,
      claimed.lastReminderAt,
      errorText(error),
    );
    publish(bb, paused);
    throw error;
  }
  if (isUnavailableThread(thread)) {
    const orphaned = store.markOrphaned(claimed.threadId);
    const released = store.releaseContinuationClaim(
      claimed.id,
      claimed.lastReminderAt,
      "The attached thread became unavailable before the reminder was delivered.",
    );
    publish(bb, released ?? orphaned);
    return { sent: false, checklist: released ?? orphaned };
  }
  if (thread.status !== "idle") {
    const released = store.cancelContinuationClaim(claimed.id, claimed.lastReminderAt);
    publish(bb, released);
    return { sent: false, checklist: released };
  }
  if (!canSend(claimed, manual)) {
    const released = store.cancelContinuationClaim(
      claimed.id,
      claimed.lastReminderAt,
    );
    publish(bb, released);
    return { sent: false, checklist: released };
  }

  // Once the host send has started, BB may still deliver that in-flight
  // reminder after a close or other lifecycle change. The version and claim
  // guards below settle it without allowing any follow-up continuation.
  try {
    await bb.sdk.threads.send({
      threadId: claimed.threadId,
      mode: "auto",
      input: [
        {
          type: "text",
          text: reminderText(claimed),
          visibility: "agent-only",
          mentions: [],
        },
      ],
    });
  } catch (error) {
    const paused = canSend(claimed, manual)
      ? store.releaseContinuationClaim(claimed.id, claimed.lastReminderAt, errorText(error))
      : store.cancelContinuationClaim(claimed.id, claimed.lastReminderAt);
    publish(bb, paused);
    throw error;
  }
  if (!canSend(claimed, manual)) {
    const updated = store.completeContinuationClaim(claimed.id, claimed.lastReminderAt);
    publish(bb, updated);
    return { sent: true, checklist: updated };
  }
  store.completeContinuationClaim(claimed.id, claimed.lastReminderAt);
  const updated = store.getChecklist(claimed.id);
  publish(bb, updated);
  return { sent: true, checklist: updated };
}

function parseMaxContinuations(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 100) : DEFAULT_MAX_CONTINUATIONS;
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    maxContinuations: {
      type: "string",
      label: "Maximum automatic continuations",
      description: "Stops an automatic checklist after this many reminders until you resume it.",
      default: String(DEFAULT_MAX_CONTINUATIONS),
    },
  });

  const db = bb.storage.database();
  db.pragma("foreign_keys = ON");
  bb.storage.migrate(db, migrations);
  const store = new ChecklistStore(db);
  store.retireBuiltInTemplates();
  store.recoverInterruptedContinuationClaims();
  await reconcilePersistedThreads(bb, store);
  const continuationTasks = new Map<
    string,
    {
      manual: boolean;
      version: number;
      promise: Promise<{ sent: boolean; checklist: Checklist | null }>;
    }
  >();
  const recentContinuationResults = new Map<
    string,
    {
      version: number;
      result: { sent: boolean; checklist: Checklist | null };
    }
  >();
  const threadLifecycleVersions = new Map<string, number>();

  const lifecycleVersion = (threadId: string): number =>
    threadLifecycleVersions.get(threadId) ?? 0;

  const bumpThreadVersion = (threadId: string): void => {
    threadLifecycleVersions.set(threadId, lifecycleVersion(threadId) + 1);
  };

  const markThreadUnavailable = (threadId: string): Checklist | null => {
    bumpThreadVersion(threadId);
    const checklist = store.getChecklistForThread(threadId);
    if (checklist) recentContinuationResults.delete(checklist.id);
    return store.markOrphaned(threadId);
  };

  const guardedSendContinuation = async (
    checklistId: string,
    manual: boolean,
  ): Promise<{ sent: boolean; checklist: Checklist | null }> => {
    while (true) {
      const current = store.getChecklist(checklistId);
      const version = current ? lifecycleVersion(current.threadId) : 0;
      const existing = continuationTasks.get(checklistId);
      if (!existing) break;
      if (existing.manual === manual && existing.version === version) {
        return existing.promise;
      }
      const existingResult = await existing.promise.catch(() => null);
      if (continuationTasks.get(checklistId) === existing) {
        continuationTasks.delete(checklistId);
      }
      if (existingResult?.sent) {
        recentContinuationResults.delete(checklistId);
        return { ...existingResult, checklist: store.getChecklist(checklistId) };
      }
    }

    const current = store.getChecklist(checklistId);
    const version = current ? lifecycleVersion(current.threadId) : 0;
    const task = sendContinuation(
      bb,
      store,
      checklistId,
      manual,
      (claimed, claimIsManual) => {
        if (lifecycleVersion(claimed.threadId) !== version) return false;
        const latest = store.getChecklist(claimed.id);
        return Boolean(
          latest &&
            latest.threadId === claimed.threadId &&
            latest.status === "active" &&
            latest.lastReminderAt === claimed.lastReminderAt &&
            hasIncompleteSteps(latest) &&
            latest.continuationMode === (claimIsManual ? "approval" : "automatic"),
        );
      },
    );
    const entry = { manual, version, promise: task };
    continuationTasks.set(checklistId, entry);
    const cleanup = () => {
      if (continuationTasks.get(checklistId) === entry) {
        continuationTasks.delete(checklistId);
      }
    };
    void task.then(
      (result) => {
        cleanup();
        if (result.sent) recentContinuationResults.set(checklistId, { version, result });
      },
      cleanup,
    );
    return task;
  };

  const continueIfIdle = async (
    checklist: Checklist,
    retryAfterInFlight = true,
    consumeRecentDelivery = false,
  ): Promise<Checklist> => {
    let thread;
    try {
      thread = await bb.sdk.threads.get({ threadId: checklist.threadId });
    } catch (error) {
      if (isMissingThreadError(error)) {
        const orphaned = markThreadUnavailable(checklist.threadId);
        publish(bb, orphaned);
        return orphaned ?? checklist;
      }
      bb.log.warn(`Could not check checklist thread before re-enabling continuation: ${errorText(error)}`);
      return checklist;
    }
    if (isUnavailableThread(thread)) {
      const orphaned = markThreadUnavailable(checklist.threadId);
      publish(bb, orphaned);
      return orphaned ?? checklist;
    }
    if (thread.status !== "idle") return checklist;
    if (consumeRecentDelivery) {
      const recent = recentContinuationResults.get(checklist.id);
      if (recent && recent.version !== lifecycleVersion(checklist.threadId)) {
        recentContinuationResults.delete(checklist.id);
        return store.getChecklist(checklist.id) ?? checklist;
      }
    }
    if (checklist.continuationMode === "approval") {
      const inFlight = continuationTasks.get(checklist.id);
      let inFlightResult: { sent: boolean; checklist: Checklist | null } | null = null;
      if (inFlight) {
        inFlightResult = await inFlight.promise.catch(() => null);
        if (continuationTasks.get(checklist.id) === inFlight) {
          continuationTasks.delete(checklist.id);
        }
      }
      const latest = store.getChecklist(checklist.id);
      if (inFlightResult?.sent) {
        recentContinuationResults.delete(checklist.id);
        publish(bb, latest);
        return latest ?? checklist;
      }
      if (
        !latest ||
        latest.status !== "active" ||
        latest.continuationMode !== "approval" ||
        !hasIncompleteSteps(latest)
      ) {
        return latest ?? checklist;
      }
      const awaiting = store.markAwaitingApproval(latest.id);
      publish(bb, awaiting);
      return awaiting ?? latest;
    }
    if (checklist.continuationMode !== "automatic") return checklist;
    const result = await guardedSendContinuation(checklist.id, false);
    if (!result.sent && retryAfterInFlight) {
      const latest = store.getChecklist(checklist.id);
      if (
        latest?.status === "active" &&
        hasIncompleteSteps(latest) &&
        latest.continuationMode === "automatic"
      ) {
        return continueIfIdle(latest, false);
      }
    }
    return result.checklist ?? checklist;
  };

  bb.rpc.register(rpcContract, {
    listTemplates() {
      return { templates: store.listTemplates() };
    },
    getForThread({ threadId }) {
      return { checklist: store.getChecklistForThread(threadId) };
    },
    async attach({ threadId, templateId, continuationMode }) {
      const lifecycleBeforeLookup = lifecycleVersion(threadId);
      const configured = await settings.get();
      const thread = await bb.sdk.threads.get({ threadId });
      if (
        isUnavailableThread(thread) ||
        lifecycleVersion(threadId) !== lifecycleBeforeLookup
      ) {
        throw new Error("Cannot attach a checklist to an archived or deleted thread");
      }
      const checklist = store.createChecklist(
        threadId,
        templateId,
        continuationMode,
        parseMaxContinuations(configured.maxContinuations),
      );
      publish(bb, checklist);
      return checklist;
    },
    async pickTemplate({ threadId }) {
      const templates = store.listTemplates().map((template) => ({
        id: template.id,
        name: template.name,
      }));
      const result = await bb.ui.requestInput({
        threadId,
        rendererId: "agent-checklist-picker",
        title: "Checklist",
        payload: { templates },
        timeoutMs: 300_000,
      });
      if (result.outcome === "cancelled") return { templateId: null };
      const value = result.value as { templateId?: unknown };
      return {
        templateId: typeof value?.templateId === "string" ? value.templateId : null,
      };
    },
    async detach({ checklistId }) {
      const current = store.getChecklist(checklistId);
      if (!current) throw new Error("Checklist not found");
      bumpThreadVersion(current.threadId);
      const continuation = continuationTasks.get(checklistId);
      if (continuation) await continuation.promise.catch(() => undefined);
      continuationTasks.delete(checklistId);
      recentContinuationResults.delete(checklistId);
      const latest = store.getChecklist(checklistId);
      if (!latest) return { detached: true };
      store.detachChecklist(checklistId);
      publishDetached(bb, latest);
      return { detached: true };
    },
    close({ checklistId }) {
      const current = store.getChecklist(checklistId);
      if (!current) throw new Error("Checklist not found");
      bumpThreadVersion(current.threadId);
      const closed = store.closeChecklist(checklistId);
      recentContinuationResults.delete(checklistId);
      publish(bb, closed);
      return closed;
    },
    saveTemplate(input) {
      const template = store.saveTemplate(input);
      publishTemplate(bb, template.id);
      return template;
    },
    deleteTemplate({ templateId, expectedUpdatedAt }) {
      store.deleteTemplate(templateId, expectedUpdatedAt);
      publishTemplate(bb, templateId);
      return { deleted: true };
    },
    async updateSettings(input) {
      const current = store.getChecklist(input.checklistId);
      const checklist = store.updateSettings(input.checklistId, input);
      bumpThreadVersion(checklist.threadId);
      const shouldContinue =
        checklist.status === "active" &&
        hasIncompleteSteps(checklist) &&
        (input.status === "active" ||
          (input.continuationMode !== undefined &&
            input.continuationMode !== current?.continuationMode));
      const updated = shouldContinue ? await continueIfIdle(checklist, true, true) : checklist;
      publish(bb, updated);
      return updated;
    },
    async continue({ checklistId }) {
      const current = store.getChecklist(checklistId);
      if (!current) throw new Error("Checklist not found");
      if (current.status === "closed") {
        throw new Error("This Checklist is closed");
      }
      const result = await guardedSendContinuation(checklistId, true);
      return result;
    },
    async resume({ checklistId }) {
      const checklist = store.resumeAfterLimit(checklistId);
      bumpThreadVersion(checklist.threadId);
      const updated =
        checklist.status === "active" &&
        (checklist.continuationMode === "automatic" || checklist.continuationMode === "approval") &&
        hasIncompleteSteps(checklist)
          ? await continueIfIdle(checklist)
          : checklist;
      publish(bb, updated);
      return updated;
    },
  });

  bb.agents.registerTool({
    name: "agent_checklist_get",
    description: "Read the persisted Checklist attached to the current BB thread.",
    instructions:
      "Read the checklist before starting work and after major progress. Use the structured checkbox state, not Markdown, as the source of truth.",
    presentation: {
      label: {
        pending: "Reading Checklist",
        completed: "Checklist read",
      },
    },
    parameters: z.object({}).strict(),
    execute(_input, context) {
      const checklist = store.getChecklistForThread(context.threadId);
      if (!checklist) {
        return JSON.stringify({ checklist: null, message: "No Checklist is attached to this thread." });
      }
      return JSON.stringify({ checklist });
    },
  });

  bb.agents.registerTool({
    name: "agent_checklist_update",
    description: "Update a step, note, evidence, or pause state in the current thread's Checklist.",
    instructions:
      "Check a step when it is complete. Add notes or evidence when useful. If user input or an external dependency blocks progress, leave the step unchecked and add a note, then pause the checklist.",
    presentation: {
      label: {
        pending: "Updating Checklist",
        completed: "Checklist updated",
      },
    },
    parameters: agentUpdateInput,
    execute(input, context) {
      const checklist = store.getChecklistForThread(context.threadId);
      if (!checklist) {
        return JSON.stringify({ checklist: null, message: "No Checklist is attached to this thread." });
      }
      const updated = store.applyAgentUpdate(checklist.id, input);
      bumpThreadVersion(updated.threadId);
      recentContinuationResults.delete(updated.id);
      publish(bb, updated);
      return JSON.stringify({ checklist: updated });
    },
  });

  // Resolved per thread at every thread.start / turn.submit. A thread without an
  // attached Checklist gets no checklist tools, so neither the tools nor their
  // registered `instructions` reach the model. The store is read on every
  // resolution, so attach, detach, and replacement take effect on the next turn
  // without a plugin reload or a cached copy.
  bb.agents.configure(({ thread }) =>
    store.getChecklistForThread(thread.id)
      ? {
          tools: ["agent_checklist_get", "agent_checklist_update"],
          skills: [],
          instructions:
            "A Checklist is attached to this thread. Use its tools to read the steps and persist checkbox updates, notes, and evidence as you work.",
        }
      : { tools: [], skills: [] },
  );

  bb.events.on("thread.idle", ({ thread }) => {
    void (async () => {
      const checklist = store.getChecklistForThread(thread.id);
      if (checklist) recentContinuationResults.delete(checklist.id);
      if (!checklist || !hasIncompleteSteps(checklist) || checklist.status !== "active") return;
      if (checklist.continuationMode === "automatic") {
        await guardedSendContinuation(checklist.id, false);
      } else if (checklist.continuationMode === "approval") {
        const awaiting = store.markAwaitingApproval(checklist.id);
        publish(bb, awaiting);
      }
    })().catch((error) => {
      bb.log.error(`Automatic checklist continuation failed: ${errorText(error)}`);
    });
  });

  bb.events.on("thread.archived", ({ thread }) => publish(bb, markThreadUnavailable(thread.id)));
  bb.events.on("thread.deleted", ({ thread }) => publish(bb, markThreadUnavailable(thread.id)));
}
