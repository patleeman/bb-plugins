import { z } from "zod";

export const channelSchedule = z.discriminatedUnion("triggerType", [
  z
    .object({
      triggerType: z.literal("schedule"),
      cron: z.string().trim().min(1).max(256),
      timezone: z.string().trim().min(1).max(100),
    })
    .strict(),
  z
    .object({
      triggerType: z.literal("once"),
      runAt: z.number().int().positive(),
    })
    .strict(),
]);
const channel = { channelId: z.string().uuid().optional() };
const fields = {
  name: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(8000),
  trigger: channelSchedule,
};
export const channelAutomationCreate = z
  .object({
    ...channel,
    ...fields,
    botId: z
      .string()
      .regex(/^bot_[a-f0-9]{16}$/)
      .optional(),
    requestId: z.string().uuid(),
    enabled: z.boolean().default(true),
  })
  .strict();
export const channelAutomationList = z
  .object({
    ...channel,
    limit: z.number().int().min(1).max(50).default(20),
    offset: z.number().int().min(0).default(0),
  })
  .strict();
export const channelAutomationUpdate = z
  .object({
    ...channel,
    automationId: z.string().min(1),
    name: fields.name.optional(),
    prompt: fields.prompt.optional(),
    trigger: fields.trigger.optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.name !== undefined || v.prompt !== undefined || v.trigger !== undefined,
    "Provide a name, prompt, or schedule to update.",
  );
export const channelAutomationAction = z
  .object({
    ...channel,
    automationId: z.string().min(1),
    action: z.enum(["pause", "resume", "run", "delete"]),
    requestId: z.string().uuid().optional(),
  })
  .strict()
  .refine(
    (v) => v.action !== "run" || !!v.requestId,
    "Run requires a requestId for safe retries.",
  );
export const channelAutomationView = z.object({
  id: z.string(),
  projectId: z.string(),
  channelId: z.string(),
  botId: z.string(),
  name: z.string(),
  prompt: z.string(),
  enabled: z.boolean(),
  trigger: channelSchedule,
  nextRunAt: z.number().nullable(),
  lastRunAt: z.number().nullable(),
  lastRunStatus: z.string().nullable(),
  lastError: z.string().nullable(),
});
export type ChannelAutomation = z.infer<typeof channelAutomationView>;
export const channelAutomationRuns = z
  .object({
    ...channel,
    automationId: z.string().min(1),
    limit: z.number().int().min(1).max(20).default(10),
    cursor: z.string().min(1).optional(),
  })
  .strict();
export const channelAutomationRunPage = z.object({
  runs: z.array(
    z.object({
      id: z.string(),
      status: z.string(),
      trigger: z.string(),
      startedAt: z.number(),
      finishedAt: z.number().nullable(),
      error: z.string().nullable(),
      skipReason: z.string().nullable(),
      responseStatus: z.string().optional(),
      responseThreadId: z.string().optional(),
      responseMessageId: z.string().optional(),
      responseError: z.string().optional(),
      output: z.string().nullable(),
    }),
  ),
  nextCursor: z.string().nullable(),
});
export type ChannelAutomationRunPage = z.infer<typeof channelAutomationRunPage>;
