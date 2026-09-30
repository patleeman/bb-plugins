import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { CronExpressionParser } from "cron-parser";
import * as Y from "yjs";
import { actorColor, type BotDirectory, type BotInfo } from "./bots";
import { listThreads, threadAuthors } from "./comments";
import { HUMAN_USER_ID, PLUGIN_ID, REALTIME_CHANNEL, type RealtimeEvent } from "./constants";
import type { PageMetaView, RequestView } from "./contract";
import { applyEdits, mentionsIn, readMarkdown, restoreFromState, seedMarkdown, type EditOp, type EditResult } from "./doc";
import { PageHub, type Actor, type LivePage } from "./hub";
import { shortId } from "./markdown";
import { PageStore, type PageMeta, type RequestRow } from "./store";
import { absorbAgentChange, emptySeen, markSeen, notePresent, unseen, type Seen } from "./watch";

const SNAPSHOT_GAP_MS = 10 * 60_000;
const WATCH_DELAY_MS = 2500;
/** How long to wait before retrying requests when Studio Teams is unavailable. */
const BOTS_RETRY_MS = 60_000;
const MAX_CONTEXT_CHARS = 1200;
const REASONING_LEVELS = ["none", "low", "medium", "high", "xhigh", "max", "ultra", "ultracode"] as const;

export const pageUrl = (pageId: string) => `/plugins/${PLUGIN_ID}/pages/${pageId}`;

export function nextRun(cron: string, after: number): number | null {
  try {
    return CronExpressionParser.parse(cron, { currentDate: new Date(after) }).next().getTime();
  } catch {
    return null;
  }
}

