import type { Store } from "./store";

type Reply = {
  id: string;
  attention_id: string;
  room_id: string;
  text: string;
  revision: number;
};

export class StaleAttentionReplyError extends Error {}

export class AttentionReplies {
  private retryAt = 0;
  private sending = new Set<string>();

  constructor(
    private store: Store,
    private reply: (input: {
      id: string;
      requestId: string;
      text: string;
      replyTo: string;
      attentionId: string;
      revision: number;
    }) => Promise<unknown>,
    private changed: () => void,
    private log: (message: string) => void,
  ) {}

  async tick(signal?: AbortSignal) {
    if (signal?.aborted || Date.now() < this.retryAt) return;
    try {
      const rows = this.store.db.prepare(`SELECT a.* FROM attention_question_replies a
        JOIN rooms r ON r.id=a.room_id
        WHERE a.retry_at<=? AND COALESCE(json_extract(r.json,'$.archived'),0)=0
        ORDER BY a.rowid LIMIT 50`).all(Date.now()) as Reply[];
      for (const row of rows) {
        if (signal?.aborted) return;
        if (this.sending.has(row.id) || !this.store.db.prepare(
          "SELECT id FROM attention_question_replies WHERE id=?",
        ).get(row.id)) continue;
        if (!this.store.findRoom(row.room_id)) {
          this.store.db.prepare("DELETE FROM attention_question_replies WHERE id=?").run(row.id);
          continue;
        }
        if (this.store.room(row.room_id).archived) continue;
        const request = this.store.attention.get(row.attention_id);
        if (request?.status !== "open" || request.revision !== row.revision) {
          this.store.db.prepare("DELETE FROM attention_question_replies WHERE id=?").run(row.id);
          this.changed();
          continue;
        }
        this.sending.add(row.id);
        try {
          await this.reply({
            id: row.room_id,
            requestId: row.id,
            text: row.text,
            replyTo: row.attention_id,
            attentionId: row.attention_id,
            revision: row.revision,
          });
        } catch (cause) {
          if (cause instanceof StaleAttentionReplyError) {
            this.store.db.prepare("DELETE FROM attention_question_replies WHERE id=?").run(row.id);
            this.changed();
            continue;
          }
          this.store.db.prepare("UPDATE attention_question_replies SET error=?,retry_at=? WHERE id=?")
            .run(String(cause).slice(0, 500), Date.now() + 30_000, row.id);
          this.changed();
          this.retryAt = Date.now() + 30_000;
          continue;
        } finally {
          this.sending.delete(row.id);
        }
        this.store.db.transaction(() => {
          const current = this.store.attention.get(row.attention_id);
          if (current?.status === "open" && current.revision === row.revision)
            this.store.attention.update(row.attention_id, "acknowledge");
          this.store.db.prepare("DELETE FROM attention_question_replies WHERE id=?").run(row.id);
        })();
        this.changed();
      }
    } catch (cause) {
      this.retryAt = Date.now() + 30_000;
      this.log(`Attention reply delivery waiting: ${String(cause)}`);
    }
  }

  discardReply(id: string) {
    if (this.sending.has(id)) throw new Error("This answer is being sent. Wait for delivery to finish.");
    const row = this.store.db.prepare("SELECT error FROM attention_question_replies WHERE id=?")
      .get(id) as { error: string | null } | undefined;
    if (!row) throw new Error("This answer is no longer waiting to be sent. Refresh the inbox.");
    if (!row.error) throw new Error("Only a failed answer can be discarded.");
    this.store.db.prepare("DELETE FROM attention_question_replies WHERE id=?").run(id);
    this.changed();
    return { ok: true as const };
  }
}
