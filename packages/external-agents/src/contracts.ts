import { dotConnectionSchema } from "./dot-bridge.js";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { connectionSchema } from "./hermes-client.js";
import { openclawConnectionSchema } from "./openclaw.js";
export const healthSchema = z.object({ online: z.boolean(), status: z.enum(["ready", "unknown", "unauthenticated", "disabled", "paused"]), message: z.string() });
export const hostContract = defineRpcContract({
  health: { input: z.object({ provider: z.enum(["hermes", "openclaw", "dot"]), connection: z.union([connectionSchema, openclawConnectionSchema, dotConnectionSchema]) }), output: healthSchema },
});
export const rpcContract = defineRpcContract({
  health: { input: z.object({ hostId: z.string().min(1).optional(), provider: z.enum(["hermes", "openclaw", "dot"]) }), output: healthSchema },
});
