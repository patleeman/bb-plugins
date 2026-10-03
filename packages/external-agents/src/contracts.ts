import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { connectionSchema } from "./hermes-client.js";
export const healthSchema = z.object({ online: z.boolean(), status: z.enum(["ready", "unknown", "unauthenticated"]), message: z.string() });
export const hostContract = defineRpcContract({
  health: { input: z.object({ provider: z.enum(["hermes", "openclaw"]), connection: connectionSchema }), output: healthSchema },
});
export const rpcContract = defineRpcContract({
  health: { input: z.object({ hostId: z.string().min(1), provider: z.enum(["hermes", "openclaw"]) }), output: healthSchema },
});
