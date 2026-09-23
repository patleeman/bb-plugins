import { z } from "zod";

export const ATTENTION_QUESTION_RENDERER = "channel-question";
export const attentionQuestionPayload = z.object({
  attentionId: z.string(),
  roomId: z.string().uuid(),
  channelName: z.string(),
  speaker: z.string(),
  text: z.string(),
});
export const attentionQuestionAnswer = z.discriminatedUnion("action", [
  z.object({ action: z.literal("reply"), text: z.string().trim().min(1).max(4000) }),
  z.object({ action: z.literal("acknowledge") }),
  z.object({ action: z.literal("snooze") }),
]);
