// bb-plugin-studio server: the hub every Studio add-on plugs into.
//
// - Studio finds add-ons through RPC discovery (src/hub.ts) and fans the
//   collection's requests out to their `studio_*` methods.
// - Add-ons call `studio_changed` when their items change; Studio relays it
//   to open collections over realtime.
// - Studio can hide the add-ons' own sidebar entries, since its collection
//   lists their items (src/sidebar.ts).
// - Studio keeps tags, which group items across add-ons (src/tags.ts).
// - Studio keeps the sidebar's tabs, one per opened item (src/tabs.ts).
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { STUDIO_PLUGIN_ID, STUDIO_REALTIME_CHANNEL } from "@bb-studio/kit/contract";
import { relativeTime, untitled } from "@bb-studio/kit/format";
import { z } from "zod";
import { rpcContract, TABS_CHANNEL, type SidebarView, type TabView } from "./src/contract";
import { errorText, StudioHub, type HubItem } from "./src/hub";
import { isPanelVisible, withPanelsVisible } from "./src/sidebar";
import { MIGRATIONS } from "./src/migrations";
import { itemAtPath, TabStore } from "./src/tabs";
import { TagStore, type ItemRef, type Tag } from "./src/tags";

const ORDER_KEY = "sidebar.pluginPanelOrder";
const VISIBLE_KEY = "sidebar.visiblePluginPanels";
const MAX_LISTED = 100;

