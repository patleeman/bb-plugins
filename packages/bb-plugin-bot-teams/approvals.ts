import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ApprovalDecision, ChannelApproval, Job } from "./contract";
import { isExecuting } from "./job-state";
import { missingThread } from "./runtime";
import type { Store } from "./store";

type Interaction = Awaited<
  ReturnType<BbPluginApi["sdk"]["threads"]["interactions"]["get"]>
>;

/** Legacy Bot Teams attention prompts are not resolved through channel approvals. */
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

function approvalDetail(payload: Extract<Interaction["payload"], { kind: "approval" }>) {
  const subject = payload.subject;
  const details = [payload.reason?.trim()];
  if (subject.kind === "command" && subject.cwd)
    details.push(`Working directory: ${subject.cwd}`);
  if (subject.kind === "permission_grant") {
    const files = subject.permissions.fileSystem;
    if (files?.read.length) details.push(`Read: ${files.read.join(", ")}`);
    if (files?.write.length) details.push(`Write: ${files.write.join(", ")}`);
    if (subject.permissions.network?.enabled)
      details.push("Network access requested");
  }
  if (subject.kind === "plan") details.push(subject.plan);
  if (subject.kind === "tool_use" && subject.presentation.detail)
    details.push(subject.presentation.detail);
  return details.filter(Boolean).join("\n\n") || null;
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
      detail: approvalDetail(payload),
      decisions: payload.availableDecisions,
      questions: [],
    };
  if (payload.kind === "user_question")
    return {
      ...base,
      kind: "question",
      title: payload.questions.length === 1 ? "has a question" : `has ${payload.questions.length} questions`,
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
  // Provider and plugin interactions use their native UI embedded in the channel.
  return {
    ...base,
    kind: "other",
    title: payload.title || "is waiting for your input",
    detail: payload.kind === "plugin" ? payload.presentation?.detail ?? null : null,
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
    answers?: Record<string, { selected: string[]; freeText?: string }>;
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
      throw new Error("Use the channel message to respond to this attention request.");
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
      const answers = input.answers!;
      if (payload.kind !== "user_question")
        throw new Error("This request is not a question.");
      if (Object.keys(answers).length !== payload.questions.length ||
          payload.questions.some((question) => !Object.hasOwn(answers, question.id)))
        throw new Error("Answer every question before sending.");
      const checked: Record<string, { selected: string[]; freeText?: string }> = {};
      for (const question of payload.questions) {
        const answer = answers[question.id]!;
        const options = question.options ?? [];
        if (answer.selected.some((value) =>
          !options.some((option) => option.value === value)))
          throw new Error("That choice is no longer offered.");
        if (new Set(answer.selected).size !== answer.selected.length ||
            (!question.multiSelect && answer.selected.length > 1))
          throw new Error("Choose only the offered number of options.");
        const freeText = answer.freeText?.trim();
        if (freeText && !question.allowFreeText)
          throw new Error("Free text is not offered for this question.");
        if (!answer.selected.length && !freeText)
          throw new Error("Answer every question before sending.");
        checked[question.id] = {
          selected: answer.selected,
          ...(freeText ? { freeText } : {}),
        };
      }
      await this.bb.sdk.threads.interactions.resolve({
        threadId: input.threadId,
        interactionId: input.interactionId,
        resolution: {
          kind: "user_answer",
          answers: checked,
        },
      });
    }
    this.forget(input.id, input.interactionId);
    this.changed();
    return { resolved: true as const };
  }
}
