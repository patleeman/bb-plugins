import {
  channelContext,
  contextContent,
  revisionSchema,
  usageLimits,
  usageSummary,
} from "./workspace-contract";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { sendModes } from "./send-mode";
export const sendModeSchema = z.enum(sendModes);
import {
  channelAutomationCreate,
  channelAutomationList,
  channelAutomationUpdate,
  channelAutomationAction,
  channelAutomationView,
  channelAutomationRuns,
  channelAutomationRunPage,
} from "./automation-contract";
export const idSchema = z.string().regex(/^bot_[a-f0-9]{16}$/);
export const profileInput = z.object({
  limits: usageLimits.optional(),
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).default(""),
  avatar: z.string().max(16).default("🤖"),
  providerId: z.string().max(100).default("codex"),
  model: z.string().max(200).default(""),
  reasoningLevel: z
    .enum([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
      "ultracode",
    ])
    .default("medium"),
  permissionMode: z.enum(["accept-edits", "auto", "full"]).default("auto"),
  intervalMinutes: z
    .number()
    .int()
    .min(0)
    .max(10080)
    .refine((n) => n === 0 || n >= 5)
    .default(0),
});
export const botSchema = profileInput.extend({
  id: idSchema,
  handle: z.string(),
  home: z.string(),
  projectId: z.string(),
  hostId: z.string(),
  retired: z.boolean().optional(),
  paused: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
  lastWakeAt: z.number(),
  error: z.string().nullable(),
});
export type Bot = z.infer<typeof botSchema>;
export type ProfileInput = z.infer<typeof profileInput>;
export const botCreateInput = profileInput.extend({
  mission: z.string().min(1).max(64000),
  roomId: z.string().uuid().optional(),
});
export const botCreateRequestSchema = z.object({
  id: z.string().uuid(),
  requesterBotId: idSchema,
  requesterThreadId: z.string().min(1),
  requesterName: z.string().min(1),
  channelName: z.string().nullable(),
  input: botCreateInput,
  status: z.enum([
    "pending",
    "approved",
    "creating",
    "created",
    "denied",
    "expired",
    "cancelled",
  ]),
  createdAt: z.number(),
  expiresAt: z.number(),
  resolvedAt: z.number().nullable(),
  createdBotId: idSchema.nullable().default(null),
});
export type BotCreateRequest = z.infer<typeof botCreateRequestSchema>;
export const botCreateRequestViewSchema = z.object({
  id: z.string().uuid(),
  requesterBotId: idSchema,
  requesterName: z.string().min(1),
  channelName: z.string().nullable(),
  name: z.string(),
  description: z.string(),
  avatar: z.string(),
  providerId: z.string(),
  model: z.string(),
  reasoningLevel: z.string(),
  permissionMode: z.string(),
  intervalMinutes: z.number(),
  mission: z.string().max(4000),
  missionTruncated: z.boolean(),
  createdAt: z.number(),
  expiresAt: z.number(),
});
export type BotCreateRequestView = z.infer<typeof botCreateRequestViewSchema>;
// Creation defaults must never reset fields omitted from a partial update.
const profilePatch = z.object({
  limits: usageLimits.optional(),
  name: profileInput.shape.name.optional(),
  description: profileInput.shape.description.removeDefault().optional(),
  avatar: profileInput.shape.avatar.removeDefault().optional(),
  providerId: profileInput.shape.providerId.removeDefault().optional(),
  model: profileInput.shape.model.removeDefault().optional(),
  reasoningLevel: profileInput.shape.reasoningLevel.removeDefault().optional(),
  permissionMode: profileInput.shape.permissionMode.removeDefault().optional(),
  intervalMinutes: profileInput.shape.intervalMinutes
    .removeDefault()
    .optional(),
});
export const conversationSchema = z.object({
  id: z.string(),
  botId: idSchema,
  key: z.string(),
  threadId: z.string(),
  title: z.string(),
  kind: z.enum(["admin", "group", "mission"]),
  createdAt: z.number(),
});
export type Conversation = z.infer<typeof conversationSchema>;
export const attachmentSchema = z.object({
  id: z.string().uuid(),
  roomId: z.string().uuid(),
  projectId: z.string(),
  name: z.string(),
  path: z.string(),
  mimeType: z.string().optional(),
  type: z.enum(["localFile", "localImage"]),
  sizeBytes: z.number(),
  alt: z.string().max(500).optional(),
});
export type Attachment = z.infer<typeof attachmentSchema>;
export const jobSchema = z.object({
  delegationId: z.string().optional(),
  returnOf: z.string().optional(),
  timedOut: z.boolean().optional(),
  taskTitle: z.string().optional(),
  queueReason: z.string().optional(),
  queuePosition: z.number().optional(),
  dispatchAction: z.enum(["steer", "followup", "fork"]).optional(),
  forkSourceThreadId: z.string().optional(),
  requiresPromptMatch: z.boolean().optional(),
  pendingSteer: z
    .object({ priorPrompt: z.string(), attemptedAt: z.number().optional() })
    .optional(),
  automationId: z.string().optional(),
  id: z.string(),
  botId: idSchema,
  conversationKey: z.string(),
  threadId: z.string().nullable(),
  text: z.string(),
  status: z.enum([
    "queued",
    "dispatching",
    "running",
    "done",
    "error",
    "cancelled",
  ]),
  cancellationPending: z.boolean().optional(),
  activitySnippet: z.string().max(240).optional(),
  retryOf: z.string().optional(),
  reply: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  startedAt: z.number().nullable(),
  dispatchStartedAt: z.number().nullable().default(null),
  roomId: z.string().nullable(),
  runId: z.string().nullable(),
  triggerMessageId: z.string().nullable().default(null),
  depth: z.number().int().default(0),
  attachments: z.array(attachmentSchema).default([]),
  outputAttachments: z.array(attachmentSchema).default([]),
});
export type Job = z.infer<typeof jobSchema>;
export const emojiSchema = z
  .string()
  .min(1)
  .max(32)
  .refine(
    (value) =>
      Array.from(
        new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
          value,
        ),
      ).length === 1 &&
      /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(value),
    "Choose one emoji.",
  );
