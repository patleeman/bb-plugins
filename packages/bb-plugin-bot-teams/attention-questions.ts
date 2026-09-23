import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Attention } from "./contract";
import type { Store } from "./store";
import { missingThread } from "./runtime";
import { ATTENTION_QUESTION_RENDERER, attentionQuestionAnswer } from "./attention-question-contract";

type Question = { id: string; revision: number; thread_id: string; state: string };
type Reply = { id: string; attention_id: string; room_id: string; text: string; revision: number };
type Active = { question: Question; abort: AbortController; done: Promise<void> };

/** Real, answerable BB questions. BB's existing interaction.pending listener owns push delivery. */
export class AttentionQuestions {
  private active = new Map<string, Active>();
  private retryAt = 0;
  private stopped = false;
  private sending = new Set<string>();
  preferences = async () => ({ attentionNotifications: true });

  constructor(
    private bb: BbPluginApi,
    private store: Store,
    private reply: (input: { id: string; requestId: string; text: string; replyTo: string }) => Promise<unknown>,
    private changed: () => void,
  ) {}

  private eligible(id: string, revision: number): Attention | null {
    const a = this.store.attention.get(id);
    if (!a || a.revision !== revision || a.status !== "open" || a.reason === "update") return null;
    const room = this.store.findRoom(a.roomId), message = this.store.message(id);
    if (!room || room.archived || !message) return null;
    if (message.botId && (!room.memberIds.includes(message.botId) || this.store.get(message.botId).retired)) return null;
    return a;
  }

  private finish(q: Question, value: unknown) {
    const answer = attentionQuestionAnswer.parse(value);
    this.store.db.transaction(() => {
      const row = this.store.db.prepare("SELECT state FROM attention_questions WHERE id=? AND revision=?")
        .get(q.id, q.revision) as { state: string } | undefined;
      if (row?.state !== "pending" || !this.eligible(q.id, q.revision)) return;
      this.store.db.prepare("UPDATE attention_questions SET state='settled' WHERE id=? AND revision=?")
        .run(q.id, q.revision);
      if (answer.action === "reply") {
        const a = this.store.attention.get(q.id)!;
        this.store.db.prepare("INSERT INTO attention_question_replies(id,attention_id,room_id,text,revision) VALUES (?,?,?,?,?)")
          .run(randomUUID(), q.id, a.roomId, answer.text, q.revision);
      } else {
        this.store.attention.update(q.id, answer.action, answer.action === "snooze" ? 60 : undefined);
      }
    })();
    this.changed();
    return { title: answer.action === "reply" ? "Answer recorded for channel" : "Channel request updated",
      ...(answer.action === "reply" ? { detail: answer.text } : {}) };
  }

  private async restoreVisibility(threadId: string) {
    const row = this.store.db.prepare("SELECT thread_id FROM attention_question_visibility WHERE thread_id=?").get(threadId);
    if (!row) return;
    try {
      await this.bb.sdk.threads.update({ threadId, visibility: "hidden" });
    } catch (cause) {
      if (!missingThread(cause)) throw cause;
    }
    this.store.db.prepare("DELETE FROM attention_question_visibility WHERE thread_id=?").run(threadId);
  }

  private async flushReplies() {
    const rows = this.store.db.prepare(`SELECT a.* FROM attention_question_replies a
      JOIN rooms r ON r.id=a.room_id
      WHERE a.retry_at<=? AND COALESCE(json_extract(r.json,'$.archived'),0)=0
      ORDER BY a.rowid LIMIT 50`).all(Date.now()) as Reply[];
    for (const r of rows) {
      // Another reply can be discarded while an earlier send awaits the channel lock.
      if (this.sending.has(r.id) || !this.store.db.prepare("SELECT id FROM attention_question_replies WHERE id=?").get(r.id)) continue;
      // A deleted channel cannot receive an answer. Keep archived-channel answers for restoration.
      if (!this.store.findRoom(r.room_id)) {
        this.store.db.prepare("DELETE FROM attention_question_replies WHERE id=?").run(r.id);
        continue;
      }
      if (this.store.room(r.room_id).archived) continue;
      this.sending.add(r.id);
      try {
        await this.reply({ id: r.room_id, requestId: r.id, text: r.text, replyTo: r.attention_id });
      } catch (cause) {
        this.store.db.prepare("UPDATE attention_question_replies SET error=?,retry_at=? WHERE id=?")
          .run(String(cause).slice(0, 500), Date.now() + 30_000, r.id);
        this.changed();
        continue;
      } finally {
        this.sending.delete(r.id);
      }
      this.store.db.transaction(() => {
        const current = this.store.attention.get(r.attention_id);
        if (current?.status === "open" && current.revision === r.revision)
          this.store.attention.update(r.attention_id, "acknowledge");
        this.store.db.prepare("DELETE FROM attention_question_replies WHERE id=?").run(r.id);
      })();
      this.changed();
    }
  }

  discardReply(id: string) {
    if (this.sending.has(id)) throw new Error("This answer is being sent. Wait for delivery to finish.");
    const row = this.store.db.prepare("SELECT error FROM attention_question_replies WHERE id=?").get(id) as { error: string | null } | undefined;
    if (!row) throw new Error("This answer is no longer waiting to be sent. Refresh the inbox.");
    if (!row.error) throw new Error("Only a failed answer can be discarded.");
    this.store.db.prepare("DELETE FROM attention_question_replies WHERE id=?").run(id);
    this.changed();
    return { ok: true as const };
  }