export function validateCron(cron: string): string | null {
  try {
    CronExpressionParser.parse(cron);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function toView(meta: PageMeta): PageMetaView {
  const refresh =
    meta.refresh_bot_id && meta.refresh_cron
      ? {
          botId: meta.refresh_bot_id,
          cron: meta.refresh_cron,
          instructions: meta.refresh_instructions,
          lastAt: meta.refresh_last_at,
          nextAt: nextRun(meta.refresh_cron, meta.refresh_last_at ?? Date.now()),
        }
      : null;
  return {
    id: meta.id,
    projectId: meta.project_id,
    parentId: meta.parent_id,
    title: meta.title,
    icon: meta.icon,
    position: meta.position,
    createdAt: meta.created_at,
    updatedAt: meta.updated_at,
    updatedBy: meta.updated_by,
    archived: meta.archived_at !== null,
    refresh,
  };
}

export function requestView(row: RequestRow): RequestView {
  return {
    id: row.id,
    botId: row.bot_id,
    botName: row.bot_name,
    threadId: row.thread_id,
    kind: row.kind,
    blockId: row.block_id,
    commentThreadId: row.comment_thread_id,
    summary: row.summary,
    status: row.status,
    error: row.error,
    result: row.result,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface WatchState extends Seen {
  timer: ReturnType<typeof setTimeout> | null;
}

export class PagesService {
  readonly hub: PageHub;
  private readonly watch = new Map<string, WatchState>();
  private readonly actorNames = new Map<string, string>();
  /** Called after every realtime event, e.g. to tell Studio. */
  onPublish: ((event: RealtimeEvent) => void) | null = null;

  constructor(
    private readonly bb: BbPluginApi,
    readonly store: PageStore,
    readonly bots: BotDirectory,
  ) {
    this.hub = new PageHub({
      load: (pageId) => this.store.get(pageId)?.state ?? null,
      save: (pageId, doc, actors) => {
        const agent = actors.find((actor) => actor !== HUMAN_USER_ID);
        this.store.saveContent(pageId, Y.encodeStateAsUpdate(doc), readMarkdown(doc), agent ?? actors[0] ?? HUMAN_USER_ID);
        this.publish({ type: "page", pageId });
      },
      // Take the watcher's baseline at load, so a page's first human change
      // (say, a comment mentioning a bot) counts as new.
      // A page reopened with requests still pending (Studio Teams was
      // unavailable) gets another scan.
      opened: (page) => (this.watch.has(page.id) ? this.scheduleWatch(page) : void this.state(page)),
      changed: (page, origin) => {
        if (typeof origin === "string") this.absorb(page);
        else if (origin !== "load") {
          const state = this.watch.get(page.id);
          if (state) notePresent(state, this.found(page));
          this.scheduleWatch(page);
        }
      },
    });
  }

  publish(event: RealtimeEvent): void {
    try {
      this.bb.realtime.publish(REALTIME_CHANNEL, event);
    } catch {
      // Best effort; open views refetch on reconnect.
    }
    // Comment and bot-request traffic doesn't change what Studio lists.
    if (event.type !== "requests") this.onPublish?.(event);
  }

  // Pages -------------------------------------------------------------------

  requirePage(ref: string, projectId?: string | null): PageMeta {
    const trimmed = ref.trim();
    const byId = this.store.meta(trimmed);
    if (byId) return byId;
    const lower = trimmed.toLowerCase();
    const candidates = this.store.list({ projectId }).filter((page) => page.title.trim().toLowerCase() === lower);
    if (candidates.length === 1) return candidates[0]!;
    if (candidates.length > 1) {
      throw new Error(`Several pages are titled "${trimmed}": ${candidates.map((page) => page.id).join(", ")}. Use an id.`);
    }
    throw new Error(`No page "${trimmed}". Use pages_list to find page ids.`);
  }

  createPage(input: {
    projectId: string | null;
    parentId: string | null;
    title: string;
    icon?: string;
    markdown?: string;
    actor: string;
  }): PageMeta {
    if (input.parentId) {
      const parent = this.store.meta(input.parentId);
      if (!parent) throw new Error(`No parent page "${input.parentId}".`);
      input.projectId = parent.project_id;
    }
    const meta = this.store.create(input);
    const doc = new Y.Doc();
    seedMarkdown(doc, input.markdown ?? "");
    this.store.saveContent(meta.id, Y.encodeStateAsUpdate(doc), readMarkdown(doc), null);
    doc.destroy();
    this.publish({ type: "tree", projectId: meta.project_id });
    return this.store.meta(meta.id)!;
  }

  deletePage(id: string): string[] {
    const ids = [id, ...this.store.descendants(id)];
    for (const pageId of ids) this.hub.evict(pageId);
    this.store.delete(ids);
    this.publish({ type: "deleted", pageIds: ids });
    return ids;
  }

  // Actors ------------------------------------------------------------------

  async actorForThread(threadId: string): Promise<{ actor: Actor; bot: BotInfo | null }> {
    const bot = await this.bots.botForThread(threadId);
    if (bot) {
      const key = `bot:${bot.id}`;
      return { actor: { key, name: bot.name, color: actorColor(key) }, bot };
    }
    const key = `agent:${threadId}`;
    let name = this.actorNames.get(threadId);
    if (!name) {
      try {
        const thread = await this.bb.sdk.threads.get({ threadId });
        name = thread.title?.trim() ? `Agent · ${truncate(thread.title.trim(), 24)}` : "Agent";
      } catch {
        name = "Agent";
      }
      this.actorNames.set(threadId, name);
    }
    return { actor: { key, name, color: actorColor(key) }, bot: null };
  }

  // Agent edits ---------------------------------------------------------------

  /** Takes a restore point before an actor's first edit in a while. */
  snapshotBefore(page: LivePage, actor: Actor): void {
    const latest = this.store.latestSnapshot(page.id);
    if (latest && latest.actor === actor.key && Date.now() - latest.created_at < SNAPSHOT_GAP_MS) return;
    this.store.addSnapshot(page.id, Y.encodeStateAsUpdate(page.doc), `Before ${actor.name}`, actor.key);
  }

  edit(pageId: string, ops: EditOp[], actor: Actor): EditResult {
    const page = this.hub.open(pageId);
    this.snapshotBefore(page, actor);
    const result = applyEdits(page.doc, ops, actor.key);
    if (result.changed) {
      this.hub.showPresence(page, actor, result.touched[0] ?? null);
      this.markWorking(pageId, actor);
    }
    return result;
  }

  restore(snapshotId: string, actor: string): boolean {
    const snapshot = this.store.snapshotState(snapshotId);
    if (!snapshot) throw new Error("Snapshot not found.");
    const page = this.hub.open(snapshot.page_id);
    this.store.addSnapshot(page.id, Y.encodeStateAsUpdate(page.doc), "Before restore", actor);
    return restoreFromState(page.doc, new Uint8Array(snapshot.state), actor);
  }

  /** Marks a bot's open requests on this page as in progress. */
  markWorking(pageId: string, actor: Actor): void {
    if (!actor.key.startsWith("bot:")) return;
    const open = this.store.openRequestsForPage(pageId, actor.key.slice(4)).filter((row) => row.status === "queued");
    for (const row of open) this.store.updateRequest(row.id, { status: "working" });
    if (open.length) this.publish({ type: "requests", pageId });
  }

  // Bot requests --------------------------------------------------------------

  async dispatch(
    pageId: string,
    bot: BotInfo,
    kind: RequestRow["kind"],
    input: { dedupeKey: string; summary: string; prompt: string; blockId?: string | null; commentThreadId?: string | null },
  ): Promise<RequestRow | null> {
    const row = this.store.addRequest({
      page_id: pageId,
      bot_id: bot.id,
      bot_name: bot.name,
      kind,
      block_id: input.blockId ?? null,
      comment_thread_id: input.commentThreadId ?? null,
      summary: input.summary,
      dedupe_key: input.dedupeKey,
    });
    if (!row) return null;
    this.publish({ type: "requests", pageId });
    try {
      const threadId = await this.bots.conversationThread(bot.id);
      this.store.updateRequest(row.id, { thread_id: threadId });
      // Studio Teams creates a bot's DM without running it, and BB refuses a
      // send to a thread with no stored model, so name the bot's own model.
      const reasoningLevel = REASONING_LEVELS.find((level) => level === bot.reasoningLevel);
      await this.bb.sdk.threads.send({
        threadId,
        mode: "queue-if-active",
        input: [{ type: "text", text: input.prompt, mentions: [] }],
        ...(bot.model ? { model: bot.model } : {}),
        ...(reasoningLevel ? { reasoningLevel } : {}),
        executionInputSources: {
          ...(bot.model ? { model: "explicit" as const } : {}),
          ...(reasoningLevel ? { reasoningLevel: "explicit" as const } : {}),
        },
      });
    } catch (error) {
      this.store.updateRequest(row.id, { status: "failed", error: errorText(error) });
      this.bb.log.warn(`Sending a page request to ${bot.name} failed: ${errorText(error)}`);
    }
    this.publish({ type: "requests", pageId });
    return this.store.request(row.id);
  }

  requestPrompt(page: PageMeta, lines: string[]): string {
    return [
      `[Pages] ${lines[0]}`,
      "",
      ...lines.slice(1),
      "",
      `Page: "${page.title || "Untitled"}" (id ${page.id}, ${pageUrl(page.id)}).`,
      "Use pages_read to see the page with block ids, pages_edit to change it, and the pages_comment tools to answer in the page. The user sees your edits live.",
    ].join("\n");
  }

  onThreadActive(threadId: string): void {
    for (const row of this.store.openRequestsForThread(threadId)) {
      if (row.status !== "queued") continue;
      this.store.updateRequest(row.id, { status: "working" });
      this.publish({ type: "requests", pageId: row.page_id });
    }
  }

  onThreadSettled(threadId: string, outcome: { failed: boolean; text: string | null }): void {
    const rows = this.store.openRequestsForThread(threadId).filter((row) => row.status === "working");
    for (const row of rows) {
      this.store.updateRequest(row.id, {
        status: outcome.failed ? "failed" : "done",
        result: outcome.text ? truncate(outcome.text, 2000) : null,
        error: outcome.failed ? (outcome.text ?? "The bot's turn failed.") : null,
      });
      this.publish({ type: "requests", pageId: row.page_id });
    }
  }

  // Human-change watcher: new bot mentions and comments ------------------------

  private state(page: LivePage): WatchState {
    let state = this.watch.get(page.id);
    if (!state) {
      state = { ...emptySeen(), timer: null };
      this.watch.set(page.id, state);
      const found = this.found(page);
      markSeen(state, found);
      notePresent(state, found);
    }
    return state;
  }

  /** Records what an agent or bot wrote as seen without dispatching. */
  private absorb(page: LivePage): void {
    const state = this.watch.get(page.id);
    if (state) absorbAgentChange(state, this.found(page));
  }

  private found(page: LivePage) {
    return {
      mentions: mentionsIn(page.doc).filter((mention) => mention.kind === "bot"),
      comments: [...threadAuthors(page.doc)].flatMap(([threadId, thread]) =>
        thread.comments.map((comment) => ({ threadId, ...comment })),
      ),
    };
  }

  private scheduleWatch(page: LivePage, delay = WATCH_DELAY_MS): void {
    const state = this.state(page);
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = null;
      void this.scan(page.id).catch((error) => this.bb.log.warn(`Page watcher failed: ${errorText(error)}`));
    }, delay);
  }

  private async scan(pageId: string): Promise<void> {
    if (!this.hub.has(pageId)) return;
    const page = this.hub.open(pageId);
    const meta = this.store.meta(pageId);
    const state = this.watch.get(pageId);
    if (!meta || !state) return;
    const fresh = unseen(state, this.found(page));
    if (!fresh.mentions.length && !fresh.comments.length) return;
    const directory = await this.bots.list();
    if (!directory.available) {
      // Leave the requests unseen and try again; they go out once Studio Teams
      // is installed or enabled.
      if (this.hub.has(pageId)) this.scheduleWatch(page, BOTS_RETRY_MS);
      return;
    }
    markSeen(state, fresh);
    const markdown = readMarkdown(page.doc, { ids: true });

    for (const mention of fresh.mentions) {
      const bot = directory.bots.find((candidate) => candidate.id === mention.target);
      if (!bot) continue;
      const blockText = mention.text.trim() || "(the mention has no surrounding text)";
      await this.dispatch(pageId, bot, "mention", {
        dedupeKey: `mention:${pageId}:${mention.blockId}:${bot.id}`,
        blockId: mention.blockId,
        summary: truncate(blockText, 140),
        prompt: this.requestPrompt(meta, [
          `The user mentioned you in a page. Handle the request in block ^${shortId(mention.blockId)}:`,
          quote(blockText),
          "",
          "When you're done, reply by starting a comment on that block (pages_comment) with a short note of what you did, unless the request was only to edit the page.",
          "",
          "Current page:",
          truncate(markdown, 6000),
        ]),
      });
    }

    const threads = new Map(listThreads(page.doc, { includeResolved: true }).map((thread) => [thread.id, thread]));
    for (const comment of fresh.comments) {
      if (comment.author !== HUMAN_USER_ID) continue;
      const thread = threads.get(comment.threadId);
      if (!thread) continue;
      const named = await this.bots.mentionedIn(comment.text);
      const participants = thread.comments
        .filter((entry) => entry.author.startsWith("bot:"))
        .map((entry) => entry.author.slice(4));
      const targets = new Map<string, BotInfo>();
      for (const bot of named) targets.set(bot.id, bot);
      for (const id of participants) {
        const bot = directory.bots.find((candidate) => candidate.id === id);
        if (bot) targets.set(bot.id, bot);
      }
      for (const bot of targets.values()) {
        const history = thread.comments
          .map((entry) => `${entry.author === HUMAN_USER_ID ? "User" : entry.author.startsWith("bot:") ? (directory.bots.find((b) => `bot:${b.id}` === entry.author)?.name ?? "Bot") : "Agent"}: ${entry.text}`)
          .join("\n");
        await this.dispatch(pageId, bot, "comment", {
          dedupeKey: `comment:${comment.id}:${bot.id}`,
          blockId: thread.blockId,
          commentThreadId: thread.id,
          summary: truncate(comment.text, 140),
          prompt: this.requestPrompt(meta, [
            `The user wrote to you in comment thread ${thread.id}${thread.blockId ? ` on block ^${shortId(thread.blockId)}` : ""}.`,
            thread.quote ? `Commented text: ${quote(truncate(thread.quote, 300))}` : "",
            "Thread so far:",
            quote(truncate(history, MAX_CONTEXT_CHARS * 2)),
            "",
            `Reply with pages_comment_reply (thread ${thread.id}). If the user asked for a change, make it with pages_edit first. Resolve the thread only if the user asked you to.`,
          ]),
        });
      }
    }
  }

  // Scheduled refreshes ------------------------------------------------------

  async refresh(meta: PageMeta, reason: "schedule" | "manual"): Promise<RequestRow | null> {
    if (!meta.refresh_bot_id) throw new Error("This page has no refresh bot.");
    const bot = await this.bots.get(meta.refresh_bot_id);
    if (!bot) throw new Error("The refresh bot isn't available in Studio Teams.");
    const now = Date.now();
    this.store.markRefreshed(meta.id, now);
    this.publish({ type: "page", pageId: meta.id });
    return this.dispatch(meta.id, bot, "refresh", {
      dedupeKey: `refresh:${meta.id}:${now}`,
      summary: reason === "manual" ? "Refresh requested" : "Scheduled refresh",
      prompt: this.requestPrompt(meta, [
        `${reason === "manual" ? "The user asked you to refresh" : "It's time for your scheduled refresh of"} a page you keep up to date.`,
        "Instructions from the page owner:",
        quote(meta.refresh_instructions || "Keep the page's facts, numbers and status current."),
        "",
        "Gather the current information, then update only what changed with targeted pages_edit operations (keep the page's structure and the user's wording). Finish with a one-paragraph summary of what changed; Pages shows it in the page's activity.",
      ]),
    });
  }

  async runDueRefreshes(): Promise<void> {
    const now = Date.now();
    for (const meta of this.store.refreshable()) {
      const next = nextRun(meta.refresh_cron!, meta.refresh_last_at ?? meta.created_at);
      if (next === null || next > now) continue;
      const busy = this.store
        .openRequestsForPage(meta.id, meta.refresh_bot_id!)
        .some((row) => row.kind === "refresh" && now - row.created_at < 6 * 3600_000);
      if (busy) continue;
      try {
        await this.refresh(meta, "schedule");
      } catch (error) {
        this.bb.log.warn(`Refreshing page ${meta.id} failed: ${errorText(error)}`);
        this.store.markRefreshed(meta.id, now);
      }
    }
  }

  dispose(): void {
    for (const state of this.watch.values()) if (state.timer) clearTimeout(state.timer);
    this.hub.disposeAll();
  }
}

const quote = (text: string) =>
  text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
export const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
export const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
