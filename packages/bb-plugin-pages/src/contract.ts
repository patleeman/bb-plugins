import { defineRpcContract, type NewThreadRequest } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { exploreMethods } from "./explore/contract";

export * from "./constants";

// RPC surface for the Pages app. Document content does not go through RPC:
// editors sync over the `/sync` WebSocket (src/hub.ts).

const pageId = z.string().regex(/^pg_[a-f0-9]{12}$/);
const projectId = z.string().min(1).max(200).nullable();

export const studioItemSchema = z.object({
  pluginId: z.string(),
  id: z.string(),
  kind: z.string(),
  kindLabel: z.string(),
  kindIcon: z.string(),
  title: z.string(),
  icon: z.string().nullable(),
  preview: z.string().nullable(),
  facts: z.array(z.string()),
  badge: z.string().nullable(),
  thumbnailUrl: z.string().nullable(),
  href: z.string(),
  updatedAt: z.number(),
});

export type StudioEmbedItem = z.infer<typeof studioItemSchema>;

export const refreshSchema = z.object({
  botId: z.string(),
  cron: z.string().min(1).max(120),
  instructions: z.string().max(4000),
  lastAt: z.number().nullable(),
  nextAt: z.number().nullable(),
});

export const pageMetaSchema = z.object({
  id: z.string(),
  projectId: z.string().nullable(),
  parentId: z.string().nullable(),
  title: z.string(),
  icon: z.string(),
  position: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
  updatedBy: z.string(),
  archived: z.boolean(),
  refresh: refreshSchema.nullable(),
});
export type PageMetaView = z.infer<typeof pageMetaSchema>;

export const botSchema = z.object({
  id: z.string(),
  name: z.string(),
  handle: z.string(),
  avatar: z.string(),
  description: z.string(),
  working: z.boolean(),
});
export type BotView = z.infer<typeof botSchema>;

