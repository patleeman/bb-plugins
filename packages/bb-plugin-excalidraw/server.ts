// Studio Draw (plugin id `excalidraw`): create, edit, and attach Excalidraw
// drawings.
//
// Backend entry. Drawings live in the plugin's SQLite database as serialized
// Excalidraw scenes (see src/server/store.ts). The frontend renders and
// edits them with the real @excalidraw/excalidraw component and autosaves
// through the rpc contract below. With BB Studio installed, drawings also
// list in Studio's collection (src/server/studio.ts).
//
// Attaching to conversations is supported two ways:
//   - mention provider `@drawing` — pick a drawing in any composer; at send
//     time the agent receives the drawing's scene as context.
//   - `attachDrawingImage` rpc — the frontend renders the scene to a PNG and
//     the server uploads it as a project prompt attachment.
import { studioSchemas } from "@bb-studio/kit/contract";
import { createStudioNotifier } from "@bb-studio/kit/server";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { mentionContext as buildMentionContext } from "./lib/mention";
import {
  applyElementUpserts,
  elementCount,
  getNonDeletedElements,
  mergeFullScene,
  parseSceneData,
  serializeSceneData,
  type SceneElement,
  type StoredScene,
} from "./lib/merge";
import { DRAWING_UPDATE_TYPE, PLUGIN_ID, REALTIME_CHANNEL, drawingHref } from "./src/shared";
import { registerStudio } from "./src/server/studio";
import { DrawingStore, MIGRATIONS, displayName, toMeta, type DrawingRow, type Writer } from "./src/server/store";
import { sceneThumbnail } from "./src/server/thumbnail";

const MAX_TOOL_SCENE_CHARS = 400_000;

const drawingMetaSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  elementCount: z.number(),
  projectId: z.string().nullable(),
  archived: z.boolean(),
});

const drawingFullSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  projectId: z.string().nullable(),
  /** Serialized Excalidraw scene JSON (elements/appState/files). */
  data: z.string(),
});

const nameSchema = z.string().trim().max(200);

export const rpcContract = defineRpcContract({
  listDrawings: {
    input: z.null(),
    output: z.object({ drawings: z.array(drawingMetaSchema) }),
  },
  createDrawing: {
    input: z.object({
      name: nameSchema,
      projectId: z.string().min(1).max(200).nullable().optional(),
      /** Files the drawing under this thread's project. */
      threadId: z.string().min(1).max(200).optional(),
    }),
    output: z.object({ drawing: drawingMetaSchema }),
  },
  getDrawing: {
    input: z.object({ id: z.string() }),
    output: z.object({ drawing: drawingFullSchema.nullable() }),
  },
  getDrawingUpdatedAt: {
    input: z.object({ id: z.string() }),
    output: z.object({ updatedAt: z.number() }),
  },
  saveDrawing: {
    input: z.object({
      id: z.string(),
      name: nameSchema.optional(),
      data: z.string(),
    }),
    output: z.object({ ok: z.boolean(), updatedAt: z.number() }),
  },
  renameDrawing: {
    input: z.object({ id: z.string(), name: nameSchema }),
    output: z.object({ ok: z.boolean(), updatedAt: z.number() }),
  },
  deleteDrawing: {
    input: z.object({ id: z.string() }),
    output: z.object({ ok: z.boolean() }),
  },
  attachDrawingImage: {
    input: z.object({
      threadId: z.string(),
      drawingId: z.string(),
      /** Base64-encoded PNG, rendered client-side by the editor. */
      pngBase64: z.string(),
    }),
    output: z.object({ ok: z.boolean() }),
  },
  /**
   * Blocks until the user picks a drawing in the host-rendered picker
   * (pendingInteraction slot "excalidraw-picker"). Returns null on cancel.
   */
  pickDrawing: {
    input: z.object({ threadId: z.string() }),
    output: z.object({ drawingId: z.string().nullable() }),
  },
});

