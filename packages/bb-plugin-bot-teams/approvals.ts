import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ApprovalDecision, ChannelApproval, Job } from "./contract";
import { isExecuting } from "./job-state";
import { missingThread } from "./runtime";
import type { Store } from "./store";

type Interaction = Awaited<
  ReturnType<BbPluginApi["sdk"]["threads"]["interactions"]["get"]>
>;

/** Bot Teams opens its own channel questions. Those stay in For you. */
export const ownQuestion = (interaction: Pick<Interaction, "origin">) =>
  interaction.origin?.kind === "plugin" &&
  interaction.origin.pluginId === "bot-teams";

/** Reads as a predicate after the bot's name: "Designer wants to run …". */
function approvalTitle(subject: Extract<Interaction["payload"], { kind: "approval" }>["subject"]) {
  switch (subject.kind) {
    case "command":
      return `wants to run \`${subject.command}\``;
    case "file_change":
      return subject.writeScope
        ? `wants to change files in ${subject.writeScope}`
        : "wants to change files";
    case "permission_grant":
      return subject.toolName
        ? `wants extra permissions for ${subject.toolName}`
        : "wants extra permissions";
    case "plan":
      return "wants to run its plan";
    case "tool_use":
      return (
        subject.presentation.label.pending || `wants to use ${subject.tool}`
      );
  }
}

export function approvalView(
  interaction: Interaction,
  context: { roomId: string; botId: string; jobId: string | null },
): ChannelApproval {
  const base = {
    id: interaction.id,
    threadId: interaction.threadId,
    botId: context.botId,
    roomId: context.roomId,
    jobId: context.jobId,
    createdAt: interaction.createdAt,
  };
  const payload = interaction.payload;
  if (payload.kind === "approval")
    return {
      ...base,
      kind: "approval",
      title: approvalTitle(payload.subject),
      detail:
        payload.reason ??
        (payload.subject.kind === "plan"
          ? payload.subject.plan.slice(0, 4000)
          : null),
      decisions: payload.availableDecisions,
      questions: [],
    };
  if (payload.kind === "user_question")
    return {
      ...base,
      kind: "question",
      title: payload.questions[0]?.prompt ?? "has a question",
      detail: null,
      decisions: [],
      questions: payload.questions.map((q) => ({
        id: q.id,
        prompt: q.prompt,
        multiSelect: q.multiSelect,
        allowFreeText: q.allowFreeText,
        options: (q.options ?? []).map((o) => ({
          value: o.value,
          label: o.label,
          description: o.description ?? null,
        })),
      })),
    };
  // Anything else keeps its own thread UI, so the channel offers only a link.
  return {
    ...base,
    kind: "other",
    title: payload.title || "is waiting for your input",
    detail: null,
    decisions: [],
    questions: [],
  };
}

const key = (approvals: ChannelApproval[]) =>
  approvals
    .map((a) => `${a.roomId}:${a.threadId}:${a.id}`)
    .sort()
    .join("|");

/**
 * Pending requests from bot work threads, forwarded to the channel that started
 * them. Polling fills a cache so channel reads stay synchronous.
 */
export class ChannelApprovals {
  private byRoom = new Map<string, ChannelApproval[]>();
  private retryAt = 0;
  constructor(
    private bb: BbPluginApi,
    private store: Store,
    private changed: () => void,
  ) {}

  list(roomId: string): ChannelApproval[] {
    return this.byRoom.get(roomId) ?? [];
  }
  counts(): Record<string, number> {
    return Object.fromEntries(
      [...this.byRoom].map(([roomId, approvals]) => [roomId, approvals.length]),
    );
  }
  waitingThreadIds(roomId: string): Set<string> {
    return new Set(this.list(roomId).map((a) => a.threadId));
  }

  private forget(roomId: string, interactionId: string) {
    const remaining = this.list(roomId).filter((a) => a.id !== interactionId);
    if (remaining.length) this.byRoom.set(roomId, remaining);
    else this.byRoom.delete(roomId);
  }

  private eligible(job: Job) {
    if (!job.threadId || !job.roomId) return null;
    const room = this.store.findRoom(job.roomId);
    if (!room || room.archived || !room.memberIds.includes(job.botId))
      return null;
    const conversation = this.store.byThread(job.threadId);
    if (!conversation || conversation.botId !== job.botId) return null;
    return { threadId: job.threadId, roomId: job.roomId };
  }

