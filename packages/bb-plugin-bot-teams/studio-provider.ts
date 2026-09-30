// Bots as a Studio add-on: the `studio_*` methods Studio calls to list bots in
// its collection. A bot keeps its own project, so it can't be moved, and it
// is archived (retired) rather than deleted.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { eachId, type StudioItem, type StudioKind, type StudioSchemas } from "@bb-studio/kit/contract";
import { snippets } from "@bb-studio/kit/format";
import { registerStudioProvider } from "@bb-studio/kit/server";
import type { Bot } from "./contract";

export const PLUGIN_ID = "bot-teams";
export const NEW_BOT_EVENT = "bb-studio:bot-teams:new-bot";

export const BOT_KIND: StudioKind = {
  id: "bot",
  label: "Bot",
  plural: "Bots",
  icon: "Bot",
  columns: [{ id: "model", label: "Model" }],
  actions: [],
  create: { mode: "event", event: NEW_BOT_EVENT },
  canArchive: true,
  blurb: "Persistent teammates with their own workspace and memory.",
  agentHint: "It's a bot: @mention it by name to hand it work; `bb bots show <id>` and `bb bots memory <id>` describe it.",
};

export const botHref = (id: string) => `/plugins/${PLUGIN_ID}/bots/${id}`;

export interface BotActivity {
  working: boolean;
  lastActivityAt: number | null;
}

export function toStudioItem(bot: Bot, activity: BotActivity | undefined): StudioItem {
  return {
    id: bot.id,
    kind: BOT_KIND.id,
    title: bot.name,
    icon: bot.avatar || null,
    // The bot's project is its private workspace, not one of the user's.
    projectId: null,
    parentId: null,
    createdAt: bot.createdAt,
    updatedAt: bot.updatedAt,
    updatedBy: null,
    preview: bot.description.trim() || `@${bot.handle}`,
    facts: [{ id: "model", value: bot.model || bot.providerId, sort: null }],
    badge: bot.error
      ? { label: "Error", tone: "danger" }
      : activity?.working
        ? { label: "Working", tone: "live" }
        : null,
    thumbnailUrl: null,
    href: botHref(bot.id),
    archived: !!bot.retired,
  };
}

export function registerStudio(
  bb: Pick<BbPluginApi, "rpc">,
  schemas: StudioSchemas,
  deps: {
    bots(): Bot[];
    activity(): Map<string, BotActivity>;
    retire(id: string, retired: boolean): Promise<unknown>;
  },
): void {
  const items = () => {
    const activity = deps.activity();
    return deps.bots().map((bot) => toStudioItem(bot, activity.get(bot.id)));
  };
  registerStudioProvider(bb, schemas, {
    studio_describe: () => ({ pluginId: PLUGIN_ID, version: 1, panel: "bots", kinds: [BOT_KIND] }),
    studio_list: () => ({ items: items() }),
    // Studio matches names itself; this finds descriptions and handles.
    studio_search: ({ query }) => {
      const needle = query.trim().toLowerCase().replace(/^@/, "");
      // A bare "@" would match every bot.
      if (!needle) return { ids: [], snippets: {} };
      const found = deps
        .bots()
        .filter((bot) => bot.description.toLowerCase().includes(needle) || bot.handle.toLowerCase().includes(needle));
      return { ids: found.map((bot) => bot.id), snippets: snippets(found, needle, (bot) => bot.description) };
    },
    studio_create: () => {
      throw new Error("Bots are created in a setup chat.");
    },
    studio_move: ({ ids }) =>
      eachId(ids, () => {
        throw new Error("A bot keeps its own project.");
      }),
    studio_archive: ({ ids, archived }) => eachId(ids, (id) => deps.retire(id, archived)),
    studio_delete: ({ ids }) =>
      eachId(ids, () => {
        throw new Error("Bots can't be deleted. Archive them instead.");
      }),
    studio_action: ({ action }) => {
      throw new Error(`Unknown action "${action}".`);
    },
  });
}

/** A key that changes when anything Studio shows about the bots does. */
export function botsSignature(bots: readonly Bot[], activity: Map<string, BotActivity>): string {
  return JSON.stringify(
    bots.map((bot) => [bot.id, bot.name, bot.avatar, bot.description, bot.model, bot.retired, bot.error, bot.updatedAt, activity.get(bot.id)?.working]),
  );
}