  async tick(signal?: AbortSignal) {
    if (this.stopped || signal?.aborted) return;
    try {
    const enabled = (await this.preferences()).attentionNotifications;
    for (const a of this.active.values())
      if (!enabled || !this.eligible(a.question.id, a.question.revision)) a.abort.abort();

    // Restore visibility after shutdown/crash too. Issued revisions never auto-reprompt on reload.
    const leases = this.store.db.prepare("SELECT thread_id FROM attention_question_visibility").all() as { thread_id: string }[];
    for (const lease of leases)
      if (!this.active.has(lease.thread_id)) await this.restoreVisibility(lease.thread_id);
    if (Date.now() < this.retryAt) return;
      await this.flushReplies();
      if (!enabled) return;
      const candidates = this.store.db.prepare(`SELECT a.id, json_extract(a.json,'$.revision') AS revision
        FROM channel_attention a JOIN rooms r ON r.id=a.room_id
        LEFT JOIN attention_questions q ON q.id=a.id AND q.revision=json_extract(a.json,'$.revision')
        WHERE a.status='open' AND json_extract(a.json,'$.reason')!='update'
        AND COALESCE(json_extract(r.json,'$.archived'),0)=0 AND q.id IS NULL
        ORDER BY json_extract(a.json,'$.updatedAt')`)
        .all() as { id: string; revision: number }[];
      for (const candidate of candidates) {
        if (signal?.aborted || this.stopped) return;
        const a = this.eligible(candidate.id, candidate.revision);
        if (!a) continue;
        const message = this.store.message(a.id)!;
        const threadId = this.store.job(a.id)?.threadId ?? message.sourceThreadId;
        if (!threadId || this.active.has(threadId)) continue;
        const thread = await this.bb.sdk.threads.get({ threadId, signal }).catch(cause => {
          if (missingThread(cause)) return null;
          throw cause;
        });
        if (!thread || thread.deletedAt !== null || thread.archivedAt !== null) continue;
        // Only reveal a hidden conversation owned by Bot Teams, never another plugin's private thread.
        if (thread.visibility === "hidden" && !this.store.byThread(threadId)) continue;
        const pending = await this.bb.sdk.threads.interactions.list({ threadId, signal });
        if (pending.some(p => p.status === "pending")) continue;
        if (!this.eligible(a.id, a.revision) || signal?.aborted || this.stopped) continue;
        if (thread.visibility === "hidden") {
          this.store.db.prepare("INSERT OR IGNORE INTO attention_question_visibility VALUES (?)").run(threadId);
          await this.bb.sdk.threads.update({ threadId, visibility: "visible" });
        }
        if (!this.eligible(a.id, a.revision) || signal?.aborted || this.stopped) {
          await this.restoreVisibility(threadId);
          continue;
        }
        const q: Question = { id: a.id, revision: a.revision, thread_id: threadId, state: "pending" };
        this.store.db.prepare("INSERT INTO attention_questions VALUES (?,?,?,?)").run(q.id, q.revision, threadId, q.state);
        const abort = new AbortController();
        const requestSignal = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
        const room = this.store.room(a.roomId);
        const active: Active = { question: q, abort, done: Promise.resolve() };
        this.active.set(threadId, active);
        active.done = this.bb.ui.requestInput({
          threadId, rendererId: ATTENTION_QUESTION_RENDERER,
          title: `#${room.name} · ${message.speaker}: ${message.text}`.slice(0, 200),
          payload: { attentionId: a.id, roomId: a.roomId, channelName: room.name, speaker: message.speaker, text: message.text.slice(0, 8000) },
          timeoutMs: 60 * 60 * 1000,
          describeSubmission: value => this.finish(q, value),
        }, { signal: requestSignal }).then(result => {
          if (result.outcome === "submitted") this.finish(q, result.value);
          // Cancel/timeout leaves the durable inbox item open; snooze or reopen creates a new revision.
          this.store.db.prepare("UPDATE attention_questions SET state='settled' WHERE id=? AND revision=?").run(q.id, q.revision);
        }).catch(cause => {
          this.store.db.prepare("DELETE FROM attention_questions WHERE id=? AND revision=? AND state='pending'").run(q.id, q.revision);
          this.retryAt = Date.now() + 30_000;
          this.bb.log.warn(`Channel question could not open: ${String(cause)}`);
        }).finally(async () => {
          this.active.delete(threadId);
          try { await this.restoreVisibility(threadId); }
          catch (cause) { this.bb.log.warn(`Channel question visibility cleanup will retry: ${String(cause)}`); }
          this.changed();
        });
      }
    } catch (cause) {
      this.retryAt = Date.now() + 30_000;
      this.bb.log.warn(`Channel questions waiting: ${String(cause)}`);
    }
  }

  async dispose() {
    this.stopped = true;
    const active = [...this.active.values()];
    for (const a of active) a.abort.abort();
    await Promise.allSettled(active.map(a => a.done));
  }
}
