import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { Store } from "./store";
import { missingThread } from "./runtime";
import { isExecuting } from "./job-state";

export const notificationSchema = z
  .object({
    title: z.string(),
    body: z.string(),
    kind: z.enum(["turn-finished", "thread-error", "pending-interaction"]),
    threadId: z.string().nullable(),
    projectId: z.string(),
    path: z.string().optional(),
    coalesceKey: z.string(),
  })
  .nullable();

type Notice = {
  id: string;
  room_id: string;
  kind: string;
  subject_id: string;
  created_at: number;
};

export class ChannelNotifications {
  private retryAt = 0;
  preferences = async () => ({
    attentionNotifications: true,
    replyNotifications: true,
  });
  constructor(
    private bb: BbPluginApi,
    private store: Store,
  ) {}
  interaction(threadId: string, interactionId: string) {
    const conversation = this.store.byThread(threadId);
    if (!conversation) return;
    const job = this.store
      .work(conversation.botId)
      .find((j) => j.threadId === threadId && isExecuting(j));
    if (job?.roomId)
      this.store.queueNotification(
        `interaction:${interactionId}`,
        job.roomId,
        "interaction",
        threadId,
      );
  }
  async resolve(
    id: string,
    signal = AbortSignal.timeout(10_000),
  ): Promise<z.infer<typeof notificationSchema>> {
    const n = this.store.db
      .prepare("SELECT * FROM channel_notifications WHERE id=?")
      .get(id) as Notice | undefined;
    if (!n || n.created_at < Date.now() - 86400000) return null;
    const room = this.store.findRoom(n.room_id);
    if (!room || room.archived) return null;
    const path = `/plugins/bot-teams/channels/${room.id}`;
    const preferences = await this.preferences();
    if (n.kind === "attention") {
      const attention = this.store.attention.get(n.subject_id);
      if (
        !preferences.attentionNotifications ||
        !attention ||
        attention.status !== "open" ||
        id !== `attention:${attention.id}:${attention.revision}`
      )
        return null;
      const m = this.store.message(attention.id);
      if (!m || m.system) return null;
      const bot = m.botId ? this.store.get(m.botId) : null;
      if (bot && (bot.retired || !room.memberIds.includes(bot.id))) return null;
      const threadId =
        this.store.job(m.id)?.threadId ?? m.sourceThreadId ?? null;
      const projectId =
        bot?.projectId ??
        (threadId
          ? await this.bb.sdk.threads
              .get({ threadId, signal })
              .then((thread) => thread.projectId)
              .catch((cause) => {
                if (missingThread(cause)) return null;
                throw cause;
              })
          : null);
      if (!projectId) return null;
      return {
        coalesceKey: `attention:${attention.id}`,
        title: `#${room.name} needs you · ${m.speaker}`,
        body: m.text,
        kind: "turn-finished",
        threadId,
        projectId,
        path: `${path}/message/${encodeURIComponent(m.id)}`,
      };
    }
    if (n.kind === "timeout") {
      const job = this.store.job(n.subject_id);
      if (
        !job?.timedOut ||
        job.status !== "cancelled" ||
        job.roomId !== room.id ||
        !room.memberIds.includes(job.botId)
      )
        return null;
      const bot = this.store.get(job.botId);
      if (bot.retired) return null;
      return {
        coalesceKey: `timeout:${job.id}`,
        title: `#${room.name} · ${bot.name} needs a check-in`,
        body: job.activitySnippet
          ? `Stopped before final report. Last progress: ${job.activitySnippet}`
          : job.error ?? "The response timed out.",
        kind: "thread-error",
        threadId: job.threadId,
        projectId: bot.projectId,
        path: `${path}/message/${encodeURIComponent(`system:timeout:${job.id}`)}`,
      };
    }
    if ((room.lastReadAt ?? 0) >= n.created_at) return null;
    if (n.kind === "reply") {
      if (!preferences.replyNotifications) return null;
      const m = this.store.message(n.subject_id);
      if (!m?.botId || m.system || !room.memberIds.includes(m.botId))
        return null;
      const bot = this.store.get(m.botId);
      if (bot.retired) return null;
      const job = this.store.job(m.id);
      return {
        coalesceKey: room.id,
        title: `#${room.name} · ${bot.name}`,
        body:
          m.text ||
          `${bot.name} shared ${m.attachments.length} file${m.attachments.length === 1 ? "" : "s"}.`,
        kind: "turn-finished",
        threadId: job?.threadId ?? m.sourceThreadId ?? null,
        projectId: bot.projectId,
        path: `${path}/message/${encodeURIComponent(m.id)}`,
      };
    }
    if (n.kind === "error") {
      const job = this.store.job(n.subject_id);
      if (
        !job ||
        job.status !== "error" ||
        !room.memberIds.includes(job.botId) ||
        this.store
          .requestJobs(job.runId ?? "")
          .some((j) => j.retryOf === job.id)
      )
        return null;
      const bot = this.store.get(job.botId);
      if (bot.retired) return null;
      return {
        coalesceKey: room.id,
        title: `#${room.name} · ${bot.name}`,
        body: job.error ?? "The response hit an error.",
        kind: "thread-error",
        threadId: job.threadId,
        projectId: bot.projectId,
        path,
      };
    }
    const c = this.store.byThread(n.subject_id);
    if (
      !c ||
      !room.memberIds.includes(c.botId) ||
      this.store.get(c.botId).retired ||
      !this.store
        .work(c.botId)
        .some((j) => j.threadId === n.subject_id && isExecuting(j))
    )
      return null;
    const current = await Promise.all([
      this.bb.sdk.threads.get({ threadId: n.subject_id, signal }),
      this.bb.sdk.threads.interactions.list({ threadId: n.subject_id, signal }),
    ]).catch((cause) => {
      if (missingThread(cause)) return null;
      throw cause;
    });
    if (!current) return null;
    const [thread, interactions] = current;
    if (
      thread.deletedAt !== null ||
      thread.archivedAt !== null ||
      (thread.lastReadAt ?? 0) >= n.created_at ||
      !interactions.some(
        (i) => `interaction:${i.id}` === id && i.status === "pending",
      )
    )
      return null;
    return {
      coalesceKey: room.id,
      title: `#${room.name} · ${this.store.get(c.botId).name}`,
      body: "Waiting for your input",
      kind: "pending-interaction",
      threadId: n.subject_id,
      projectId: thread.projectId,
    };
  }
  async flush(signal?: AbortSignal) {
    if (Date.now() < this.retryAt) return;
    const rows = this.store.db
      .prepare(
        "SELECT id FROM channel_notifications WHERE dispatched_at IS NULL ORDER BY created_at LIMIT 50",
      )
      .all() as { id: string }[];
    for (const { id } of rows) {
      try {
        const deadline = AbortSignal.timeout(10_000);
        const requestSignal = signal
          ? AbortSignal.any([signal, deadline])
          : deadline;
        // Decisions and blockers use real BB questions, handled independently of this optional API.
        if (!id.startsWith("attention:") && await this.resolve(id, requestSignal))
          await this.bb.sdk.plugins.callRpc({
            signal: requestSignal,
            pluginId: "push-notifications",
            method: "notifications.enqueue",
            input: { pluginId: "bot-teams", eventId: id },
            outputSchema: z.object({ ok: z.literal(true) }),
          });
        this.store.db
          .prepare(
            "UPDATE channel_notifications SET dispatched_at=? WHERE id=?",
          )
          .run(Date.now(), id);
      } catch (cause) {
        this.retryAt = Date.now() + 30000;
        this.bb.log.debug(
          `Channel notification delivery waiting: ${String(cause)}`,
        );
        break;
      }
    }
    this.store.db
      .prepare("DELETE FROM channel_notifications WHERE created_at<?")
      .run(Date.now() - 86400000);
  }
}
