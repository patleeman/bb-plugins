import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { createThread, listThreads, reply, setResolved, type ThreadView } from "./comments";
import { readMarkdown, type EditOp } from "./doc";
import { shortId } from "./markdown";
import { errorText, pageUrl, truncate, type PagesService } from "./service";
import type { PageMeta } from "./store";

const MAX_READ_CHARS = 60_000;

export const TOOL_NAMES = [
  "pages_list",
  "pages_read",
  "pages_create",
  "pages_edit",
  "pages_comments",
  "pages_comment",
  "pages_comment_reply",
  "pages_comment_resolve",
] as const;

export const AGENT_INSTRUCTIONS = [
  "BB Pages are collaborative documents the user edits live. Read a page with pages_read before changing it; it returns Markdown with a `<!-- ^id -->` marker on the line before each block, naming the block below it.",
  "Edit with pages_edit using small, targeted operations that reference those block ids, so you don't overwrite the user's concurrent typing. Use replace_all only when asked to rewrite a whole page.",
  "Pages Markdown supports GFM plus: ```chart / ```stats / ```embed fenced JSON blocks, ```mermaid diagrams, `> [!NOTE]` callouts (NOTE, TIP, WARNING, CAUTION, IMPORTANT), and mentions like @[Name](bot:bot_id), @[Title](page:pg_id), @[Title](item:plugin:id), @[2026-10-01](date:2026-10-01).",
  'Chart JSON: {"type":"bar|line|area|pie","title":"…","x":"label","series":["Revenue"],"unit":"$","data":[{"label":"Q1","Revenue":10}]}. Stats JSON: [{"label":"ARR","value":"$1.2M","delta":"+8%","trend":"up"}] (1–6 items). Embed JSON: {"kind":"bookmark|thread|page|drawing|artifact|recording|task|item","target":"https://… or an id","title":"…"}; item targets are plugin:id from studio_list_items.',
  "Answer comments with pages_comment_reply in the same thread; start new threads with pages_comment on the text you are discussing.",
].join("\n");

const ref = z.string().min(1).describe("Page id (pg_…) or exact page title");
const block = z.string().min(4).describe("Block id or its first 8 characters, from the `<!-- ^id -->` markers in pages_read");

const opSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("insert_after"), block, markdown: z.string() }),
  z.object({ op: z.literal("insert_before"), block, markdown: z.string() }),
  z.object({ op: z.literal("replace"), block, markdown: z.string().describe("Replacement Markdown; may be several blocks") }),
  z.object({ op: z.literal("append"), markdown: z.string() }),
  z.object({ op: z.literal("prepend"), markdown: z.string() }),
  z.object({ op: z.literal("delete"), block }),
  z.object({ op: z.literal("set_checked"), block, checked: z.boolean() }),
  z.object({
    op: z.literal("replace_text"),
    block: block.optional().describe("Limit to one block; otherwise the first match in the page"),
    find: z.string().min(1),
    replace: z.string(),
  }),
  z.object({ op: z.literal("replace_all"), markdown: z.string() }),
]);

