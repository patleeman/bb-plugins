// The Studio provider contract: the RPC methods every Studio add-on registers
// so the Studio plugin can list, search, create, move, and delete its items.
//
// Nothing here imports zod at runtime. The kit is bundled from outside each
// plugin's directory, where the plugin's own zod isn't resolvable, so callers
// pass their `z` in.
import type { z as Zod } from "zod";

export const STUDIO_PLUGIN_ID = "studio";
/** Studio's nav panel path: the collection lives at /plugins/studio/studio. */
export const STUDIO_PANEL_PATH = "studio";
/** The RPC an add-on calls on Studio when its items change. */
export const STUDIO_CHANGED_METHOD = "studio_changed";
/** Studio's realtime channel; payload `{ pluginId }`. */
export const STUDIO_REALTIME_CHANNEL = "studio-changed";
/** Studio's RPC that finds the item a path opens, or an item by id. */
export const STUDIO_ITEM_AT_METHOD = "itemAt";

/** Studio Chat, the floating chat over Studio items. */
export const STUDIO_CHAT_PLUGIN_ID = "studio-chat";
/** Window event that floats a thread in Studio Chat; detail `{ threadId }`. */
export const STUDIO_CHAT_FLOAT_EVENT = "bb-studio:chat:float";
/** CSS variable on the root element that moves the chat card left, e.g. past a comments card. */
export const STUDIO_CHAT_RIGHT_VAR = "--studio-chat-right";

export type StudioTone = "neutral" | "live" | "progress" | "warning" | "danger" | "success";

export interface StudioFact {
  /** Matches a column the kind declares, e.g. "length". */
  id: string;
  /** Display text, e.g. "12 min". */
  value: string;
  /** Sort value for the column; null sorts last. */
  sort: number | null;
}

export interface StudioBadge {
  label: string;
  tone: StudioTone;
}

export interface StudioItem {
  id: string;
  /** A kind id declared by the provider, e.g. "page", "recording". */
  kind: string;
  /** Empty for an untitled item; the UI shows "Untitled". */
  title: string;
  /** An emoji the user picked, or null for the kind's icon. */
  icon: string | null;
  projectId: string | null;
  /** Nesting within the same provider, e.g. a sub-page. */
  parentId: string | null;
  createdAt: number;
  updatedAt: number;
  /** Who made the last change. */
  updatedBy: "user" | "agent" | null;
  /** One line of text, or null. */
  preview: string | null;
  facts: StudioFact[];
  badge: StudioBadge | null;
  /** A small image for grid cards, served by the provider. */
  thumbnailUrl: string | null;
  /** App path that opens the item, e.g. /plugins/pages/pages/pg_x. */
  href: string;
  archived: boolean;
}

export interface StudioColumn {
  /** The fact id this column shows. */
  id: string;
  label: string;
}

export interface StudioAction {
  id: string;
  /** Button label; `{count}` is replaced with the number of items it applies to. */
  label: string;
  icon: string;
  /** "copy" puts the action's returned text on the clipboard. */
  result: "toast" | "copy";
}

export interface StudioKind {
  id: string;
  /** "Page" */
  label: string;
  /** "Pages" */
  plural: string;
  /** BB icon name, e.g. "FileText" or "talk/talk". */
  icon: string;
  /** Kind-specific columns the list shows when filtered to this kind. */
  columns: StudioColumn[];
  /** Kind-specific bulk actions, offered when every selected item is this kind. */
  actions: StudioAction[];
  /**
   * How "New" makes one: "rpc" calls studio_create; "event" dispatches
   * `createEvent` on window for the add-on's frontend to handle; null means
   * the kind can't be created from Studio.
   */
  create: { mode: "rpc" } | { mode: "event"; event: string } | null;
  canArchive: boolean;
  /** Empty-state copy for this kind. */
  blurb: string;
  /**
   * How an agent reads and edits one, e.g. "Read it with pages_read and edit
   * it with pages_edit." Studio Chat tells the agent this when the item is on
   * screen.
   */
  agentHint?: string;
}

export interface StudioProviderInfo {
  pluginId: string;
  /** Contract version, for future changes. */
  version: 1;
  /** The add-on's own nav panel, which Studio offers to hide from the sidebar. */
  panel: string | null;
  kinds: StudioKind[];
}

export interface StudioCreateEventDetail {
  projectId: string | null;
}

export type StudioItemsByPlugin = Record<string, StudioItem[]>;