export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const store = new DrawingStore(db);

  const studio = studioSchemas(z);
  // Agents write drawings a few elements at a time; Studio only needs to hear about it now and then.
  const studioNotifier = createStudioNotifier({ plugins: bb.sdk.plugins, pluginId: PLUGIN_ID, schemas: studio, delayMs: 1500 });

  /** Tells open editors, galleries, and Studio that a drawing changed. */
  function changed(id: string, updatedAt: number, by: Writer | "studio") {
    try {
      bb.realtime.publish(REALTIME_CHANNEL, { type: DRAWING_UPDATE_TYPE, drawingId: id, updatedAt, by });
    } catch {
      // publishing is best-effort; editors also poll
    }
    studioNotifier.changed();
  }

  function mustGet(id: string): DrawingRow {
    const row = store.get(id);
    if (!row) throw new Error(`Drawing ${id} not found`);
    return row;
  }

  function create(name: string, by: Writer, projectId: string | null = null): DrawingRow {
    const row = store.create({ name, projectId, by });
    changed(row.id, row.updated_at, by);
    return row;
  }

  /** Writes a scene and notifies. Returns the new revision. */
  function write(row: DrawingRow, scene: StoredScene, by: Writer, options: { name?: string } = {}): number {
    const updatedAt = store.write(row.id, serializeSceneData(scene), by, options);
    changed(row.id, updatedAt, by);
    return updatedAt;
  }

  function remove(id: string, by: Writer) {
    if (store.delete(id)) changed(id, Date.now(), by);
  }

  /** Human-readable one-line summary of a scene (agent tool results). */
  function sceneSummary(scene: StoredScene | null, fallback = "empty drawing"): string {
    const elements = getNonDeletedElements(scene);
    if (!elements.length) return fallback;
    const byType = new Map<string, number>();
    for (const el of elements) {
      const t = typeof el.type === "string" ? el.type : "unknown";
      byType.set(t, (byType.get(t) ?? 0) + 1);
    }
    const parts = [...byType.entries()].map(([t, n]) => `${n} ${t}${n > 1 ? "s" : ""}`);
    return `${elements.length} element(s): ${parts.join(", ")}`;
  }

  bb.log.info("loaded");

  bb.rpc.register(rpcContract, {
    listDrawings() {
      return { drawings: store.list().map(toMeta) };
    },
    async createDrawing({ name, projectId, threadId }) {
      const project = threadId ? (await bb.sdk.threads.get({ threadId })).projectId : (projectId ?? null);
      return { drawing: toMeta(create(name, "app", project)) };
    },
    getDrawing({ id }) {
      const row = store.get(id);
      if (!row) return { drawing: null };
      return {
        drawing: {
          id: row.id,
          name: row.name,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          projectId: row.project_id,
          data: row.data,
        },
      };
    },
    /** Cheap per-drawing revision check for the editor's polling fallback. */
    getDrawingUpdatedAt({ id }) {
      return { updatedAt: store.get(id)?.updated_at ?? 0 };
    },
    saveDrawing({ id, name, data }) {
      const row = mustGet(id);
      // Multi-writer merge: element-level union, higher `version` wins,
      // tombstones preserved — so concurrent user edits and agent writes
      // both survive instead of last-writer-wins clobbering.
      const updatedAt = write(row, mergeFullScene(row.data, data), "editor", { name });
      return { ok: true, updatedAt };
    },
    renameDrawing({ id, name }) {
      mustGet(id);
      const updatedAt = store.rename(id, name, "editor");
      changed(id, updatedAt, "editor");
      return { ok: true, updatedAt };
    },
    deleteDrawing({ id }) {
      remove(id, "app");
      return { ok: true };
    },
    async attachDrawingImage({ threadId, drawingId, pngBase64 }) {
      const row = mustGet(drawingId);
      const bytes = new Uint8Array(Buffer.from(pngBase64, "base64"));
      if (!bytes.length) throw new Error("Empty image payload");

      const thread = await bb.sdk.threads.get({ threadId });
      const slug = row.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60) || "drawing";

      await bb.sdk.projects.attachments.upload({
        projectId: thread.projectId,
        clientFile: bytes,
        filename: `${slug}-${row.id.slice(0, 8)}.png`,
        mimeType: "image/png",
      });
      return { ok: true };
    },
    async pickDrawing({ threadId }) {
      const result = await bb.ui.requestInput({
        threadId,
        rendererId: "excalidraw-picker",
        title: "Attach a drawing",
        payload: { drawings: store.list().map(toMeta) },
        timeoutMs: 300_000,
      });
      if (result.outcome === "cancelled") return { drawingId: null };
      const value = result.value as { drawingId?: string };
      return { drawingId: value?.drawingId ?? null };
    },
  });

  registerStudio(bb, studio, {
    store,
    changed: (id) => changed(id, store.get(id)?.updated_at ?? Date.now(), "studio"),
  });

  // Thumbnails for Studio's cards. The URL carries the revision, so a
  // response never goes stale.
  bb.http.route("GET", "/thumbnail", (context) => {
    const row = store.get(context.req.query("drawing") ?? "");
    const svg = row ? sceneThumbnail(parseSceneData(row.data)) : null;
    if (!svg) return context.text("Not found", 404);
    return new Response(svg, {
      headers: {
        "content-type": "image/svg+xml; charset=utf-8",
        "cache-control": "private, max-age=31536000, immutable",
        // The SVG is built from scene data; never let it run anything.
        "content-security-policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'",
        "x-content-type-options": "nosniff",
      },
    });
  });

  // ---------------------------------------------------------------------
  // Native agent tools — this is the "multiplayer" path: while the user has
  // a drawing open in the side panel, the agent reads the live scene
  // (excalidraw_get_drawing), edits it (excalidraw_update_drawing), and the
  // open editor applies the change live (realtime + polling sync). Writes
  // go through the same element-level merge as editor autosaves, so both
  // writers' edits survive.
  // ---------------------------------------------------------------------

  const excalidrawElementSchema = z
    .object({ id: z.string().min(1), type: z.string().min(1) })
    .passthrough();

  bb.agents.registerTool({
    name: "excalidraw_list_drawings",
    description:
      "List Excalidraw drawings in the user's bb workspace (id, name, element count, last updated). Use when the user asks you to work with or edit an Excalidraw drawing.",
    parameters: z.object({}),
    execute() {
      const rows = store.list();
      if (!rows.length) {
        return "No Excalidraw drawings yet. Use excalidraw_create_drawing to make one.";
      }
      const lines = rows.map((r) => {
        const m = toMeta(r);
        return `- ${displayName(r)} (id ${m.id}) — ${m.elementCount} element(s), updated ${new Date(m.updatedAt).toISOString()}, link ${drawingHref(m.id)}`;
      });
      return `Excalidraw drawings:\n${lines.join("\n")}`;
    },
  });

  bb.agents.registerTool({
    name: "excalidraw_get_drawing",
    description:
      "Read the current scene of an Excalidraw drawing: element JSON, appState, files, plus a text summary. Always call this immediately before editing so you see the user's latest changes. To edit, use excalidraw_update_drawing.",
    parameters: z.object({ drawingId: z.string().min(1) }),
    execute({ drawingId }) {
      const row = store.get(drawingId);
      if (!row) {
        return {
          content: [{ type: "text", text: `Drawing ${drawingId} not found.` }],
          isError: true,
        };
      }
      const scene = parseSceneData(row.data);
      const clean = getNonDeletedElements(scene);
      const payload = {
        drawing: {
          id: row.id,
          name: displayName(row),
          elementCount: clean.length,
          updatedAt: row.updated_at,
          summary: sceneSummary(scene, "empty drawing"),
        },
        scene: {
          type: "excalidraw",
          version: 2,
          elements: clean,
          appState: scene?.appState ?? {},
          files: scene?.files ?? {},
        },
      };
      const json = JSON.stringify(payload, null, 2);
      if (json.length > MAX_TOOL_SCENE_CHARS) {
        const ids = clean
          .map((el) => (typeof el.id === "string" ? el.id : "?"))
          .join(", ");
        return [
          `Drawing "${displayName(row)}" (id ${row.id}) has ${clean.length} element(s); scene JSON is ${json.length} bytes — too large to inline.`,
          sceneSummary(scene, "empty drawing"),
          `Element ids (in z-order):\n${ids}`,
          `To edit, pass element ids in excalidraw_update_drawing. Raw scene: bb excalidraw show ${row.id}`,
        ].join("\n\n");
      }
      return json;
    },
  });

  bb.agents.registerTool({
    name: "excalidraw_create_drawing",
    description:
      "Create a new empty Excalidraw drawing and return its id, name, and link. The user can open it from Drawings, or from Studio when it's installed.",
    parameters: z.object({ name: z.string().min(1).max(200) }),
    execute({ name }) {
      const row = create(name, "agent");
      return `Created Excalidraw drawing "${name}" (id ${row.id}). Link: [${name.replace(/[[\]]/g, "")}](${drawingHref(row.id)})`;
    },
  });

  bb.agents.registerTool({
    name: "excalidraw_update_drawing",
    description:
      "Edit an Excalidraw drawing the user may have open right now: upsert elements and/or delete elements by id. The user's open editor updates live. Merge is element-level: only the elements you send change, and any element you send wins (its version is bumped), so concurrent user edits to other elements are preserved. Fetch the latest scene with excalidraw_get_drawing first. Element objects must match Excalidraw's shape (id, type, x, y, width, height, strokeColor, backgroundColor, fillStyle, strokeWidth, roughness, opacity, seed, groupIds, frameId, roundness, ...) — safest to copy an existing element from excalidraw_get_drawing and change id/type/position/text. `index` (z-order) is assigned automatically when omitted. deletedElementIds removes elements for the user, not just hides them.",
    parameters: z.object({
      drawingId: z.string().min(1),
      elements: z.array(excalidrawElementSchema).max(500).optional(),
      deletedElementIds: z.array(z.string()).max(500).optional(),
      appState: z.record(z.string(), z.unknown()).optional(),
      files: z.record(z.string(), z.unknown()).optional(),
    }),
    execute({ drawingId, elements, deletedElementIds, appState, files }) {
      const row = store.get(drawingId);
      if (!row) {
        return {
          content: [{ type: "text", text: `Drawing ${drawingId} not found.` }],
          isError: true,
        };
      }
      if (
        (!elements || elements.length === 0) &&
        (!deletedElementIds || deletedElementIds.length === 0)
      ) {
        return {
          content: [
            {
              type: "text",
              text: "Nothing to do: provide elements and/or deletedElementIds.",
            },
          ],
          isError: true,
        };
      }
      const merged = applyElementUpserts(row.data, (elements ?? []) as SceneElement[], {
        deletedElementIds,
        appState,
        files,
      });
      const updatedAt = write(row, merged, "agent");
      const clean = getNonDeletedElements(merged);
      return [
        `Updated drawing "${displayName(row)}" (id ${row.id}) — now ${clean.length} element(s): ${sceneSummary(merged)}.`,
        `- upserted ${elements?.length ?? 0} element(s), deleted ${deletedElementIds?.length ?? 0} element(s)`,
        `- saved at ${new Date(updatedAt).toISOString()}`,
        `The user's open editor has been notified and shows the change live.`,
      ].join("\n");
    },
  });

  // Make the excalidraw tools available in every agent session. Static
  // selection; tool-set changes apply on the next provider session start.
  bb.agents.configure(() => ({
    tools: [
      "excalidraw_list_drawings",
      "excalidraw_get_drawing",
      "excalidraw_create_drawing",
      "excalidraw_update_drawing",
    ],
    skills: [],
  }));

  // Mention provider: `@drawing` in any composer. Pick a drawing; at send
  // time the agent receives its scene data as context.
  bb.ui.registerMentionProvider({
    id: "drawing",
    label: "Drawings",
    search({ query }) {
      const q = query.trim().toLowerCase();
      return store
        .list({ limit: 50 })
        .filter((r) => !q || displayName(r).toLowerCase().includes(q))
        .map((r) => ({
          id: r.id,
          title: displayName(r),
          subtitle: `${toMeta(r).elementCount} elements`,
        }));
    },
    resolve(itemId) {
      const row = store.get(itemId);
      if (!row) throw new Error(`Excalidraw drawing ${itemId} not found`);
      return { context: buildMentionContext({ ...row, name: displayName(row) }) };
    },
  });

  // CLI: `bb excalidraw …` — agent-facing management of drawings.
  bb.cli.register({
    name: "excalidraw",
    summary: "Create and manage Excalidraw drawings",
    commands: [
      { name: "list", summary: "List drawings", usage: "bb excalidraw list" },
      {
        name: "create",
        summary: "Create a drawing",
        usage: "bb excalidraw create <name>",
      },
      {
        name: "show",
        summary: "Show a drawing's scene JSON (deleted elements filtered; use --raw for the unfiltered dump)",
        usage: "bb excalidraw show <id> [--raw]",
      },
      {
        name: "rename",
        summary: "Rename a drawing",
        usage: "bb excalidraw rename <id> <new-name>",
      },
      {
        name: "delete",
        summary: "Delete a drawing",
        usage: "bb excalidraw delete <id>",
      },
      {
        name: "merge",
        summary:
          "Upsert elements into a drawing from a JSON file (elements array or full scene)",
        usage: "bb excalidraw merge <id> <scene-file.json>",
      },
      {
        name: "remove-elements",
        summary: "Delete elements from a drawing by id",
        usage: "bb excalidraw remove-elements <id> <element-id> [<element-id>…]",
      },
    ],
    async run(argv, ctx) {
      const [cmd, ...rest] = argv;
      switch (cmd) {
        case "list": {
          const rows = store.list();
          if (!rows.length) return { exitCode: 0, stdout: "No drawings yet.\n" };
          const lines = rows.map((r) => {
            const meta = toMeta(r);
            return `${meta.id}\t${displayName(r)}\t${meta.elementCount} elements\t${new Date(meta.updatedAt).toISOString()}`;
          });
          return { exitCode: 0, stdout: lines.join("\n") + "\n" };
        }
        case "create": {
          const name = rest.join(" ");
          if (!name) {
            return {
              exitCode: 1,
              stderr: "usage: bb excalidraw create <name>\n",
            };
          }
          const row = create(name, "cli");
          return { exitCode: 0, stdout: `${row.id}\t${name}\n` };
        }
        case "show": {
          const [id, flag] = rest;
          if (!id) {
            return { exitCode: 1, stderr: "usage: bb excalidraw show <id> [--raw]\n" };
          }
          const row = store.get(id);
          if (!row) {
            return { exitCode: 1, stderr: `Drawing ${id} not found\n` };
          }
          // Default view filters tombstones (deleted elements) so agents and
          // humans reason about the live drawing; --raw dumps everything.
          const scene = parseSceneData(row.data);
          const out =
            flag === "--raw"
              ? row.data
              : serializeSceneData({
                  elements: getNonDeletedElements(scene),
                  appState: scene?.appState ?? {},
                  files: scene?.files ?? {},
                });
          const printed =
            out.length > 900_000
              ? out.slice(0, 900_000) + "\n…(truncated)\n"
              : out + "\n";
          return { exitCode: 0, stdout: printed };
        }
        case "rename": {
          const [id, ...nameParts] = rest;
          const name = nameParts.join(" ");
          if (!id || !name) {
            return {
              exitCode: 1,
              stderr: "usage: bb excalidraw rename <id> <new-name>\n",
            };
          }
          if (!store.get(id)) {
            return { exitCode: 1, stderr: `Drawing ${id} not found\n` };
          }
          changed(id, store.rename(id, name, "cli"), "cli");
          return { exitCode: 0, stdout: `renamed ${id} → ${name}\n` };
        }
        case "delete": {
          const id = rest[0];
          if (!id) {
            return { exitCode: 1, stderr: "usage: bb excalidraw delete <id>\n" };
          }
          if (!store.get(id)) {
            return { exitCode: 1, stderr: `Drawing ${id} not found\n` };
          }
          remove(id, "cli");
          return { exitCode: 0, stdout: `deleted ${id}\n` };
        }
        case "merge": {
          const [id, filePath, ...extra] = rest;
          if (!id || !filePath || extra.length) {
            return {
              exitCode: 1,
              stderr: "usage: bb excalidraw merge <id> <scene-file.json>\n",
            };
          }
          const row = store.get(id);
          if (!row) {
            return { exitCode: 1, stderr: `Drawing ${id} not found\n` };
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(
              await (await import("node:fs/promises")).readFile(
                (await import("node:path")).resolve(ctx.cwd ?? process.cwd(), filePath),
                "utf8",
              ),
            );
          } catch (error) {
            return {
              exitCode: 1,
              stderr: `cannot read/parse ${filePath}: ${
                error instanceof Error ? error.message : String(error)
              }\n`,
            };
          }
          const incoming =
            Array.isArray(parsed)
              ? parsed
              : (parsed as { elements?: unknown[] })?.elements ?? [];
          const upserts = incoming.filter(
            (el): el is SceneElement =>
              !!el &&
              typeof el === "object" &&
              typeof (el as SceneElement).id === "string",
          );
          const merged = applyElementUpserts(row.data, upserts);
          const updatedAt = write(row, merged, "cli");
          return {
            exitCode: 0,
            stdout: `merged ${upserts.length} element(s) into ${id}; now ${elementCount(
              merged,
            )} element(s); updatedAt ${updatedAt}\n`,
          };
        }
        case "remove-elements": {
          const [id, ...elementIds] = rest;
          if (!id || elementIds.length === 0) {
            return {
              exitCode: 1,
              stderr:
                "usage: bb excalidraw remove-elements <id> <element-id> [<element-id>…]\n",
            };
          }
          const row = store.get(id);
          if (!row) {
            return { exitCode: 1, stderr: `Drawing ${id} not found\n` };
          }
          const merged = applyElementUpserts(row.data, [], {
            deletedElementIds: elementIds,
          });
          const updatedAt = write(row, merged, "cli");
          return {
            exitCode: 0,
            stdout: `deleted ${elementIds.length} element(s) from ${id}; now ${elementCount(
              merged,
            )} element(s); updatedAt ${updatedAt}\n`,
          };
        }
        default:
          return {
            exitCode: 1,
            stderr:
              "unknown command — try: list | create <name> | show <id> | rename <id> <name> | delete <id> | merge <id> <file> | remove-elements <id> <element-id…>\n",
          };
      }
    },
  });

  bb.onDispose(() => {
    studioNotifier.dispose();
    bb.log.info("disposed");
  });
}
