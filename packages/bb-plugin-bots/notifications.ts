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
    if (!room || room.archived || (room.lastReadAt ?? 0) >= n.created_at)
      return null;
    const path = `/plugins/bots/channels/${room.id}`;
    if (n.kind === "reply") {
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
        if (await this.resolve(id, requestSignal))
          await this.bb.sdk.plugins.callRpc({
            signal: requestSignal,
            pluginId: "push-notifications",
            method: "notifications.enqueue",
            input: { pluginId: "bots", eventId: id },
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
