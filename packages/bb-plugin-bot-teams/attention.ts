import { fromMarkdown } from "mdast-util-from-markdown";
import type { RootContent } from "mdast";
import {
  attentionSchema,
  type Attention,
  type AttentionView,
  type RoomMessage,
} from "./contract";
import type { Store } from "./store";

export function mentionsOwner(text: string): boolean {
  const visit = (node: RootContent): boolean => {
    if (
      [
        "code",
        "inlineCode",
        "blockquote",
        "link",
        "linkReference",
        "image",
        "imageReference",
      ].includes(node.type)
    )
      return false;
    if (node.type === "text")
      return /(^|[^a-zA-Z0-9_./-])@user(?![a-zA-Z0-9_-]|\.[a-zA-Z0-9_-])/i.test(
        node.value.replace(/https?:\/\/\S+/gi, ""),
      );
    return "children" in node && node.children.some(visit);
  };
  return fromMarkdown(text).children.some(visit);
}

export class AttentionStore {
  constructor(private store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS channel_attention (
      id TEXT PRIMARY KEY, room_id TEXT NOT NULL, status TEXT NOT NULL,
      snoozed_until INTEGER, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS attention_by_status ON channel_attention(status,snoozed_until);
      CREATE INDEX IF NOT EXISTS attention_by_room ON channel_attention(room_id);
      CREATE TABLE IF NOT EXISTS attention_questions (
        id TEXT NOT NULL, revision INTEGER NOT NULL, thread_id TEXT NOT NULL,
        state TEXT NOT NULL, PRIMARY KEY(id,revision));
      CREATE TABLE IF NOT EXISTS attention_question_visibility (thread_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS attention_question_replies (
        id TEXT PRIMARY KEY, attention_id TEXT NOT NULL, room_id TEXT NOT NULL, text TEXT NOT NULL,
        revision INTEGER NOT NULL, error TEXT, retry_at INTEGER NOT NULL DEFAULT 0);`);
  }
  get(id: string): Attention | null {
    const row = this.store.db
      .prepare("SELECT json FROM channel_attention WHERE id=?")
      .get(id) as { json: string } | undefined;
    return row ? attentionSchema.parse(JSON.parse(row.json)) : null;
  }
  counts(): Record<string, number> {
    const rows = this.store.db.prepare(`SELECT a.room_id, count(*) AS n
      FROM channel_attention a JOIN rooms r ON r.id=a.room_id
      WHERE a.status='open' AND COALESCE(json_extract(r.json,'$.archived'),0)=0
      GROUP BY a.room_id`).all() as { room_id: string; n: number }[];
    return Object.fromEntries(rows.map(r => [r.room_id, r.n]));
  }
  private put(value: Attention) {
    this.store.db
      .prepare(
        `INSERT INTO channel_attention VALUES (?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status,snoozed_until=excluded.snoozed_until,json=excluded.json`,
      )
      .run(
        value.id,
        value.roomId,
        value.status,
        value.snoozedUntil,
        JSON.stringify(value),
      );
  }
  view(value: Attention): AttentionView {
    const message = this.store.message(value.id);
    if (!message) throw new Error("Attention message not found.");
    return {
      ...value,
      channelName: this.store.room(value.roomId).name,
      message,
      pendingReply: (this.store.db.prepare("SELECT id,text,error FROM attention_question_replies WHERE attention_id=? ORDER BY rowid LIMIT 1").get(value.id) as { id: string; text: string; error: string | null } | undefined) ?? null,
    };
  }
  capture(message: RoomMessage) {
    if (
      message.system ||
      (!message.attentionReason &&
        !(message.botId && mentionsOwner(message.text)))
    )
      return false;
    if (this.get(message.id)) return true;
    const now = Date.now();
    const value: Attention = {
      id: message.id,
      roomId: message.roomId,
      reason: message.attentionReason ?? "decision",
      status: "open",
      snoozedUntil: null,
      revision: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.put(value);
    this.queue(value);
    return true;
  }
  private queue(value: Attention) {
    this.store.queueNotification(
      `attention:${value.id}:${value.revision}`,
      value.roomId,
      "attention",
      value.id,
    );
  }
  update(
    id: string,
    action: "acknowledge" | "snooze" | "reopen",
    minutes?: number,
  ): AttentionView {
    return this.store.db.transaction(() => {
      const value = this.get(id);
      if (!value) throw new Error("Attention request not found.");
      const now = Date.now();
      const status =
        action === "acknowledge"
          ? "acknowledged"
          : action === "snooze"
            ? "snoozed"
            : "open";
      if (status === value.status && status !== "snoozed")
        return this.view(value);
      if (action === "snooze" && (!minutes || minutes < 1 || minutes > 43200))
        throw new Error("Choose a snooze from 1 minute to 30 days.");
      const next: Attention = {
        ...value,
        status,
        snoozedUntil: status === "snoozed" ? now + minutes! * 60000 : null,
        revision: value.revision + 1,
        updatedAt: now,
      };
      this.put(next);
      if (next.status === "open") this.queue(next);
      return this.view(next);
    })();
  }
  wake(now = Date.now()) {
    return this.store.db.transaction(() => {
      const rows = this.store.db
        .prepare(
          "SELECT json FROM channel_attention WHERE status='snoozed' AND snoozed_until<=? LIMIT 100",
        )
        .all(now) as { json: string }[];
      for (const row of rows) {
        const value = attentionSchema.parse(JSON.parse(row.json));
        const next: Attention = {
          ...value,
          status: "open",
          snoozedUntil: null,
          revision: value.revision + 1,
          updatedAt: now,
        };
        this.put(next);
        this.queue(next);
      }
      return rows.length;
    })();
  }
  list(
    status: Attention["status"],
    limit: number,
    offset: number,
    channelId?: string,
  ) {
    const active = `FROM channel_attention a JOIN rooms r ON r.id=a.room_id
      WHERE COALESCE(json_extract(r.json,'$.archived'),0)=0`;
    const rows = this.store.db
      .prepare(
        `SELECT a.json ${active} AND a.status=?
      AND (? IS NULL OR a.room_id=?) ORDER BY json_extract(a.json,'$.updatedAt') DESC,a.id DESC LIMIT ? OFFSET ?`,
      )
      .all(status, channelId ?? null, channelId ?? null, limit + 1, offset) as {
      json: string;
    }[];
    const count = this.store.db
      .prepare(`SELECT count(*) AS n ${active} AND a.status='open'`)
      .get() as { n: number };
    return {
      items: rows
        .slice(0, limit)
        .map((row) => this.view(attentionSchema.parse(JSON.parse(row.json)))),
      openCount: count.n,
      nextOffset: rows.length > limit ? offset + limit : null,
    };
  }
}
