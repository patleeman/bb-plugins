// Where explainers are saved: Pages itself, in process (create, read,
// replace with a version), and tagged Explore in Studio over cross-plugin
// RPC. Studio is optional, so tagging is best effort.
import type { JsonValue } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { actorColor } from "../bots";
import { PLUGIN_ID } from "../constants";
import { readMarkdown } from "../doc";
import type { Actor } from "../hub";
import type { PagesService } from "../service";
import { EXPLORE_ACTOR, EXPLORE_TAG } from "./shared";

const STUDIO_PLUGIN_ID = "studio";
const MAX_TITLE = 200;
const MAX_SNAPSHOT_NAME = 120;

export interface ExplorePages {
  create(input: { projectId: string | null; parentId: string | null; title: string; icon?: string; markdown: string }): Promise<{ id: string }>;
  /** Saves the current content as a version named `snapshotName` first. */
  replaceMarkdown(id: string, markdown: string, snapshotName: string): Promise<{ id: string }>;
  get(id: string): Promise<{ id: string; archived: boolean } | null>;
  markdown(id: string): Promise<string>;
  /** Tags a page `Explore` in Studio; false when that didn't work. */
  tag(pageId: string): Promise<boolean>;
}

export interface CallRpc {
  callRpc<T>(args: { pluginId: string; method: string; input?: JsonValue; outputSchema: z.ZodType<T>; signal?: AbortSignal }): Promise<T>;
}

const tagOutput = z.looseObject({ tag: z.looseObject({ id: z.string() }) });
const okOutput = z.looseObject({ ok: z.boolean() });

/** Explore writes pages like an agent does, so Pages shows its edits as "an agent". */
export const EXPLORE_AUTHOR: Actor = { key: EXPLORE_ACTOR, name: "Explore", color: actorColor(EXPLORE_ACTOR) };

export function explorePages(pages: PagesService, plugins: CallRpc): ExplorePages {
  return {
    async create({ projectId, parentId, title, icon, markdown }) {
      const meta = pages.createPage({ projectId, parentId, title: title.slice(0, MAX_TITLE), icon, markdown, actor: EXPLORE_ACTOR });
      return { id: meta.id };
    },
    async replaceMarkdown(id, markdown, snapshotName) {
      const meta = pages.replaceMarkdown(id, markdown, snapshotName.slice(0, MAX_SNAPSHOT_NAME), EXPLORE_AUTHOR);
      return { id: meta.id };
    },
    async get(id) {
      const meta = pages.store.meta(id);
      return meta ? { id: meta.id, archived: meta.archived_at !== null } : null;
    },
    async markdown(id) {
      if (!pages.store.meta(id)) throw new Error("Page not found.");
      return readMarkdown(pages.hub.open(id).doc);
    },
    async tag(pageId) {
      try {
        const { tag } = await plugins.callRpc({ pluginId: STUDIO_PLUGIN_ID, method: "createTag", input: { name: EXPLORE_TAG }, outputSchema: tagOutput });
        await plugins.callRpc({
          pluginId: STUDIO_PLUGIN_ID,
          method: "tagItems",
          input: { items: [{ pluginId: PLUGIN_ID, id: pageId }], add: [tag.id], remove: [] },
          outputSchema: okOutput,
        });
        return true;
      } catch {
        return false;
      }
    },
  };
}