export default async function plugin(bb: BbPluginApi) {
  const hub = new StudioHub(bb.sdk);
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const tags = new TagStore(db);
  const tabs = new TabStore(db);
  /** Every window's sidebar refetches its tabs. */
  const tabsChanged = () => bb.realtime.publish(TABS_CHANNEL, {});

  /**
   * Every item with its tag ids. Tags and tabs of items a provider no longer
   * lists are dropped; a provider that is down, or listed only some, keeps them.
   */
  const overview = async () => {
    const result = await hub.overview();
    let closed = false;
    for (const provider of result.providers) {
      if (provider.state !== "ready" || result.truncated.has(provider.pluginId)) continue;
      const live = new Set(result.items.filter((item) => item.pluginId === provider.pluginId).map((item) => item.id));
      tags.prune(provider.pluginId, live);
      closed = tabs.prune(provider.pluginId, live) || closed;
    }
    if (closed) tabsChanged();
    const assigned = tags.assignments();
    return {
      providers: result.providers,
      items: result.items.map((item) => ({ ...item, tags: assigned.get(`${item.pluginId}:${item.id}`) ?? [] })),
      tags: tags.list(),
    };
  };
  /** Open collections refetch, as when an add-on's items change. */
  const tagsChanged = () => bb.realtime.publish(STUDIO_REALTIME_CHANNEL, { pluginId: "studio" });

  const tabViews = ({ providers, items }: Awaited<ReturnType<typeof overview>>): TabView[] => {
    const kindIcons = new Map(providers.flatMap((provider) => provider.kinds.map((kind) => [`${provider.pluginId}:${kind.id}`, kind.icon])));
    const byKey = new Map(items.map((item) => [`${item.pluginId}:${item.id}`, item]));
    // A tab whose add-on is down stays open but isn't shown until it's back.
    return tabs.list().flatMap((ref) => {
      const item = byKey.get(`${ref.pluginId}:${ref.id}`);
      if (!item) return [];
      return [{ pluginId: item.pluginId, id: item.id, title: untitled(item.title), icon: item.icon, kindIcon: kindIcons.get(`${item.pluginId}:${item.kind}`) ?? "File", href: item.href }];
    });
  };

  const addonPanels = async () =>
    (await hub.providers())
      .filter((provider) => provider.panel)
      .map((provider) => ({ id: `${provider.pluginId}/${provider.panel}`, label: provider.name }));

  const readSidebar = async (): Promise<SidebarView> => {
    const [panels, { preferences }] = await Promise.all([addonPanels(), bb.sdk.system.uiPreferences.list()]);
    const order = preferences[ORDER_KEY].value;
    const visible = preferences[VISIBLE_KEY].value;
    return { panels: panels.map((panel) => ({ ...panel, visible: isPanelVisible(order, visible, panel.id) })) };
  };

  bb.rpc.register(rpcContract, {
    overview: () => overview(),
    search: ({ query }) => hub.search(query),
    create: ({ pluginId, kind, projectId }) => hub.call(pluginId, "studio_create", { kind, projectId }),
    move: ({ pluginId, ids, projectId }) => hub.call(pluginId, "studio_move", { ids, projectId }),
    archive: ({ pluginId, ids, archived }) => hub.call(pluginId, "studio_archive", { ids, archived }),
    remove: async ({ pluginId, ids }) => {
      const result = await hub.call(pluginId, "studio_delete", { ids });
      tags.forget(pluginId, result.done);
      if (tabs.forget(pluginId, result.done)) tabsChanged();
      return result;
    },
    action: ({ pluginId, action, ids }) => hub.call(pluginId, "studio_action", { action, ids }),
    createTag: ({ name }) => {
      const tag = tags.ensure(name);
      tagsChanged();
      return { tag };
    },
    renameTag: ({ id, name }) => {
      const tag = tags.rename(id, name);
      tagsChanged();
      return { tag };
    },
    deleteTag: ({ id }) => {
      tags.remove(id);
      tagsChanged();
      return { ok: true };
    },
    tagItems: ({ items, add, remove }) => {
      tags.apply(items, add, remove);
      tagsChanged();
      return { ok: true };
    },
    studio_changed: ({ pluginId }) => {
      bb.realtime.publish(STUDIO_REALTIME_CHANNEL, { pluginId });
      return { ok: true };
    },
    sidebar: () => readSidebar(),
    tabs: async () => ({ tabs: tabViews(await overview()) }),
    visitTab: async ({ path }) => {
      if (!path.startsWith("/plugins/") || path.startsWith(`/plugins/${STUDIO_PLUGIN_ID}/`)) return { tab: null };
      const data = await overview();
      const item = itemAtPath(data.items, path);
      if (!item) return { tab: null };
      if (tabs.open(item)) tabsChanged();
      return { tab: tabViews(data).find((each) => each.pluginId === item.pluginId && each.id === item.id) ?? null };
    },
    closeTabs: ({ items }) => {
      let closed = false;
      for (const item of items) closed = tabs.close(item) || closed;
      if (closed) tabsChanged();
      return { ok: true };
    },
    setSidebar: async ({ visible: show }) => {
      const ids = (await addonPanels()).map((panel) => panel.id);
      // Another window can change the sidebar between our read and write; a
      // stale revision fails, so read again and retry once.
      for (let attempt = 0; ; attempt++) {
        const { preferences } = await bb.sdk.system.uiPreferences.list();
        const order = preferences[ORDER_KEY];
        const visible = preferences[VISIBLE_KEY];
        const next = withPanelsVisible(order.value, visible.value, ids, show);
        try {
          if (next.order.length !== order.value.length) {
            await bb.sdk.system.uiPreferences.set({ key: ORDER_KEY, value: next.order, expectedRevision: order.revision });
          }
          await bb.sdk.system.uiPreferences.set({ key: VISIBLE_KEY, value: next.visible, expectedRevision: visible.revision });
          break;
        } catch (error) {
          if (attempt > 0) throw error;
        }
      }
      return readSidebar();
    },
    itemAt: async (input) => {
      if ("path" in input && input.path.startsWith(`/plugins/${STUDIO_PLUGIN_ID}/`)) return { item: null, kind: null };
      const { providers, items } = await hub.overview();
      const item =
        "path" in input
          ? itemAtPath(items, input.path)
          : (items.find((each) => each.pluginId === input.pluginId && each.id === input.id) ?? null);
      if (!item) return { item: null, kind: null };
      const kind = providers.find((provider) => provider.pluginId === item.pluginId)?.kinds.find((each) => each.id === item.kind) ?? null;
      return { item, kind };
    },
  });

  // Agents --------------------------------------------------------------------

  /** `snippet` is the content that matched a query, when the add-on gave it. */
  type ListedItem = HubItem & { tags: string[]; snippet?: string };
  const itemLine = (item: ListedItem, kindLabel: string, tagNames: Map<string, string>) =>
    `- ${item.icon ? `${item.icon} ` : ""}${untitled(item.title)} — ${kindLabel}${item.archived ? ", archived" : ""}, ${
      item.projectId ? "project" : "global"
    }, updated ${relativeTime(item.updatedAt)}${item.tags.map((id) => ` #${tagNames.get(id) ?? id}`).join("")} (${item.href})${
      item.snippet ? `\n  > ${item.snippet}` : ""
    }`;

  const listItems = async (options: { projectId: string | null; all: boolean; kind?: string; query?: string; tag?: string }) => {
    const { providers, items, tags: allTags } = await overview();
    const tag = options.tag ? tags.byName(options.tag) : null;
    if (options.tag && !tag) throw new Error(`No tag called "${options.tag}". Tags: ${allTags.map((each) => each.name).join(", ") || "none yet"}.`);
    const labels = new Map(providers.flatMap((provider) => provider.kinds.map((kind) => [`${provider.pluginId}:${kind.id}`, kind.label])));
    const raw = options.query?.trim();
    const query = raw?.toLowerCase();
    const content = raw ? await hub.search(raw) : null;
    const contentKeys = new Set(content?.keys);
    const picked: ListedItem[] = items
      .filter(
        (item) =>
          !item.archived &&
          (options.all || item.projectId === null || item.projectId === options.projectId) &&
          (!options.kind || item.kind === options.kind) &&
          (!tag || item.tags.includes(tag.id)) &&
          (!query || untitled(item.title).toLowerCase().includes(query) || contentKeys.has(`${item.pluginId}:${item.id}`)),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((item) => {
        const snippet = content?.snippets[`${item.pluginId}:${item.id}`];
        return snippet ? { ...item, snippet } : item;
      });
    const problems = providers.filter((provider) => provider.state !== "ready").map((provider) => `${provider.name}: ${provider.detail}`);
    const tagNames = new Map(allTags.map((each) => [each.id, each.name]));
    return { picked, labels, problems, tagNames, kinds: providers.flatMap((provider) => provider.kinds.map((kind) => kind.id)) };
  };

  const formatList = ({ picked, labels, problems, tagNames }: Awaited<ReturnType<typeof listItems>>) => {
    const lines = picked.slice(0, MAX_LISTED).map((item) => itemLine(item, labels.get(`${item.pluginId}:${item.kind}`) ?? item.kind, tagNames));
    if (picked.length > MAX_LISTED) lines.push(`…and ${picked.length - MAX_LISTED} more. Narrow with a query or kind.`);
    if (!lines.length) lines.push("No Studio items match.");
    if (problems.length) lines.push("", "Unavailable:", ...problems.map((problem) => `- ${problem}`));
    return lines.join("\n");
  };

  bb.agents.registerTool({
    name: "studio_list_items",
    description:
      "List the user's BB Studio items — pages, Talk recordings, drawings and anything else a Studio add-on provides — in this project and global ones, newest first. Each line has a link and the item's #tags, and a content match shows the text that matched; open or mention it to work with the item.",
    parameters: z.object({
      query: z.string().max(200).optional().describe("Match titles and content"),
      kind: z.string().max(100).optional().describe("Only this kind, e.g. page, recording, drawing"),
      allProjects: z.boolean().optional().describe("Include every project, not just this one"),
      tag: z.string().max(100).optional().describe("Only items with this tag"),
    }),
    async execute({ query, kind, allProjects, tag }, ctx) {
      return formatList(await listItems({ projectId: ctx.projectId ?? null, all: allProjects === true, kind, query, tag }));
    },
  });

  /** Finds items by link or `<plugin>:<id>`, as studio_list_items shows them. */
  const resolveItems = async (refs: readonly string[]) => {
    const { items } = await hub.overview();
    const found: ItemRef[] = [];
    const missing: string[] = [];
    for (const ref of refs) {
      const trimmed = ref.trim().replace(/^\((.*)\)$/, "$1");
      const item = items.find((each) => each.href === trimmed || `${each.pluginId}:${each.id}` === trimmed);
      if (item) found.push({ pluginId: item.pluginId, id: item.id });
      else missing.push(ref);
    }
    return { found, missing };
  };

  bb.agents.registerTool({
    name: "studio_tag_items",
    description:
      "Group the user's BB Studio items with tags. Tags work across pages, recordings, drawings, artifacts and tasks; new tag names are created. Pass items as the links studio_list_items shows.",
    parameters: z.object({
      items: z.array(z.string().max(500)).min(1).max(100).describe("Item links, e.g. /plugins/pages/pages/pg_x"),
      add: z.array(z.string().max(100)).max(20).optional().describe("Tag names to add"),
      remove: z.array(z.string().max(100)).max(20).optional().describe("Tag names to remove"),
    }),
    async execute({ items, add = [], remove = [] }) {
      if (!add.length && !remove.length) return "Pass tag names to add or remove.";
      const { found, missing } = await resolveItems(items);
      const added: Tag[] = add.map((name) => tags.ensure(name));
      const removed = remove.map((name) => tags.byName(name)).filter((tag): tag is Tag => tag !== null);
      if (found.length) {
        tags.apply(found, added.map((tag) => tag.id), removed.map((tag) => tag.id));
        tagsChanged();
      }
      const lines = [`Updated ${found.length} item${found.length === 1 ? "" : "s"}.`];
      if (added.length) lines.push(`Added: ${added.map((tag) => `#${tag.name}`).join(" ")}`);
      if (removed.length) lines.push(`Removed: ${removed.map((tag) => `#${tag.name}`).join(" ")}`);
      if (missing.length) lines.push(`Not found: ${missing.join(", ")}`);
      return lines.join("\n");
    },
  });

  bb.cli.register({
    name: "studio",
    summary: "List BB Studio items across Pages, Talk, Draw and other add-ons",
    commands: [
      { name: "list", summary: "List items in the current project and global ones", usage: "bb studio list [--all] [--kind <kind>] [--tag <tag>] [--query <text>] [--json]" },
      { name: "tags", summary: "List tags and how many items have each", usage: "bb studio tags" },
      { name: "providers", summary: "Show which Studio add-ons are installed and ready", usage: "bb studio providers" },
    ],
    async run(argv, ctx) {
      const [command, ...rest] = argv;
      const flag = (name: string) => {
        const index = rest.indexOf(name);
        if (index < 0) return false;
        rest.splice(index, 1);
        return true;
      };
      const option = (name: string) => {
        const index = rest.indexOf(name);
        if (index < 0) return undefined;
        const [, value] = rest.splice(index, 2);
        return value;
      };
      try {
        switch (command) {
          case "list": {
            const json = flag("--json");
            const result = await listItems({
              projectId: ctx.projectId ?? null,
              all: flag("--all"),
              kind: option("--kind"),
              query: option("--query"),
              tag: option("--tag"),
            });
            if (json) return { exitCode: 0, stdout: `${JSON.stringify(result.picked.slice(0, MAX_LISTED), null, 2)}\n` };
            return { exitCode: 0, stdout: `${formatList(result)}\n` };
          }
          case "tags": {
            const { items, tags: allTags } = await overview();
            if (!allTags.length) return { exitCode: 0, stdout: "No tags yet.\n" };
            const lines = allTags.map((tag) => `#${tag.name}\t${items.filter((item) => item.tags.includes(tag.id)).length}`);
            return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
          }
          case "providers": {
            const providers = await hub.providers();
            if (!providers.length) return { exitCode: 0, stdout: "No Studio add-ons installed. Install Studio Pages, Studio Talk or Studio Draw.\n" };
            const lines = providers.map(
              (provider) =>
                `${provider.pluginId}\t${provider.state}\t${provider.kinds.map((kind) => kind.id).join(",") || "-"}${provider.detail ? `\t${provider.detail}` : ""}`,
            );
            return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
          }
          default:
            return { exitCode: 1, stderr: "usage: bb studio <list|tags|providers> …\n" };
        }
      } catch (error) {
        return { exitCode: 1, stderr: `${errorText(error)}\n` };
      }
    },
  });
}