export const requestSchema = z.object({
  id: z.string(),
  botId: z.string(),
  botName: z.string(),
  threadId: z.string().nullable(),
  kind: z.enum(["mention", "comment", "refresh"]),
  blockId: z.string().nullable(),
  commentThreadId: z.string().nullable(),
  summary: z.string(),
  status: z.enum(["queued", "working", "done", "failed"]),
  error: z.string().nullable(),
  result: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type RequestView = z.infer<typeof requestSchema>;

export const snapshotSchema = z.object({
  id: z.string(),
  label: z.string(),
  actor: z.string(),
  createdAt: z.number(),
});
export type SnapshotView = z.infer<typeof snapshotSchema>;

// What BB's new-thread composer submits, whitelisted like Studio Teams does. Core
// threads.spawn validates the host-owned environment and prompt input.
export const chatRequestSchema = z.object({
  projectId: z.string().min(1),
  providerId: z.string().min(1),
  model: z.string(),
  reasoningLevel: z.enum(["none", "low", "medium", "high", "xhigh", "max", "ultra", "ultracode"]),
  permissionMode: z.enum(["accept-edits", "auto", "full"]),
  serviceTier: z.enum(["default", "fast"]).optional(),
  executionInputSources: z.object({
    model: z.enum(["client-preference", "explicit"]).optional(),
    permissionMode: z.enum(["client-preference", "explicit"]).optional(),
    providerId: z.enum(["client-preference", "explicit"]).optional(),
    reasoningLevel: z.enum(["client-preference", "explicit"]).optional(),
    serviceTier: z.enum(["client-preference", "explicit"]).optional(),
  }),
  environment: z.record(z.string(), z.json()).transform((value) => value as NewThreadRequest["environment"]),
  input: z
    .array(z.record(z.string(), z.json()))
    .min(1)
    .transform((value) => value as NewThreadRequest["input"]),
  sendAt: z.number().int().positive().optional(),
});

export const rpcContract = defineRpcContract({
  tree: {
    /** Omit `projectId` for every page; otherwise a project's pages plus global ones. */
    input: z.object({ projectId: projectId.optional() }),
    output: z.object({ pages: z.array(pageMetaSchema) }),
  },
  create: {
    input: z.object({
      projectId,
      parentId: pageId.nullable(),
      title: z.string().max(200).default(""),
      icon: z.string().max(16).optional(),
      markdown: z.string().max(200_000).optional(),
    }),
    output: z.object({ page: pageMetaSchema }),
  },
  update: {
    input: z.object({
      id: pageId,
      title: z.string().max(200).optional(),
      icon: z.string().max(16).optional(),
      parentId: pageId.nullable().optional(),
      projectId: projectId.optional(),
      position: z.number().optional(),
      archived: z.boolean().optional(),
    }),
    output: z.object({ page: pageMetaSchema }),
  },
  remove: {
    input: z.object({ id: pageId }),
    output: z.object({ deleted: z.array(z.string()) }),
  },
  get: {
    input: z.object({ id: pageId }),
    output: z.object({ page: pageMetaSchema.nullable() }),
  },
  /** Title, description and image for a bookmark embed. */
  linkPreview: {
    input: z.object({ url: z.string().url().max(2000) }),
    output: z.object({ title: z.string(), description: z.string(), image: z.string() }),
  },
  /** Items from the other Studio add-ons, for embeds, mentions and pasted links. */
  studioItems: {
    input: z.null(),
    output: z.object({ items: z.array(studioItemSchema) }),
  },
  /** What an artifact embed shows: the latest version's bytes, or its text. */
  artifactView: {
    input: z.object({ id: z.string().min(1).max(100) }),
    output: z.object({
      view: z
        .object({
          type: z.enum(["image", "html", "markdown", "code", "text", "pdf", "other"]),
          name: z.string(),
          url: z.string(),
          text: z.string().nullable(),
        })
        .nullable(),
    }),
  },
  markdown: {
    input: z.object({ id: pageId }),
    output: z.object({ markdown: z.string() }),
  },
  /**
   * Saves a version named `snapshotName`, then replaces the whole page with
   * `markdown`. Open editors update live; the change is recorded as an agent's.
   */
  replaceMarkdown: {
    input: z.object({ id: pageId, markdown: z.string().max(200_000), snapshotName: z.string().trim().min(1).max(120) }),
    output: z.object({ page: pageMetaSchema }),
  },
  search: {
    input: z.object({ query: z.string().max(200), projectId: projectId.optional() }),
    output: z.object({ pages: z.array(pageMetaSchema) }),
  },
  bots: {
    input: z.null(),
    output: z.object({ available: z.boolean(), reason: z.string().nullable(), bots: z.array(botSchema) }),
  },
  requests: {
    input: z.object({ pageId }),
    output: z.object({ requests: z.array(requestSchema) }),
  },
  setRefresh: {
    input: z.object({
      id: pageId,
      refresh: z.object({ botId: z.string(), cron: z.string().min(1).max(120), instructions: z.string().max(4000) }).nullable(),
    }),
    output: z.object({ page: pageMetaSchema }),
  },
  refreshNow: {
    input: z.object({ id: pageId }),
    output: z.object({ request: requestSchema }),
  },
  /** Starts an agent thread about the page, or hands it to a bot the message @mentions. */
  work: {
    input: z.object({ id: pageId, request: chatRequestSchema }),
    output: z.object({ threadId: z.string(), botName: z.string().nullable() }),
  },
  chats: {
    input: z.object({ pageId }),
    output: z.object({ chats: z.array(z.object({ threadId: z.string(), createdAt: z.number() })) }),
  },
  /** The page a "Work with this page" thread was started from. */
  chatPage: {
    input: z.object({ threadId: z.string().min(1).max(200) }),
    output: z.object({ page: pageMetaSchema.nullable() }),
  },
  snapshots: {
    input: z.object({ id: pageId }),
    output: z.object({ snapshots: z.array(snapshotSchema) }),
  },
  snapshot: {
    input: z.object({ id: pageId, label: z.string().max(120).optional() }),
    output: z.object({ snapshot: snapshotSchema }),
  },
  restore: {
    input: z.object({ snapshotId: z.string() }),
    output: z.object({ ok: z.boolean() }),
  },
  // Explore: explainer pages for what agents noticed along the way.
  ...exploreMethods,
});
