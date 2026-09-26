import {
  revisionSchema,
  usageLimits,
  usageSummary,
} from "./workspace-contract";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { botSetupThreadRequest } from "./bot-creation-contract";
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
export const permissionModeSchema = z.enum(["accept-edits", "auto", "full"]);
export type PermissionMode = z.infer<typeof permissionModeSchema>;
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
  permissionMode: permissionModeSchema.default("auto"),
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
export const botListItemSchema = botSchema.extend({
  working: z.boolean(),
  lastActivityAt: z.number().nullable(),
});
export type BotListItem = z.infer<typeof botListItemSchema>;
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
  archivedAt: z.number().optional(),
  originalKey: z.string().optional(),
  providerId: z.string().optional(),
  model: z.string().optional(),
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
  contextMessageId: z.string().optional(),
  rosterVersion: z.string().optional(),
  delegationId: z.string().optional(),
  rootTaskId: z.string().optional(),
  parentTaskId: z.string().optional(),
  coordinatorId: idSchema.optional(),
  returnOf: z.string().optional(),
  timedOut: z.boolean().optional(),
  timeoutNoticePending: z.boolean().optional(),
  taskTitle: z.string().optional(),
  queueReason: z.string().optional(),
  queuePosition: z.number().optional(),
  dispatchAction: z.enum(["steer", "followup", "fork"]).optional(),
  forkSourceThreadId: z.string().optional(),
  requiresPromptMatch: z.boolean().optional(),
  directMessageRequestIds: z.array(z.string()).optional(),
  pendingSteer: z
    .object({ priorPrompt: z.string(), attemptedAt: z.number().optional() })
    .optional(),
  wrapUpRequestedAt: z.number().optional(),
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
  /** Overrides every member bot's own mode while set. Null means each bot's own. */
  permissionMode: permissionModeSchema.nullable().optional(),
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
export const attentionReason = z.enum(["decision", "blocker", "update"]);
export const messageSchema = z.object({
  // Derived from the attention inbox when reading a transcript.
  attentionStatus: z.enum(["open", "snoozed", "acknowledged"]).optional(),
  ownerMention: z.boolean().optional(),
  attentionReason: attentionReason.optional(),
  saved: z.boolean().optional(),
  editedAt: z.number().optional(),
  sentText: z.string().optional(),
  sendMode: sendModeSchema.optional(),
  classifierActions: z.array(z.object({
    botId: idSchema,
    action: z.enum(["steer", "followup", "fork"]),
    suggestedAction: z.enum(["steer", "followup", "fork"]).optional(),
  })).max(16).optional(),
  classifierPlan: z.object({
    coordinatorId: idSchema.nullable(),
    collaboratorIds: z.array(idSchema).max(16),
    executionMode: z.enum(["serialized", "parallel"]),
    finalizerId: idSchema.nullable(),
    source: z.enum(["jev", "providers", "fallback"]).optional(),
  }).optional(),
  internalResult: z.boolean().optional(),
  conversationKey: z.string().optional(),
  automationId: z.string().optional(),
  id: z.string(),
  roomId: z.string(),
  runId: z.string(),
  botId: idSchema.nullable(),
  speaker: z.string(),
  system: z.enum(["bot_joined", "bot_timeout", "bot_dm"]).optional(),
  sourceThreadId: z.string().optional(),
  sourceJobId: z.string().optional(),
  replyTo: z.string().nullable().default(null),
  attachments: z.array(attachmentSchema).default([]),
  text: z.string(),
  createdAt: z.number(),
});
export type RoomMessage = z.infer<typeof messageSchema>;
export const attentionSchema = z.object({
  id: z.string(),
  roomId: z.string(),
  reason: attentionReason,
  status: z.enum(["open", "snoozed", "acknowledged"]),
  snoozedUntil: z.number().nullable(),
  revision: z.number().int(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export const attentionView = attentionSchema.extend({
  channelName: z.string(),
  message: messageSchema,
  pendingReply: z.object({ id: z.string(), text: z.string(), error: z.string().nullable() }).nullable().default(null),
});
export type Attention = z.infer<typeof attentionSchema>;
export type AttentionView = z.infer<typeof attentionView>;
export const approvalDecision = z.enum([
  "allow_once",
  "allow_for_session",
  "deny",
]);
export type ApprovalDecision = z.infer<typeof approvalDecision>;
export const approvalQuestion = z.object({
  id: z.string(),
  prompt: z.string(),
  multiSelect: z.boolean(),
  allowFreeText: z.boolean(),
  options: z
    .array(
      z.object({
        value: z.string(),
        label: z.string(),
        description: z.string().nullable().default(null),
      }),
    )
    .default([]),
});
/** A bot's pending request, forwarded from its work thread into the channel. */
export const approvalSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  botId: idSchema,
  roomId: z.string(),
  jobId: z.string().nullable(),
  kind: z.enum(["approval", "question", "other"]),
  title: z.string(),
  detail: z.string().nullable(),
  decisions: z.array(approvalDecision).default([]),
  questions: z.array(approvalQuestion).default([]),
  createdAt: z.number(),
});
export type ChannelApproval = z.infer<typeof approvalSchema>;
export const notifyInput = z.object({
  channelId: z.string().uuid(),
  requestId: z.string().uuid(),
  reason: attentionReason,
  text: z.string().trim().min(1).max(2000),
});
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
  routingPlan: z.object({
    coordinatorId: idSchema.nullable(),
    collaboratorIds: z.array(idSchema).max(16),
    executionMode: z.enum(["serialized", "parallel"]),
    finalizerId: idSchema.nullable(),
    source: z.enum(["jev", "providers", "fallback"]).optional(),
  }).optional(),
  finalMessageId: z.string().optional(),
});
export type RoomRun = z.infer<typeof runSchema>;
const transcriptPageSchema = z.object({
  messages: z.array(messageSchema),
  parents: z.array(messageSchema),
  reactions: z.array(reactionSchema),
  hasOlder: z.boolean(),
  hasNewer: z.boolean(),
});
const roomInput = z.object({
  responseBehavior: responseBehavior.optional(),
  name: z.string().trim().min(1).max(80),
  memberIds: z.array(idSchema).max(16),
});
export const rpcContract = defineRpcContract({
  createBotSetupThread: {
    input: botSetupThreadRequest,
    output: z.object({ threadId: z.string() }),
  },
  attentionList: {
    input: z.object({
      status: attentionSchema.shape.status.default("open"),
      channelId: z.string().uuid().optional(),
      limit: z.number().int().min(1).max(50).default(30),
      offset: z.number().int().min(0).default(0),
    }),
    output: z.object({
      items: z.array(attentionView),
      openCount: z.number(),
      nextOffset: z.number().nullable(),
    }),
  },
  attentionUpdate: {
    input: z.object({
      id: z.string().min(1).max(200),
      action: z.enum(["acknowledge", "snooze", "reopen"]),
      minutes: z.number().int().min(1).max(43200).optional(),
    }).refine((v) => v.action === "snooze" ? v.minutes !== undefined : v.minutes === undefined,
      "Supply minutes only when snoozing."),
    output: attentionView,
  },
  attentionDiscardReply: {
    input: z.object({ id: z.string().uuid() }),
    output: z.object({ ok: z.literal(true) }),
  },
  documentHistory: {
    input: z.object({
      id: idSchema,
      file: z.enum(["MISSION.md", "MEMORY.md"]),
      before: z.number().optional(),
    }),
    output: z.array(revisionSchema),
  },
  channelThreads: {
    input: z.object({ id: z.string().uuid() }),
    output: z.array(
      z.object({
        threadId: z.string(),
        botId: z.string(),
        name: z.string(),
        avatar: z.string(),
        active: z.boolean(),
        needsApproval: z.boolean().default(false),
      }),
    ),
  },
  channelForThread: {
    input: z.object({ threadId: z.string() }),
    output: z.string().uuid().nullable(),
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
      bots: z.array(botListItemSchema),
      rooms: z.array(roomSchema),
      activeRoomIds: z.array(z.string()),
      attentionCounts: z.record(z.string(), z.number().int().nonnegative()),
      approvalCounts: z.record(z.string(), z.number().int().nonnegative()),
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
      after: z.string().optional(),
      through: z.string().optional(),
      query: z.string().trim().max(500).optional(),
      limit: z.number().int().min(1).max(100).default(50),
    }).refine((input) => !(input.before && input.after), "Choose one history cursor.")
      .refine((input) => !input.through || !!input.after, "A range needs an after cursor.")
      .refine((input) => !input.after || !input.query, "Search and forward ranges cannot be combined."),
    output: z.object({
      messages: z.array(messageSchema),
      parents: z.array(messageSchema),
      nextBefore: z.string().nullable(),
      nextAfter: z.string().nullable(),
    }),
  },
  transcript: {
    input: z
      .object({
        id: z.string().uuid(),
        before: z.string().optional(),
        after: z.string().optional(),
        around: z.string().optional(),
      })
      .refine(
        (input) =>
          [input.before, input.after, input.around].filter(
            (v) => v !== undefined,
          ).length <= 1,
        "Choose one transcript cursor.",
      ),
    output: transcriptPageSchema,
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
  newConversation: {
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
  handoffSource: {
    input: z.object({ threadId: z.string().min(1).max(200) }),
    output: z.object({
      threadId: z.string(),
      projectId: z.string(),
      title: z.string(),
    }),
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
    input: z.object({
      id: z.string().uuid(),
      start: z.string().optional(),
      limit: z.number().int().min(1).max(150).default(50),
    }),
    output: transcriptPageSchema.extend({
      room: roomSchema,
      runs: z.array(runSchema),
      jobs: z.array(jobSchema),
      approvals: z.array(approvalSchema).default([]),
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
      markUnread: z.boolean().optional(),
      rememberDefault: z.boolean().optional(),
      responseBehavior: responseBehavior.optional(),
      permissionMode: permissionModeSchema.nullable().optional(),
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
  resolveApproval: {
    input: z
      .object({
        id: z.string().uuid(),
        threadId: z.string().min(1).max(200),
        interactionId: z.string().min(1).max(200),
        decision: approvalDecision.optional(),
        answers: z.record(
          z.string().min(1).max(200),
          z.object({
            selected: z.array(z.string().max(500)).max(32),
            freeText: z.string().max(4000).optional(),
          }),
        ).optional(),
      })
      .refine(
        (v) => (v.decision === undefined) !== (v.answers === undefined),
        "Send either a decision or answers.",
      ),
    output: z.object({ resolved: z.literal(true) }),
  },
  cancelJob: {
    input: z.object({ id: z.string() }),
    output: z.object({ cancelled: z.boolean() }),
  },
});