  async tick(signal?: AbortSignal) {
    if (Date.now() < this.retryAt || signal?.aborted) return;
    const next = new Map<string, ChannelApproval[]>();
    const seen = new Set<string>();
    try {
      for (const job of this.store.executingRoomJobs()) {
        if (signal?.aborted) return;
        const target = this.eligible(job);
        // One session runs per thread, so the first job owns its requests.
        if (!target || seen.has(target.threadId)) continue;
        seen.add(target.threadId);
        const pending = await this.bb.sdk.threads.interactions
          .list({ threadId: target.threadId, signal })
          .catch((cause) => {
            if (missingThread(cause)) return [];
            throw cause;
          });
        for (const interaction of pending) {
          if (interaction.status !== "pending" || ownQuestion(interaction))
            continue;
          const view = approvalView(interaction, {
            roomId: target.roomId,
            botId: job.botId,
            jobId: job.id,
          });
          next.set(target.roomId, [...(next.get(target.roomId) ?? []), view]);
        }
      }
    } catch (cause) {
      this.retryAt = Date.now() + 30_000;
      this.bb.log.debug(`Channel approvals waiting: ${String(cause)}`);
      return;
    }
    const before = key([...this.byRoom.values()].flat());
    this.byRoom = next;
    if (key([...next.values()].flat()) !== before) this.changed();
  }

  async resolve(input: {
    id: string;
    threadId: string;
    interactionId: string;
    decision?: ApprovalDecision;
    answer?: { questionId: string; selected: string[]; freeText?: string };
  }) {
    const room = this.store.room(input.id);
    if (room.archived)
      throw new Error("This channel is archived. Restore it to answer.");
    const conversation = this.store.byThread(input.threadId);
    if (!conversation || !room.memberIds.includes(conversation.botId))
      throw new Error("That request does not belong to this channel.");
    if (
      !this.store
        .roomJobs(input.id)
        .some((j) => j.threadId === input.threadId && isExecuting(j))
    )
      throw new Error("That bot is no longer working in this channel.");
    const interaction = await this.bb.sdk.threads.interactions.get({
      threadId: input.threadId,
      interactionId: input.interactionId,
    });
    if (ownQuestion(interaction))
      throw new Error("Answer this channel question in For you.");
    if (interaction.status !== "pending")
      throw new Error("This request was already answered.");
    const payload = interaction.payload;
    if (input.decision) {
      if (payload.kind !== "approval")
        throw new Error("This request is not an approval.");
      if (!payload.availableDecisions.includes(input.decision))
        throw new Error("That decision is not available for this request.");
      await this.bb.sdk.threads.interactions.resolve({
        threadId: input.threadId,
        interactionId: input.interactionId,
        resolution:
          input.decision === "deny"
            ? { decision: "deny" }
            : {
                decision: input.decision,
                grantedPermissions:
                  payload.subject.kind === "permission_grant"
                    ? payload.subject.permissions
                    : input.decision === "allow_for_session" &&
                        "sessionGrant" in payload.subject
                      ? (payload.subject.sessionGrant ?? null)
                      : null,
              },
      });
    } else {
      const answer = input.answer!;
      if (payload.kind !== "user_question")
        throw new Error("This request is not a question.");
      const question = payload.questions.find((q) => q.id === answer.questionId);
      if (!question || payload.questions.length !== 1)
        throw new Error("Answer this question in the bot's thread.");
      const options = question.options ?? [];
      if (
        !answer.selected.every((value) =>
          options.some((option) => option.value === value),
        )
      )
        throw new Error("That choice is no longer offered.");
      if (!answer.selected.length && !answer.freeText)
        throw new Error("Choose an option before sending.");
      await this.bb.sdk.threads.interactions.resolve({
        threadId: input.threadId,
        interactionId: input.interactionId,
        resolution: {
          kind: "user_answer",
          answers: {
            [answer.questionId]: {
              selected: answer.selected,
              ...(answer.freeText ? { freeText: answer.freeText } : {}),
            },
          },
        },
      });
    }
    this.forget(input.id, input.interactionId);
    this.changed();
    return { resolved: true as const };
  }
}
