import { z } from "zod";

export const contextContent = z.object({
  brief: z.string().max(16000).default(""),
  decisions: z.string().max(16000).default(""),
  memory: z.string().max(16000).default(""),
  attachmentIds: z.array(z.string().uuid()).max(10).default([]),
});
export const channelContext = contextContent.extend({
  version: z.number().int(),
  updatedAt: z.number(),
});
export type ChannelContext = z.infer<typeof channelContext>;
export const revisionSchema = z.object({
  id: z.number(),
  text: z.string(),
  createdAt: z.number(),
  actor: z.string(),
});
export const usageLimits = z.object({
  turnsPerHour: z.number().int().min(1).max(1000).default(100),
  turnsPerDay: z.number().int().min(1).max(10000).default(1000),
  minutesPerTurn: z.number().int().min(1).max(180).default(20),
  concurrentForks: z.number().int().min(1).max(16).default(2),
});
export const defaultLimits = usageLimits.parse({});
export const usageSummary = z.object({
  turns: z.number(),
  forks: z.number(),
  active: z.number(),
  errors: z.number(),
  routingCalls: z.number(),
  routingMilliseconds: z.number(),
  since: z.number(),
  limits: usageLimits,
});
