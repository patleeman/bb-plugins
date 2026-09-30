// bb-plugin-studio-chat server.
//
// - `viewing` asks Studio which item a path opens, so the chat knows what's
//   on screen without per-kind code.
// - `start` begins a thread about that item. Pages keeps its own page chats,
//   so a page goes through Pages' `work`; other items get a pill that our
//   mention provider resolves into a pointer note (src/context.ts).
// - Each item remembers the last thread used on it (kv `link:<plugin>:<id>`).
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { STUDIO_ITEM_AT_METHOD, STUDIO_PLUGIN_ID } from "@bb-studio/kit/contract";
import { MENTION_PROVIDER_ID, pagesSchemas, rpcContract, schemas, type ItemRef } from "./src/contract";
import { itemKey, missingNote, parseItemKey, pointerNote, toViewed, withItemPill } from "./src/context";

const PLUGIN_ID = "studio-chat";
const PAGES_PLUGIN_ID = "pages";
const CALL_TIMEOUT_MS = 10_000;
/** Starting a page chat creates a thread, which can take a while; don't wait forever. */
const START_TIMEOUT_MS = 60_000;

interface Link {
  threadId: string;
  at: number;
}

export default async function plugin(bb: BbPluginApi) {
  const itemAt = (input: { path: string } | ItemRef) =>
    bb.sdk.plugins.callRpc({
      pluginId: STUDIO_PLUGIN_ID,
      method: STUDIO_ITEM_AT_METHOD,
      input,
      outputSchema: schemas.itemAt.output,
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });

  const linkKey = (ref: ItemRef) => `link:${itemKey(ref)}`;
  const setLink = (ref: ItemRef, threadId: string) => bb.storage.kv.set(linkKey(ref), { threadId, at: Date.now() } satisfies Link);

  /** Pages records its own page chats; the newest one that still exists. */
  const lastPageChat = async (pageId: string): Promise<Link | null> => {
    try {
      const { chats } = await bb.sdk.plugins.callRpc({
        pluginId: PAGES_PLUGIN_ID,
        method: "chats",
        input: { pageId },
        outputSchema: pagesSchemas.chats,
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      const newest = [...chats].sort((a, b) => b.createdAt - a.createdAt)[0];
      return newest ? { threadId: newest.threadId, at: newest.createdAt } : null;
    } catch {
      return null;
    }
  };

  const threadExists = async (threadId: string) => {
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      return !thread.archivedAt;
    } catch {
      return false;
    }
  };

  bb.ui.registerMentionProvider({
    id: MENTION_PROVIDER_ID,
    label: "On screen",
    // Pills come from the chat itself; each add-on's own provider finds items by name.
    search: () => [],
    async resolve(key) {
      const ref = parseItemKey(key);
      if (!ref) return { context: missingNote(key) };
      const { item, kind } = await itemAt(ref).catch(() => ({ item: null, kind: null }));
      return { context: item ? pointerNote(item, kind) : missingNote(key) };
    },
  });

  bb.rpc.register(rpcContract, {
    viewing: async ({ path }) => {
      if (!path.startsWith("/plugins/")) return { item: null };
      const { item, kind } = await itemAt({ path }).catch(() => ({ item: null, kind: null }));
      return { item: item && !item.archived ? toViewed(item, kind) : null };
    },
    start: async ({ item: ref, request }) => {
      if (ref?.pluginId === PAGES_PLUGIN_ID) {
        const { threadId } = await bb.sdk.plugins.callRpc({
          pluginId: PAGES_PLUGIN_ID,
          method: "work",
          input: { id: ref.id, request },
          outputSchema: pagesSchemas.work,
          signal: AbortSignal.timeout(START_TIMEOUT_MS),
        });
        await setLink(ref, threadId);
        return { threadId };
      }
      const found = ref ? await itemAt(ref).catch(() => null) : null;
      const item = found?.item ?? null;
      const input = item
        ? withItemPill(request.input, {
            pluginId: PLUGIN_ID,
            wireId: `${MENTION_PROVIDER_ID}:${itemKey(item)}`,
            label: item.title,
            icon: found?.kind?.icon ?? null,
          })
        : request.input;
      const thread = await bb.sdk.threads.spawn({ ...request, input });
      if (ref) await setLink(ref, thread.id);
      return { threadId: thread.id };
    },
    lastThread: async (ref) => {
      const own = await bb.storage.kv.get<Link>(linkKey(ref));
      const pages = ref.pluginId === PAGES_PLUGIN_ID ? await lastPageChat(ref.id) : null;
      const newest = [own, pages].filter((link): link is Link => !!link).sort((a, b) => b.at - a.at)[0];
      if (!newest) return { threadId: null };
      return { threadId: (await threadExists(newest.threadId)) ? newest.threadId : null };
    },
    link: async ({ threadId, ...ref }) => {
      await setLink(ref, threadId);
      return { ok: true };
    },
  });
}