/** Zod schemas for the contract, built from the caller's zod. */
export function studioSchemas(z: typeof Zod) {
  const tone = z.enum(["neutral", "live", "progress", "warning", "danger", "success"]);
  const item = z.object({
    id: z.string(),
    kind: z.string(),
    title: z.string(),
    icon: z.string().nullable(),
    projectId: z.string().nullable(),
    parentId: z.string().nullable(),
    createdAt: z.number(),
    updatedAt: z.number(),
    updatedBy: z.enum(["user", "agent"]).nullable(),
    preview: z.string().nullable(),
    facts: z.array(z.object({ id: z.string(), value: z.string(), sort: z.number().nullable() })),
    badge: z.object({ label: z.string(), tone }).nullable(),
    thumbnailUrl: z.string().nullable(),
    href: z.string(),
    archived: z.boolean(),
  });
  const kind = z.object({
    id: z.string(),
    label: z.string(),
    plural: z.string(),
    icon: z.string(),
    columns: z.array(z.object({ id: z.string(), label: z.string() })),
    actions: z.array(
      z.object({ id: z.string(), label: z.string(), icon: z.string(), result: z.enum(["toast", "copy"]) }),
    ),
    create: z
      .discriminatedUnion("mode", [
        z.object({ mode: z.literal("rpc") }),
        z.object({ mode: z.literal("event"), event: z.string() }),
      ])
      .nullable(),
    canArchive: z.boolean(),
    blurb: z.string(),
    agentHint: z.string().max(500).optional(),
  });
  const info = z.object({ pluginId: z.string(), version: z.literal(1), panel: z.string().nullable(), kinds: z.array(kind) });
  const ids = z.array(z.string().min(1).max(200)).min(1).max(500);
  const projectId = z.string().min(1).max(200).nullable();
  const results = z.object({
    done: z.array(z.string()),
    failed: z.array(z.object({ id: z.string(), error: z.string() })),
  });
  return {
    item,
    kind,
    info,
    results,
    /** The methods an add-on registers with `bb.rpc.register`. */
    provider: {
      studio_describe: { input: z.null(), output: info },
      /**
       * Every item, archived ones included. An add-on that caps its list sets
       * `truncated` when it hit the cap, so Studio keeps the tags and tabs of
       * items it didn't see.
       */
      studio_list: { input: z.null(), output: z.object({ items: z.array(item), truncated: z.boolean().optional() }) },
      /**
       * Ids of items whose content matches; Studio matches titles itself.
       * `snippets` has the matching text by id, for as many as the add-on
       * cares to excerpt (see `snippet` in the kit's format module).
       */
      studio_search: {
        input: z.object({ query: z.string().min(1).max(200) }),
        output: z.object({ ids: z.array(z.string()), snippets: z.record(z.string(), z.string()).optional() }),
      },
      studio_create: {
        input: z.object({ kind: z.string(), projectId }),
        output: z.object({ item }),
      },
      studio_move: { input: z.object({ ids, projectId }), output: results },
      studio_archive: { input: z.object({ ids, archived: z.boolean() }), output: results },
      studio_delete: { input: z.object({ ids }), output: results },
      studio_action: {
        input: z.object({ action: z.string(), ids }),
        output: z.object({ message: z.string().nullable(), text: z.string().nullable() }),
      },
    },
    /** Studio's method that finds an item and its kind, by the path that opens it or by id. */
    itemAt: {
      input: z.union([z.object({ path: z.string().min(1).max(2000) }), z.object({ pluginId: z.string().min(1).max(100), id: z.string().min(1).max(200) })]),
      output: z.object({ item: item.extend({ pluginId: z.string() }).nullable(), kind: kind.nullable() }),
    },
    /** Studio's own method add-ons call when their items change. */
    changed: {
      input: z.object({ pluginId: z.string().min(1).max(100) }),
      output: z.object({ ok: z.boolean() }),
    },
  };
}

export type StudioSchemas = ReturnType<typeof studioSchemas>;

/** Runs `work` for each id and reports which succeeded. */
export async function eachId(
  ids: readonly string[],
  work: (id: string) => unknown,
): Promise<{ done: string[]; failed: { id: string; error: string }[] }> {
  const done: string[] = [];
  const failed: { id: string; error: string }[] = [];
  for (const id of ids) {
    try {
      await work(id);
      done.push(id);
    } catch (error) {
      failed.push({ id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { done, failed };
}

/** The item whose view is at `path`: the longest `href` that is the path or a parent of it. */
export function itemAtPath<T extends { href: string }>(items: readonly T[], path: string): T | null {
  const clean = path.split(/[?#]/)[0]!.replace(/\/+$/, "");
  let best: T | null = null;
  for (const item of items) {
    const href = item.href.split(/[?#]/)[0]!.replace(/\/+$/, "");
    if (!href.startsWith("/")) continue;
    if ((clean === href || clean.startsWith(`${href}/`)) && href.length > (best?.href.length ?? 0)) best = item;
  }
  return best;
}

/** A composer prompt that links each item, so the agent can read them. */
export function mentionPrompt(items: readonly { title: string; href: string }[]): string {
  return `${items.map((item) => `[${(item.title || "Untitled").replace(/[[\]]/g, "")}](${item.href})`).join(" ")} `;
}
