import { createRequire } from "node:module";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

// Load the CJS parser as a unit. BB's source loader otherwise splits its
// circular field exports and a valid cron expression fails at runtime.
const { CronExpressionParser } = createRequire(import.meta.url)("cron-parser") as typeof import("cron-parser");

const triggerSchema = z.discriminatedUnion("triggerType", [
  z.object({ triggerType: z.literal("once"), runAt: z.number() }),
  z.object({ triggerType: z.literal("schedule"), cron: z.string(), timezone: z.string() }),
]);
const automationSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  trigger: triggerSchema,
  execution: z.object({ mode: z.enum(["agent", "script"]) }).passthrough(),
  nextRunAt: z.number().nullable(),
  lastRunAt: z.number().nullable(),
  lastRunStatus: z.enum(["running", "succeeded", "failed", "skipped"]).nullable(),
  runCount: z.number(),
  createdAt: z.number(),
});
const overviewSchema = z.object({
  automations: z.array(z.object({
    project: z.object({ id: z.string(), name: z.string() }),
    automation: z.object({ id: z.string(), projectId: z.string(), name: z.string() }).passthrough(),
  })),
});
const itemSchema = z.object({
  automation: automationSchema,
  project: z.object({ id: z.string(), name: z.string() }),
});
const occurrenceSchema = z.object({
  automationId: z.string(),
  projectId: z.string(),
  at: z.number(),
});

export type CalendarItem = z.infer<typeof itemSchema>;
export type CalendarOccurrence = z.infer<typeof occurrenceSchema>;

export const rpcContract = defineRpcContract({
  calendar_month: {
    input: z.object({ startAt: z.number().int(), endAt: z.number().int() }),
    output: z.object({
      items: z.array(itemSchema),
      occurrences: z.array(occurrenceSchema),
    }),
  },
  calendar_action: {
    input: z.object({
      projectId: z.string().min(1),
      automationId: z.string().min(1),
      action: z.enum(["pause", "resume", "run"]),
    }),
    output: z.object({ ok: z.literal(true) }),
  },
});

const MAX_RANGE_MS = 45 * 24 * 60 * 60 * 1000;
const MAX_OCCURRENCES_PER_AUTOMATION = 1000;

export function projectOccurrences(
  items: CalendarItem[],
  startAt: number,
  endAt: number,
): CalendarOccurrence[] {
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt || endAt - startAt > MAX_RANGE_MS) {
    throw new Error("Choose a calendar range of at most 45 days.");
  }
  const result: CalendarOccurrence[] = [];
  for (const { automation } of items) {
    const base = { automationId: automation.id, projectId: automation.projectId };
    if (automation.trigger.triggerType === "once") {
      const at = automation.trigger.runAt;
      if (at >= startAt && at < endAt) result.push({ ...base, at });
      continue;
    }
    try {
      const iterator = CronExpressionParser.parse(automation.trigger.cron, {
        currentDate: new Date(Math.max(startAt - 60_000, automation.createdAt - 60_000)),
        endDate: new Date(endAt - 1),
        tz: automation.trigger.timezone,
      });
      for (let count = 0; count < MAX_OCCURRENCES_PER_AUTOMATION; count += 1) {
        const at = iterator.next().getTime();
        if (at >= endAt) break;
        if (at >= startAt && at >= automation.createdAt) result.push({ ...base, at });
      }
    } catch {
      // A damaged stored schedule still appears in the project filter and detail view.
    }
  }
  return result.sort((a, b) => a.at - b.at || a.automationId.localeCompare(b.automationId));
}

export default function plugin(bb: BbPluginApi) {
  const callAutomations = <T>(method: string, input: unknown, outputSchema: z.ZodType<T>) =>
    bb.sdk.plugins.callRpc({
      pluginId: "automations",
      method: `automations_${method}`,
      input: input as never,
      outputSchema,
    });

  bb.rpc.register(rpcContract, {
    calendar_month: async ({ startAt, endAt }) => {
      if (endAt <= startAt || endAt - startAt > MAX_RANGE_MS) {
        throw new Error("Choose a calendar range of at most 45 days.");
      }
      const overview = await callAutomations("overview", null, overviewSchema);
      const items = overview.automations.flatMap((entry) => {
        const parsed = automationSchema.safeParse(entry.automation);
        return parsed.success ? [{ automation: parsed.data, project: entry.project }] : [];
      });
      return { items, occurrences: projectOccurrences(items, startAt, endAt) };
    },
    calendar_action: async ({ projectId, automationId, action }) => {
      await callAutomations(action, { projectId, automationId }, z.unknown());
      return { ok: true as const };
    },
  });
}
