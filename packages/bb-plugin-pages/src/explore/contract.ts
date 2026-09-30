// Explore's RPC methods, merged into Pages' contract (../contract.ts). Zod
// only, so the app can import the types without server code.
import { z } from "zod";
import { JOB_STATUSES, MAX_LABEL_LENGTH } from "./shared";

const explainerId = z.string().min(1).max(100);
const threadId = z.string().min(1).max(200);
const messageId = z.string().min(1).max(200);

export const itemSchema = z.object({ emoji: z.string(), label: z.string() });

export const jobSchema = z.object({
  id: z.string(),
  explainerId: z.string(),
  kind: z.enum(["generate", "regenerate"]),
  status: z.enum(JOB_STATUSES),
  /** The stage, e.g. "Writing". */
  label: z.string(),
  /** What the stage is doing, e.g. "Investigating · looked at 6 files". */
  detail: z.string(),
  progress: z.number(),
  error: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const explainerSchema = z.object({
  id: z.string(),
  /** The explainer whose follow-up this is, or null for a finding in a reply. */
  parentId: z.string().nullable(),
  threadId: z.string(),
  messageId: z.string(),
  turnId: z.string().nullable(),
  emoji: z.string(),
  label: z.string(),
  pageId: z.string().nullable(),
  projectId: z.string().nullable(),
  /** The page in Pages, once saved. */
  href: z.string().nullable(),
  status: z.enum(["pending", "generating", "ready", "error"]),
  /** What the explainer itself found worth exploring next. */
  followUps: z.array(itemSchema),
  generatedAt: z.number().nullable(),
  regeneratedAt: z.number().nullable(),
  error: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** The running job, or the last one when it failed. */
  job: jobSchema.nullable(),
});

export type ExplainerView = z.infer<typeof explainerSchema>;
export type JobView = z.infer<typeof jobSchema>;

export const exploreMethods = {
  /** Opens, attaches to, or starts the explainer for a finding. */
  explore: {
    input: z.object({
      threadId,
      messageId,
      turnId: z.string().max(200).nullable().optional(),
      emoji: z.string().max(16).optional(),
      label: z.string().trim().min(1).max(MAX_LABEL_LENGTH * 2),
      parentId: explainerId.nullable().optional(),
    }),
    output: z.object({ explainer: explainerSchema, started: z.boolean() }),
  },
  /** Writes the explainer again, in place; the old page is kept as a version. */
  exploreRegenerate: {
    input: z.object({ explainerId }),
    output: z.object({ explainer: explainerSchema }),
  },
  exploreStop: {
    input: z.object({ explainerId }),
    output: z.object({ explainer: explainerSchema.nullable() }),
  },
  explainer: {
    input: z.object({ explainerId }),
    output: z.object({ explainer: explainerSchema.nullable() }),
  },
  /** The explainers started from one message's findings (or one explainer's follow-ups). */
  explainersForMessage: {
    input: z.object({ threadId, messageId, parentId: explainerId.nullable().optional() }),
    output: z.object({ explainers: z.array(explainerSchema) }),
  },
  explainers: {
    input: z.object({ threadId: threadId.optional(), limit: z.number().int().min(1).max(200).optional() }),
    output: z.object({ explainers: z.array(explainerSchema) }),
  },
};
