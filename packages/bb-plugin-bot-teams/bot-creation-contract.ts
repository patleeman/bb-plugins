import type { NewThreadRequest } from "@get-bb/plugin-sdk";
import { z } from "zod";

// Whitelist the composer fields. Core threads.spawn validates the full host-owned
// environment and prompt-input contracts before creating or dispatching a thread.
export const botSetupThreadRequest = z.object({
  projectId: z.string().min(1),
  providerId: z.string().min(1),
  model: z.string(),
  reasoningLevel: z.enum([
    "none",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra",
    "ultracode",
  ]),
  permissionMode: z.enum(["accept-edits", "auto", "full"]),
  serviceTier: z.enum(["default", "fast"]).optional(),
  executionInputSources: z.object({
    model: z.enum(["client-preference", "explicit"]).optional(),
    permissionMode: z.enum(["client-preference", "explicit"]).optional(),
    providerId: z.enum(["client-preference", "explicit"]).optional(),
    reasoningLevel: z.enum(["client-preference", "explicit"]).optional(),
    serviceTier: z.enum(["client-preference", "explicit"]).optional(),
  }),
  environment: z
    .record(z.string(), z.json())
    .transform((value) => value as NewThreadRequest["environment"]),
  input: z
    .array(z.record(z.string(), z.json()))
    .min(1)
    .transform((value) => value as NewThreadRequest["input"]),
  sendAt: z.number().int().positive().optional(),
});