export const reactionSchema = z.object({
  messageId: z.string(),
  emoji: emojiSchema,
  actorId: z.string(),
  actorName: z.string(),
  createdAt: z.number(),
});
export type Reaction = z.infer<typeof reactionSchema>;
export const responseBehavior = z.enum(["smart", "directed", "everyone"]);
export const roomSchema = z.object({
  limits: usageLimits.optional(),
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
  memberIds: z.array(idSchema).max(16),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
  lastReadAt: z.number().optional(),
  responseBehavior: responseBehavior.optional(),
  paused: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Room = z.infer<typeof roomSchema>;
export const messageSchema = z.object({
  saved: z.boolean().optional(),
  editedAt: z.number().optional(),
  sentText: z.string().optional(),
  sendMode: sendModeSchema.optional(),
  conversationKey: z.string().optional(),
  automationId: z.string().optional(),
  id: z.string(),
  roomId: z.string(),
  runId: z.string(),
  botId: idSchema.nullable(),
  speaker: z.string(),
  system: z.enum(["bot_joined"]).optional(),
  sourceThreadId: z.string().optional(),
  sourceJobId: z.string().optional(),
  replyTo: z.string().nullable().default(null),
  attachments: z.array(attachmentSchema).default([]),
  text: z.string(),
  createdAt: z.number(),
});
export type RoomMessage = z.infer<typeof messageSchema>;
/** Scheduled prompts are execution records, not chat messages. */
export const isAutomationTrigger = (
  message: Pick<RoomMessage, "automationId" | "botId">,
) => !!message.automationId && message.botId === null;
export const runSchema = z.object({
  id: z.string(),
  roomId: z.string(),
  status: z.enum(["queued", "running", "done", "stopped"]),
  mode: z.literal("concurrent").optional(),
  pendingJobIds: z.array(z.string()).default([]),
  settledJobIds: z.array(z.string()).default([]),
  round: z.number(),
  remaining: z.array(idSchema),
  next: z.array(idSchema),
  jobId: z.string().nullable(),
  createdAt: z.number(),
  error: z.string().nullable(),
  routing: z.enum(["pending", "done", "error"]).optional(),
  routingError: z.string().optional(),
  routingDepth: z.number().optional(),
  routingBotIds: z.array(idSchema).optional(),
});
export type RoomRun = z.infer<typeof runSchema>;
const roomInput = z.object({
  responseBehavior: responseBehavior.optional(),
  name: z.string().trim().min(1).max(80),
  memberIds: z.array(idSchema).max(16),
});
export const rpcContract = defineRpcContract({
  channelContext: {
    input: z.object({ id: z.string().uuid() }),
    output: channelContext,
  },
  saveChannelContext: {
    input: contextContent.extend({
      id: z.string().uuid(),
      version: z.number().int(),
    }),
    output: channelContext,
  },
  contextHistory: {
    input: z.object({ id: z.string().uuid(), before: z.number().optional() }),
    output: z.array(revisionSchema),
  },
  documentHistory: {
    input: z.object({
      id: idSchema,
      file: z.enum(["MISSION.md", "MEMORY.md"]),
      before: z.number().optional(),
    }),
    output: z.array(revisionSchema),
  },
  channelFiles: {
    input: z.object({
      id: z.string().uuid(),
      before: z.string().uuid().optional(),
    }),
    output: z.object({
      files: z.array(attachmentSchema),
      nextBefore: z.string().nullable(),
    }),
  },
  usage: {
    input: z.object({ id: z.string(), kind: z.enum(["bot", "channel"]) }),
    output: usageSummary,
  },
  saveLimits: {
    input: z.object({
      id: z.string(),
      kind: z.enum(["bot", "channel"]),
      limits: usageLimits,
    }),
    output: usageSummary,
  },
  editMessage: {
    input: z.object({
      id: z.string().uuid(),
      messageId: z.string(),
      text: z.string().trim().min(1).max(16000),
      expectedText: z.string(),
    }),
    output: messageSchema,
  },
  saveMessage: {
    input: z.object({
      id: z.string().uuid(),
      messageId: z.string(),
      saved: z.boolean(),
    }),
    output: messageSchema,
  },
  savedMessages: {
    input: z.object({ id: z.string().uuid(), before: z.string().optional() }),
    output: z.array(messageSchema),
  },

  automationRuns: {
    input: channelAutomationRuns,
    output: channelAutomationRunPage,
  },
  automationCreate: {
    input: channelAutomationCreate,
    output: channelAutomationView,
  },
  automationList: {
    input: channelAutomationList,
    output: z.object({
      automations: z.array(channelAutomationView),
      nextOffset: z.number().nullable(),
    }),
  },
  automationUpdate: {
    input: channelAutomationUpdate,
    output: channelAutomationView,
  },
  automationAction: {
    input: channelAutomationAction,
    output: z.object({ ok: z.literal(true), result: z.unknown() }),
  },
  list: {
    input: z.null(),
    output: z.object({
      bots: z.array(botSchema),
      rooms: z.array(roomSchema),
      activeRoomIds: z.array(z.string()),
      botCreateRequests: z.array(botCreateRequestViewSchema),
    }),
  },
  create: {
    input: botCreateInput,
    output: botSchema,
  },
  resolveBotCreateRequest: {
    input: z.object({ id: z.string().uuid(), approved: z.boolean() }),
    output: z.object({ ok: z.literal(true) }),
  },
  update: {
    input: profilePatch.extend({
      id: idSchema,
      expectedUpdatedAt: z.number().optional(),
    }),
    output: botSchema,
  },
  retire: {
    input: z.object({ id: idSchema, retired: z.boolean() }),
    output: botSchema,
  },
  retryJob: { input: z.object({ id: z.string() }), output: jobSchema },
  history: {
    input: z.object({
      id: z.string().uuid(),
      before: z.string().optional(),
      query: z.string().trim().max(500).optional(),
      limit: z.number().int().min(1).max(100).default(50),
    }),
    output: z.object({
      messages: z.array(messageSchema),
      parents: z.array(messageSchema),
      nextBefore: z.string().nullable(),
    }),
  },
  get: {
    input: z.object({ id: idSchema }),
    output: z.object({
      bot: botSchema,
      conversations: z.array(conversationSchema),
      jobs: z.array(jobSchema),
    }),
  },
  pause: {
    input: z.object({ id: idSchema, paused: z.boolean() }),
    output: botSchema,
  },
  document: {
    input: z.object({
      id: idSchema,
      file: z.enum(["MISSION.md", "MEMORY.md"]),
    }),
    output: z.object({ text: z.string(), version: z.string() }),
  },
  saveDocument: {
    input: z.object({
      id: idSchema,
      file: z.enum(["MISSION.md", "MEMORY.md"]),
      text: z.string().max(64000),
      version: z.string(),
    }),
    output: z.object({ text: z.string(), version: z.string() }),
  },
  wake: {
    input: z.object({ id: idSchema }),
    output: z.object({ queued: z.boolean() }),
  },
  conversation: {
    input: z.object({ id: idSchema }),
    output: conversationSchema,
  },
  createRoom: {
    input: roomInput.extend({
      name: roomInput.shape.name.optional(),
      requestId: z.string().uuid().optional(),
    }),
    output: roomSchema,
  },
  updateRoom: {
    input: roomInput.extend({
      id: z.string().uuid(),
      memberIds: roomInput.shape.memberIds.optional(),
    }),
    output: roomSchema,
  },
  deleteRoom: {
    input: z.object({ id: z.string().uuid() }),
    output: z.object({ deleted: z.boolean() }),
  },
  room: {
    input: z.object({ id: z.string().uuid() }),
    output: z.object({
      room: roomSchema,
      messages: z.array(messageSchema),
      parents: z.array(messageSchema),
      hasOlder: z.boolean(),
      reactions: z.array(reactionSchema),
      runs: z.array(runSchema),
      jobs: z.array(jobSchema),
    }),
  },
  upload: {
    input: z.object({
      id: z.string().uuid(),
      name: z.string().min(1).max(255),
      mimeType: z.string().max(150),
      data: z.string().max(12_000_000),
    }),
    output: attachmentSchema,
  },
  composer: {
    input: z.null(),
    output: z.object({ voiceEnabled: z.boolean() }),
  },
  discardAttachment: {
    input: z.object({ id: z.string().uuid(), attachmentId: z.string().uuid() }),
    output: z.object({ ok: z.literal(true) }),
  },
  transcribe: {
    input: z.object({
      data: z.string().max(12_000_000),
      mimeType: z.string().max(150),
      prompt: z.string().max(16000).optional(),
    }),
    output: z.object({ text: z.string() }),
  },
  send: {
    input: z.object({
      sendMode: sendModeSchema.optional(),
      id: z.string().uuid(),
      text: z.string().trim().max(16000),
      attachmentIds: z.array(z.string().uuid()).max(10).default([]),
      replyTo: z.string().nullable().default(null),
      requestId: z.string().uuid(),
    }),
    output: messageSchema,
  },
  member: {
    input: z.object({
      id: z.string().uuid(),
      botId: idSchema,
      present: z.boolean(),
    }),
    output: roomSchema,
  },
  channelState: {
    input: z.object({
      id: z.string().uuid(),
      pinned: z.boolean().optional(),
      archived: z.boolean().optional(),
      lastReadAt: z.number().optional(),
      rememberDefault: z.boolean().optional(),
      responseBehavior: responseBehavior.optional(),
    }),
    output: roomSchema,
  },
  reaction: {
    input: z.object({
      id: z.string().uuid(),
      messageId: z.string(),
      emoji: emojiSchema,
      active: z.boolean(),
    }),
    output: z.array(reactionSchema),
  },
  retryRouting: {
    input: z.object({ id: z.string().uuid(), requestId: z.string().uuid() }),
    output: z.object({ ok: z.literal(true) }),
  },
  stopRoom: { input: z.object({ id: z.string().uuid() }), output: roomSchema },
  resumeRoom: {
    input: z.object({ id: z.string().uuid() }),
    output: roomSchema,
  },
  cancelJob: {
    input: z.object({ id: z.string() }),
    output: z.object({ cancelled: z.boolean() }),
  },
});