export function registerTools(bb: BbPluginApi, service: PagesService): void {
  const { store } = service;

  const pageLine = (page: PageMeta, depth = 0) =>
    `${"  ".repeat(depth)}- ${page.icon ? `${page.icon} ` : ""}${page.title || "Untitled"} (id ${page.id}${page.project_id ? "" : ", global"})`;

  bb.agents.registerTool({
    name: "pages_list",
    description: "List BB Pages (collaborative documents) in this project and global pages, as a tree. Optionally search titles and content.",
    parameters: z.object({ query: z.string().max(200).optional() }),
    execute({ query }, ctx) {
      if (query?.trim()) {
        const hits = store.search(query, ctx.projectId);
        return hits.length ? hits.map((page) => pageLine(page)).join("\n") : `No pages match "${query}".`;
      }
      const pages = store.list({ projectId: ctx.projectId });
      if (!pages.length) return "No pages yet. Create one with pages_create.";
      const children = new Map<string | null, PageMeta[]>();
      for (const page of pages) {
        const parent = page.parent_id && pages.some((p) => p.id === page.parent_id) ? page.parent_id : null;
        children.set(parent, [...(children.get(parent) ?? []), page]);
      }
      const lines: string[] = [];
      const walk = (parent: string | null, depth: number) => {
        for (const page of children.get(parent) ?? []) {
          lines.push(pageLine(page, depth));
          walk(page.id, depth + 1);
        }
      };
      walk(null, 0);
      return lines.join("\n");
    },
  });

  bb.agents.registerTool({
    name: "pages_read",
    description:
      "Read a BB Page as Markdown with a `<!-- ^id -->` block-id marker on the line before each block (it names the block below it), plus its open comment threads. Always read right before editing: the user may have changed it.",
    parameters: z.object({ page: ref }),
    execute({ page }, ctx) {
      const meta = service.requirePage(page, ctx.projectId);
      const live = service.hub.open(meta.id);
      const markdown = readMarkdown(live.doc, { ids: true });
      const threads = listThreads(live.doc);
      return truncate(
        [
          `# ${meta.icon ? `${meta.icon} ` : ""}${meta.title || "Untitled"}`,
          `Page id ${meta.id} · ${meta.project_id ? "project page" : "global page"} · ${pageUrl(meta.id)}`,
          "",
          markdown.trim() || "(empty page)",
          ...(threads.length ? ["", "## Open comments", ...threads.map(threadSummary)] : []),
        ].join("\n"),
        MAX_READ_CHARS,
      );
    },
  });

  bb.agents.registerTool({
    name: "pages_create",
    description: "Create a BB Page from Markdown. Pages belong to the current project unless global is true; set parent to nest it.",
    parameters: z.object({
      title: z.string().min(1).max(200),
      markdown: z.string().max(200_000).optional(),
      icon: z.string().max(16).optional().describe("One emoji"),
      parent: ref.optional(),
      global: z.boolean().optional(),
    }),
    async execute(params, ctx) {
      const { actor } = await service.actorForThread(ctx.threadId);
      const parent = params.parent ? service.requirePage(params.parent, ctx.projectId) : null;
      const page = service.createPage({
        projectId: params.global ? null : ctx.projectId,
        parentId: parent?.id ?? null,
        title: params.title,
        icon: params.icon,
        markdown: params.markdown,
        actor: actor.key,
      });
      return `Created page "${page.title}" (id ${page.id}). The user can open it at ${pageUrl(page.id)}.`;
    },
  });

  bb.agents.registerTool({
    name: "pages_edit",
    description:
      "Edit a BB Page live with targeted operations: insert_after/insert_before/replace/delete/set_checked by block id, append/prepend, replace_text (keeps formatting), or replace_all. Optionally set the title or icon. Ops apply in order as one change.",
    parameters: z.object({
      page: ref,
      ops: z.array(opSchema).max(100).default([]),
      title: z.string().max(200).optional(),
      icon: z.string().max(16).optional(),
    }),
    async execute(params, ctx) {
      const meta = service.requirePage(params.page, ctx.projectId);
      const { actor } = await service.actorForThread(ctx.threadId);
      try {
        const result = params.ops.length ? service.edit(meta.id, params.ops as EditOp[], actor) : { changed: false, touched: [] };
        if (params.title !== undefined || params.icon !== undefined) {
          store.update(meta.id, { title: params.title, icon: params.icon }, actor.key);
          service.publish({ type: "tree", projectId: meta.project_id });
        }
        const touched = result.touched.map((id) => `^${shortId(id)}`).join(", ");
        return result.changed
          ? `Updated "${params.title ?? meta.title}".${touched ? ` Changed blocks: ${touched}.` : ""}`
          : params.title !== undefined || params.icon !== undefined
            ? "Updated the page header; the content was already as requested."
            : "Nothing changed; the page already matched.";
      } catch (error) {
        return { content: [{ type: "text", text: `Edit failed, nothing was changed: ${errorText(error)}` }], isError: true };
      }
    },
  });

  bb.agents.registerTool({
    name: "pages_comments",
    description: "List comment threads on a BB Page with their ids, the commented text and replies.",
    parameters: z.object({ page: ref, includeResolved: z.boolean().optional() }),
    execute({ page, includeResolved }, ctx) {
      const meta = service.requirePage(page, ctx.projectId);
      const threads = listThreads(service.hub.open(meta.id).doc, { includeResolved });
      return threads.length ? truncate(threads.map(threadSummary).join("\n"), MAX_READ_CHARS) : "No comments.";
    },
  });

  bb.agents.registerTool({
    name: "pages_comment",
    description: "Start a comment thread on a block of a BB Page, optionally anchored to an exact quote from that block.",
    parameters: z.object({
      page: ref,
      block,
      quote: z.string().max(500).optional().describe("Exact text in the block to highlight; defaults to the whole block"),
      text: z.string().min(1).max(8000),
    }),
    async execute(params, ctx) {
      const meta = service.requirePage(params.page, ctx.projectId);
      const { actor } = await service.actorForThread(ctx.threadId);
      const live = service.hub.open(meta.id);
      try {
        const { threadId, blockId } = await createThread(live.doc, actor.key, params, actor.key);
        service.hub.showPresence(live, actor, blockId);
        service.markWorking(meta.id, actor);
        return `Started comment thread ${threadId} on block ^${shortId(blockId)}.`;
      } catch (error) {
        return { content: [{ type: "text", text: errorText(error) }], isError: true };
      }
    },
  });

  bb.agents.registerTool({
    name: "pages_comment_reply",
    description: "Reply in a comment thread on a BB Page.",
    parameters: z.object({ page: ref, thread: z.string().min(1), text: z.string().min(1).max(8000) }),
    async execute(params, ctx) {
      const meta = service.requirePage(params.page, ctx.projectId);
      const { actor } = await service.actorForThread(ctx.threadId);
      const live = service.hub.open(meta.id);
      try {
        reply(live.doc, actor.key, params.thread, params.text, actor.key);
        const anchor = listThreads(live.doc, { includeResolved: true }).find((thread) => thread.id === params.thread);
        service.hub.showPresence(live, actor, anchor?.blockId ?? null);
        service.markWorking(meta.id, actor);
        return "Replied.";
      } catch (error) {
        return { content: [{ type: "text", text: errorText(error) }], isError: true };
      }
    },
  });

  bb.agents.registerTool({
    name: "pages_comment_resolve",
    description: "Resolve (or reopen) a comment thread on a BB Page once it has been addressed.",
    parameters: z.object({ page: ref, thread: z.string().min(1), resolved: z.boolean().default(true) }),
    async execute(params, ctx) {
      const meta = service.requirePage(params.page, ctx.projectId);
      const { actor } = await service.actorForThread(ctx.threadId);
      try {
        setResolved(service.hub.open(meta.id).doc, actor.key, params.thread, params.resolved, actor.key);
        return params.resolved ? "Resolved." : "Reopened.";
      } catch (error) {
        return { content: [{ type: "text", text: errorText(error) }], isError: true };
      }
    },
  });

  bb.agents.configure(() => ({ tools: [...TOOL_NAMES], skills: [], instructions: AGENT_INSTRUCTIONS }));
}

function threadSummary(thread: ThreadView): string {
  const head = `- Thread ${thread.id}${thread.resolved ? " (resolved)" : ""}${thread.blockId ? ` on ^${shortId(thread.blockId)}` : ""}${thread.quote ? ` "${truncate(thread.quote, 120)}"` : ""}`;
  const comments = thread.comments.map((comment) => `  - ${authorLabel(comment.author)}: ${truncate(comment.text, 800)}`);
  return [head, ...comments].join("\n");
}

export function authorLabel(author: string): string {
  if (author === "user") return "User";
  if (author.startsWith("bot:")) return `Bot ${author.slice(4)}`;
  if (author.startsWith("agent:")) return `Agent (${author.slice(6)})`;
  return author;
}
