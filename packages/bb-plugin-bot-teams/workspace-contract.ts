import { z } from "zod";

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
