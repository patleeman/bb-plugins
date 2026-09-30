// Draw as a Studio add-on: the `studio_*` methods Studio calls to list and
// manage drawings in its collection.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { eachId, type StudioItem, type StudioKind, type StudioSchemas } from "@bb-studio/kit/contract";
import { snippets } from "@bb-studio/kit/format";
import { registerStudioProvider } from "@bb-studio/kit/server";
import { getNonDeletedElements, parseSceneData } from "../../lib/merge";
import { DRAW_ICON, PLUGIN_ID, drawingHref, thumbnailUrl } from "../shared";
import type { DrawingRow, DrawingStore } from "./store";

export const DRAWING_KIND: StudioKind = {
  id: "drawing",
  label: "Drawing",
  plural: "Drawings",
  icon: DRAW_ICON,
  columns: [{ id: "elements", label: "Elements" }],
  actions: [{ id: "copy-text", label: "Copy text", icon: "Copy", result: "copy" }],
  create: { mode: "rpc" },
  canArchive: true,
  blurb: "Diagrams and sketches.",
  agentHint: "Read it with excalidraw_get_drawing and change it with excalidraw_update_drawing.",
};

const PREVIEW_CHARS = 140;

/** The words written on a drawing, top to bottom. */
export function drawingText(data: string): string[] {
  const elements = getNonDeletedElements(parseSceneData(data));
  return elements
    .filter((element) => element.type === "text" && typeof element.text === "string" && element.text.trim())
    .sort((a, b) => Number(a.y ?? 0) - Number(b.y ?? 0) || Number(a.x ?? 0) - Number(b.x ?? 0))
    .map((element) => (element.text as string).trim());
}

type Summary = { count: number; preview: string | null };
const summaries = new Map<string, { at: number; summary: Summary }>();

/** Element count and text preview, cached per revision: scenes can be large. */
function summarize(row: DrawingRow): Summary {
  const cached = summaries.get(row.id);
  if (cached?.at === row.updated_at) return cached.summary;
  const count = getNonDeletedElements(parseSceneData(row.data)).length;
  const text = drawingText(row.data).join(" · ").replace(/\s+/g, " ");
  const summary = {
    count,
    preview: text ? (text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS - 1).trimEnd()}…` : text) : null,
  };
  summaries.set(row.id, { at: row.updated_at, summary });
  return summary;
}

export function toStudioItem(row: DrawingRow): StudioItem {
  const { count, preview } = summarize(row);
  return {
    id: row.id,
    kind: DRAWING_KIND.id,
    title: row.name.trim(),
    icon: null,
    projectId: row.project_id,
    parentId: null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by === "user" || row.updated_by === "agent" ? row.updated_by : null,
    preview,
    facts: [{ id: "elements", value: count.toLocaleString("en-US"), sort: count }],
    badge: null,
    thumbnailUrl: count ? thumbnailUrl(row.id, row.updated_at) : null,
    href: drawingHref(row.id),
    archived: row.archived_at !== null,
  };
}

/** Studio lists at most this many; past it, Studio keeps tags of items it didn't see. */
const LIST_LIMIT = 10_000;

export function registerStudio(
  bb: Pick<BbPluginApi, "rpc">,
  schemas: StudioSchemas,
  deps: { store: DrawingStore; changed(id: string): void },
): void {
  const { store } = deps;
  const mustGet = (id: string) => {
    const row = store.get(id);
    if (!row) throw new Error("Drawing not found.");
    return row;
  };

  registerStudioProvider(bb, schemas, {
    studio_describe: () => ({ pluginId: PLUGIN_ID, version: 1, panel: "drawings", kinds: [DRAWING_KIND] }),
    studio_list: () => {
      const rows = store.list({ includeArchived: true, limit: LIST_LIMIT });
      return { items: rows.map(toStudioItem), truncated: rows.length === LIST_LIMIT };
    },
    // Studio matches titles itself; this finds the words written on drawings.
    studio_search: ({ query }) => {
      const needle = query.toLowerCase();
      const found = store
        .list({ limit: 10_000 })
        .map((row) => ({ id: row.id, text: drawingText(row.data).join("\n") }))
        .filter((row) => row.text.toLowerCase().includes(needle))
        .slice(0, 200);
      return { ids: found.map((row) => row.id), snippets: snippets(found, query, (row) => row.text) };
    },
    studio_create: ({ kind, projectId }) => {
      if (kind !== DRAWING_KIND.id) throw new Error(`Unknown kind "${kind}".`);
      const row = store.create({ name: "", projectId, by: "app" });
      deps.changed(row.id);
      return { item: toStudioItem(row) };
    },
    studio_move: ({ ids, projectId }) =>
      eachId(ids, (id) => {
        mustGet(id);
        store.setProject(id, projectId);
        deps.changed(id);
      }),
    studio_archive: ({ ids, archived }) =>
      eachId(ids, (id) => {
        mustGet(id);
        store.setArchived(id, archived);
        deps.changed(id);
      }),
    studio_delete: ({ ids }) =>
      eachId(ids, (id) => {
        mustGet(id);
        store.delete(id);
        summaries.delete(id);
        deps.changed(id);
      }),
    studio_action: ({ action, ids }) => {
      if (action !== "copy-text") throw new Error(`Unknown action "${action}".`);
      const parts = ids.map((id) => {
        const row = mustGet(id);
        const text = drawingText(row.data).join("\n\n");
        return ids.length === 1 ? text : `## ${row.name.trim() || "Untitled drawing"}\n\n${text || "(No text.)"}`;
      });
      const text = parts.join("\n\n");
      if (!text.trim()) return { message: "There's no text on this drawing.", text: null };
      return { message: ids.length === 1 ? "Text copied" : `Copied text from ${ids.length} drawings`, text };
    },
  });
}
