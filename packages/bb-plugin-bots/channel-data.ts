import { Store } from "./store";
import {
  channelContext,
  contextContent,
  defaultLimits,
  type ChannelContext,
} from "./workspace-contract";
import type { z } from "zod";

/** Versioned channel knowledge and snapshots of the bot's plain-text documents. */
export class ChannelData {
  constructor(readonly store: Store) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS channel_context (room_id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS document_revisions (id INTEGER PRIMARY KEY, scope TEXT NOT NULL, text TEXT NOT NULL, actor TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS revisions_by_scope ON document_revisions(scope,id);
      CREATE TABLE IF NOT EXISTS routing_usage (id INTEGER PRIMARY KEY, room_id TEXT NOT NULL, created_at INTEGER NOT NULL, duration_ms INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS routing_usage_by_room ON routing_usage(room_id,created_at);
    `);
  }
  context(id: string): ChannelContext {
    this.store.room(id);
    const row = this.store.db
      .prepare("SELECT json FROM channel_context WHERE room_id=?")
      .get(id) as { json: string } | undefined;
    return row
      ? channelContext.parse(JSON.parse(row.json))
      : { ...contextContent.parse({}), version: 0, updatedAt: 0 };
  }
  saveContext(
    id: string,
    input: z.infer<typeof contextContent>,
    version: number,
    actor: string,
  ) {
    return this.store.db.transaction(() => {
      const previous = this.context(id);
      if (previous.version !== version)
        throw new Error(
          "Channel context changed. Reload before saving; your draft is preserved.",
        );
      for (const aid of input.attachmentIds) {
        const attachment = this.store.attachment(aid);
        if (
          !attachment ||
          attachment.roomId !== id ||
          !attachment.path ||
          !this.store.db
            .prepare(
              "SELECT 1 FROM room_messages m,json_each(m.json,'$.attachments') a WHERE m.room_id=? AND json_extract(a.value,'$.id')=? LIMIT 1",
            )
            .get(id, aid)
        )
          throw new Error("Choose a sent file from this channel.");
      }
      this.snapshot(
        `channel:${id}`,
        JSON.stringify(previous),
        "Previous version",
      );
      const next = {
        ...input,
        version: previous.version + 1,
        updatedAt: Date.now(),
      };
      this.store.db
        .prepare(
          "INSERT INTO channel_context VALUES (?,?) ON CONFLICT(room_id) DO UPDATE SET json=excluded.json",
        )
        .run(id, JSON.stringify(next));
      this.snapshot(`channel:${id}`, JSON.stringify(next), actor);
      return next;
    })();
  }
  snapshot(scope: string, text: string, actor: string) {
    const previous = this.store.db
      .prepare(
        "SELECT text FROM document_revisions WHERE scope=? ORDER BY id DESC LIMIT 1",
      )
      .get(scope) as { text: string } | undefined;
    if (previous?.text === text) return;
    this.store.db
      .prepare(
        "INSERT INTO document_revisions(scope,text,actor,created_at) VALUES (?,?,?,?)",
      )
      .run(scope, text, actor, Date.now());
  }
  revisions(scope: string, before = Number.MAX_SAFE_INTEGER) {
    return this.store.db
      .prepare(
        "SELECT id,text,actor,created_at AS createdAt FROM document_revisions WHERE scope=? AND id<? ORDER BY id DESC LIMIT 20",
      )
      .all(scope, before) as {
      id: number;
      text: string;
      actor: string;
      createdAt: number;
    }[];
  }
  files(id: string, before?: string) {
    this.store.room(id);
    // Only sent attachments are retained here; unclaimed draft uploads are private drafts.
    const rows = this.store.db
      .prepare(
        `SELECT json FROM attachments WHERE json_extract(json,'$.roomId')=?
      AND id IN (SELECT json_extract(a.value,'$.id') FROM room_messages m,json_each(m.json,'$.attachments') a WHERE m.room_id=?) AND (? IS NULL OR rowid < (SELECT rowid FROM attachments WHERE id=?))
      ORDER BY rowid DESC LIMIT 51`,
      )
      .all(id, id, before ?? null, before ?? null) as { json: string }[];
    const files = rows.slice(0, 50).map((r) => JSON.parse(r.json));
    return {
      files,
      nextBefore: rows.length > 50 ? (files.at(-1)!.id as string) : null,
    };
  }
  usage(roomId?: string, botId?: string) {
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const limits =
      (botId
        ? this.store.get(botId).limits
        : roomId
          ? this.store.room(roomId).limits
          : undefined) ?? defaultLimits;
    const rows = this.store.db
      .prepare(
        `SELECT
      COALESCE(SUM(COALESCE(json_extract(json,'$.startedAt'),json_extract(json,'$.dispatchStartedAt')) IS NOT NULL),0) AS turns,
      COALESCE(SUM(json_extract(json,'$.conversationKey') LIKE '%:fork:%' AND COALESCE(json_extract(json,'$.startedAt'),json_extract(json,'$.dispatchStartedAt')) IS NOT NULL),0) AS forks,
      COALESCE(SUM(status IN ('running','dispatching','queued')),0) AS active,
      COALESCE(SUM(status='error'),0) AS errors
      FROM jobs WHERE COALESCE(json_extract(json,'$.startedAt'),json_extract(json,'$.dispatchStartedAt'),created_at)>=?
      ${roomId ? "AND json_extract(json,'$.roomId')=?" : ""} ${botId ? "AND bot_id=?" : ""}`,
      )
      .get(since, ...(roomId ? [roomId] : []), ...(botId ? [botId] : [])) as {
      turns: number;
      forks: number;
      active: number;
      errors: number;
    };
    const routing = roomId
      ? (this.store.db
          .prepare(
            "SELECT COUNT(*) AS routingCalls,COALESCE(SUM(duration_ms),0) AS routingMilliseconds FROM routing_usage WHERE room_id=? AND created_at>=?",
          )
          .get(roomId, since) as {
          routingCalls: number;
          routingMilliseconds: number;
        })
      : { routingCalls: 0, routingMilliseconds: 0 };
    return { ...rows, ...routing, since, limits };
  }
}
