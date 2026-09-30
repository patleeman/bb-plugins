// Studio Artifacts (plugin id `artifacts`): keep the files agents make.
//
// Backend entry. Saving is explicit: an agent calls `artifacts_save` (or
// `bb artifacts save`), or the user picks files from a reply with "Save to
// Studio". Either way the bytes are copied at save time, since workspace and
// thread-storage files change and vanish. Saving the same file from the same
// thread again adds a version. With BB Studio installed, artifacts list in
// Studio's collection (src/server/studio.ts).
import { basename } from "node:path";
import { studioSchemas } from "@bb-studio/kit/contract";
import { createStudioNotifier } from "@bb-studio/kit/server";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { mentionContext } from "./lib/mention";
import { contentHeaders } from "./src/server/content";
import { displayPath, resolveSource, type ResolvedSource, type SourceRoot } from "./src/server/source";
import { artifactText, registerStudio } from "./src/server/studio";
import {
  ArtifactStore,
  MIGRATIONS,
  displayTitle,
  versionType,
  type ArtifactWithVersion,
  type SaveResult,
  type VersionRow,
  type Writer,
} from "./src/server/store";
import { EVENT_PAGE, turnFiles, turnRows, type EventRow } from "./src/server/turn-files";
import {
  ARTIFACT_UPDATE_TYPE,
  MAX_ARTIFACT_BYTES,
  PLUGIN_ID,
  REALTIME_CHANNEL,
  TYPE_LABELS,
  artifactHref,
  formatBytes,
  isTextType,
  mimeFor,
  titleFromName,
} from "./src/shared";

/** The viewer shows at most this much text; Download has the rest. */
const MAX_VIEW_TEXT = 2 * 1024 * 1024;
const MAX_TOOL_TEXT = 100_000;

const versionSchema = z.object({
  id: z.string(),
  number: z.number(),
  name: z.string(),
  mime: z.string(),
  size: z.number(),
  type: z.enum(["image", "html", "markdown", "code", "text", "pdf", "other"]),
  createdAt: z.number(),
});

const artifactSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  projectId: z.string().nullable(),
  sourceThreadId: z.string().nullable(),
  sourcePath: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  archived: z.boolean(),
  version: versionSchema,
  versions: z.number(),
});

const candidateSchema = z.object({
  path: z.string(),
  display: z.string(),
  kind: z.enum(["image", "created", "changed", "storage"]),
  /** Already saved from this thread. */
  artifactId: z.string().nullable(),
});

const idSchema = z.string().min(1).max(100);
const threadIdSchema = z.string().min(1).max(200);

export const rpcContract = defineRpcContract({
  get: {
    input: z.object({ id: idSchema }),
    output: z.object({ artifact: artifactSchema.nullable(), versions: z.array(versionSchema) }),
  },
  /** A text version's contents, for the viewer and Copy. */
  text: {
    input: z.object({ id: idSchema, versionId: idSchema }),
    output: z.object({ text: z.string().nullable(), truncated: z.boolean() }),
  },
  update: {
    input: z.object({ id: idSchema, title: z.string().trim().max(200).optional(), description: z.string().max(2000).optional() }),
    output: z.object({ ok: z.boolean() }),
  },
  delete: {
    input: z.object({ id: idSchema }),
    output: z.object({ ok: z.boolean() }),
  },
  move: {
    input: z.object({ id: idSchema, projectId: z.string().min(1).max(200).nullable() }),
    output: z.object({ ok: z.boolean() }),
  },
  /** Artifacts saved from one thread, newest first. */
  threadArtifacts: {
    input: z.object({ threadId: threadIdSchema }),
    output: z.object({ artifacts: z.array(artifactSchema) }),
  },
  /**
   * Files a reply produced (the reply ending at `seq`, or the latest one), and
   * the thread's storage files, for "Save to Studio".
   */
  candidates: {
    input: z.object({ threadId: threadIdSchema, seq: z.number().int().nonnegative().nullable() }),
    output: z.object({
      reply: z.array(candidateSchema),
      storage: z.array(candidateSchema),
      /** Why thread storage couldn't be listed, e.g. its host is offline. */
      storageError: z.string().nullable(),
    }),
  },
  saveFiles: {
    input: z.object({ threadId: threadIdSchema, paths: z.array(z.string().min(1).max(4096)).min(1).max(50) }),
    output: z.object({
      saved: z.array(z.object({ path: z.string(), artifactId: z.string(), outcome: z.enum(["created", "versioned", "unchanged"]) })),
      failed: z.array(z.object({ path: z.string(), error: z.string() })),
    }),
  },
  /** Copies a Markdown or text artifact into a new Studio page. */
  saveAsPage: {
    input: z.object({ id: idSchema }),
    output: z.object({ href: z.string() }),
  },
});

type ArtifactDto = z.infer<typeof artifactSchema>;

function toVersionDto(version: VersionRow) {
  return {
    id: version.id,
    number: version.number,
    name: version.name,
    mime: version.mime,
    size: version.size,
    type: versionType(version),
    createdAt: version.created_at,
  };
}

function toDto(artifact: ArtifactWithVersion): ArtifactDto {
  return {
    id: artifact.id,
    title: displayTitle(artifact),
    description: artifact.description,
    projectId: artifact.project_id,
    sourceThreadId: artifact.source_thread_id,
    sourcePath: artifact.source_path,
    createdAt: artifact.created_at,
    updatedAt: artifact.updated_at,
    archived: artifact.archived_at !== null,
    version: toVersionDto(artifact.version),
    versions: artifact.versions,
  };
}

/** The line an agent puts in its reply to show a saved artifact as a card. */
function directive(id: string): string {
  return `::artifact{id="${id}"}`;
}

export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const store = new ArtifactStore(db);

  const studio = studioSchemas(z);
  const studioNotifier = createStudioNotifier({ plugins: bb.sdk.plugins, pluginId: PLUGIN_ID, schemas: studio });

  /** Tells open viewers, collections and Studio that an artifact changed. */
  function changed(id: string) {
    try {
      bb.realtime.publish(REALTIME_CHANNEL, { type: ARTIFACT_UPDATE_TYPE, artifactId: id });
    } catch {
      // publishing is best-effort
    }
    studioNotifier.changed();
  }

  function mustGet(id: string): ArtifactWithVersion {
    const artifact = store.get(id);
    if (!artifact) throw new Error(`Artifact ${id} not found.`);
    return artifact;
  }

  /** The thread's workspace and thread storage, whichever are reachable. */
  async function threadRoots(threadId: string): Promise<{ projectId: string | null; roots: SourceRoot[]; storageError: string | null }> {
    const thread = (await bb.sdk.threads.get({ threadId, include: "environment" })) as {
      projectId: string | null;
      environment?: { hostId: string; path: string | null } | null;
    };
    const roots: SourceRoot[] = [];
    if (thread.environment?.path) roots.push({ kind: "workspace", hostId: thread.environment.hostId, path: thread.environment.path });
    let storageError: string | null = null;
    try {
      const storage = await bb.sdk.threads.storageLocation({ threadId });
      roots.push({ kind: "storage", hostId: storage.hostId, path: storage.storageRootPath });
    } catch (error) {
      storageError = error instanceof Error ? error.message : String(error);
    }
    return { projectId: thread.projectId ?? null, roots, storageError };
  }

  async function readSource(source: ResolvedSource): Promise<{ bytes: Uint8Array; mime: string | undefined }> {
    const file = await bb.sdk.files.read({ hostId: source.root.hostId, rootPath: source.root.path, path: source.path });
    const bytes = file.contentEncoding === "base64" ? Buffer.from(file.content, "base64") : Buffer.from(file.content, "utf8");
    return { bytes: new Uint8Array(bytes), mime: file.mimeType };
  }

  /** Copies a file from a thread into an artifact. */
  async function saveFromThread(input: {
    threadId: string;
    path: string;
    cwd?: string | null;
    title?: string | null;
    description?: string | null;
    artifactId?: string | null;
    by: Writer;
  }): Promise<SaveResult & { display: string }> {
    const { projectId, roots } = await threadRoots(input.threadId);
    const source = resolveSource(input.path, roots, input.cwd);
    if ("error" in source) throw new Error(source.error);
    const { bytes, mime } = await readSource(source);
    const name = basename(source.path);
    const guessed = mimeFor(name);
    const result = store.save({
      title: input.title ?? (input.artifactId ? null : titleFromName(name)),
      description: input.description,
      name,
      mime: guessed !== "application/octet-stream" ? guessed : (mime ?? guessed),
      bytes,
      projectId,
      sourceThreadId: input.threadId,
      sourcePath: source.path,
      artifactId: input.artifactId,
      by: input.by,
    });
    if (result.outcome !== "unchanged" || input.title || input.description) changed(result.artifact.id);
    return { ...result, display: displayPath(source) };
  }

  function saveInline(input: {
    content: string;
    name: string;
    projectId: string | null;
    threadId: string | null;
    title?: string | null;
    description?: string | null;
    artifactId?: string | null;
    by: Writer;
  }): SaveResult {
    const name = basename(input.name.trim()) || "artifact.txt";
    const result = store.save({
      title: input.title ?? (input.artifactId ? null : titleFromName(name)),
      description: input.description,
      name,
      mime: mimeFor(name),
      bytes: new Uint8Array(Buffer.from(input.content, "utf8")),
      projectId: input.projectId,
      sourceThreadId: input.threadId,
      artifactId: input.artifactId,
      by: input.by,
    });
    changed(result.artifact.id);
    return result;
  }

  function savedLine(result: SaveResult): string {
    const { artifact, outcome } = result;
    const what =
      outcome === "created"
        ? `Saved "${displayTitle(artifact)}" to Studio`
        : outcome === "versioned"
          ? `Saved version ${artifact.version.number} of "${displayTitle(artifact)}"`
          : `"${displayTitle(artifact)}" is already saved with these contents (version ${artifact.version.number})`;
    return `${what}: ${TYPE_LABELS[versionType(artifact.version)]}, ${formatBytes(artifact.version.size)}, id ${artifact.id}, link ${artifactHref(artifact.id)}.`;
  }

  bb.log.info("loaded");

  bb.rpc.register(rpcContract, {
    get({ id }) {
      const artifact = store.get(id);
      return { artifact: artifact ? toDto(artifact) : null, versions: artifact ? store.versions(id).map(toVersionDto) : [] };
    },
    text({ id, versionId }) {
      const version = store.version(id, versionId);
      if (!version) throw new Error("Version not found.");
      if (!isTextType(versionType(version))) return { text: null, truncated: false };
      const bytes = store.bytes(version.sha256);
      if (!bytes) return { text: null, truncated: false };
      const truncated = bytes.byteLength > MAX_VIEW_TEXT;
      return { text: bytes.subarray(0, MAX_VIEW_TEXT).toString("utf8"), truncated };
    },
    update({ id, title, description }) {
      store.update(id, { title, description }, "app");
      changed(id);
      return { ok: true };
    },
    delete({ id }) {
      if (store.delete(id)) changed(id);
      return { ok: true };
    },
    move({ id, projectId }) {
      mustGet(id);
      store.setProject(id, projectId);
      changed(id);
      return { ok: true };
    },
    threadArtifacts({ threadId }) {
      return { artifacts: store.list({ threadId, limit: 200 }).map(toDto) };
    },
    async candidates({ threadId, seq }) {
      const { roots, storageError } = await threadRoots(threadId);
      const describe = (path: string) => {
        const source = resolveSource(path, roots);
        return "error" in source ? null : source;
      };
      const reply: z.infer<typeof candidateSchema>[] = [];
      {
        // No seq: the thread's latest reply.
        const rows = await turnRows(
          async (beforeSeq) =>
            (await bb.sdk.threads.events.list({
              threadId,
              ...(beforeSeq === null ? {} : { beforeSeq: String(beforeSeq) }),
              order: "desc",
              limit: String(EVENT_PAGE),
              types: ["item/completed", "client/turn/requested"],
            })) as unknown as EventRow[],
          seq,
        );
        for (const file of turnFiles(rows, seq ?? Number.MAX_SAFE_INTEGER)) {
          const source = describe(file.path);
          // Files outside the workspace and thread storage can't be read.
          if (!source) continue;
          reply.push({
            path: source.path,
            display: displayPath(source),
            kind: file.kind,
            artifactId: store.findBySource(threadId, source.path)?.id ?? null,
          });
        }
      }
      const storage: z.infer<typeof candidateSchema>[] = [];
      const storageRoot = roots.find((root) => root.kind === "storage");
      let listError = storageError;
      if (storageRoot) {
        try {
          const { files } = await bb.sdk.threads.storageFiles({ threadId, limit: "200" });
          for (const file of files) {
            const source = describe(file.path.startsWith("/") ? file.path : `${storageRoot.path}/${file.path}`);
            if (!source || reply.some((each) => each.path === source.path)) continue;
            storage.push({
              path: source.path,
              display: displayPath(source),
              kind: "storage",
              artifactId: store.findBySource(threadId, source.path)?.id ?? null,
            });
          }
        } catch (error) {
          listError = error instanceof Error ? error.message : String(error);
        }
      }
      return { reply, storage, storageError: listError };
    },
    async saveFiles({ threadId, paths }) {
      const saved: { path: string; artifactId: string; outcome: SaveResult["outcome"] }[] = [];
      const failed: { path: string; error: string }[] = [];
      for (const path of paths) {
        try {
          const result = await saveFromThread({ threadId, path, by: "app" });
          saved.push({ path, artifactId: result.artifact.id, outcome: result.outcome });
        } catch (error) {
          failed.push({ path, error: error instanceof Error ? error.message : String(error) });
        }
      }
      return { saved, failed };
    },
    async saveAsPage({ id }) {
      const artifact = mustGet(id);
      const type = versionType(artifact.version);
      const text = artifactText(store, artifact);
      if (text === null || type === "html") throw new Error("Only Markdown, text and code artifacts can become pages.");
      const fence = "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((match) => match[0].length + 1)));
      const markdown =
        type === "markdown"
          ? text
          : `${fence}${type === "code" ? (artifact.version.name.split(".").pop() ?? "") : ""}\n${text}\n${fence}`;
      const { page } = await bb.sdk.plugins.callRpc({
        pluginId: "pages",
        method: "create",
        input: { projectId: artifact.project_id, parentId: null, title: displayTitle(artifact), markdown },
        outputSchema: z.object({ page: z.object({ id: z.string() }).passthrough() }),
      });
      return { href: `/plugins/pages/pages/${page.id}` };
    },
  });

  registerStudio(bb, studio, { store, changed });

  // A version's bytes, for images, the HTML and PDF viewers, and Download.
  // Headers (a sandbox CSP on everything that isn't a real PDF) are in
  // src/server/content.ts.
  bb.http.route("GET", "/content", (context) => {
    const version = store.version(context.req.query("artifact") ?? "", context.req.query("version") ?? "");
    const bytes = version ? store.bytes(version.sha256) : null;
    if (!version || !bytes) return context.text("Not found", 404);
    const body = new Uint8Array(bytes);
    return new Response(body, { headers: contentHeaders(version, body, { download: context.req.query("download") === "1" }) });
  });

  // ---------------------------------------------------------------------
  // Agent tools
  // ---------------------------------------------------------------------

  bb.agents.registerTool({
    name: "artifacts_save",
    description:
      "Save a finished deliverable to the user's Studio, where they keep what agents make: a generated image, an HTML page, a report, a document, a data file. " +
      "Pass `path` to a file in this thread's workspace or thread storage (relative paths are from the workspace root), or `content` plus a file `name` for short text. " +
      "Saving the same path again from this thread adds a new version. Save final outputs the user would want to keep, not scratch or intermediate files. " +
      "The result includes a line to put in your reply so the artifact shows as a card.",
    parameters: z.object({
      path: z.string().min(1).max(4096).optional(),
      content: z.string().max(1_000_000).optional(),
      name: z.string().min(1).max(200).optional(),
      title: z.string().min(1).max(200),
      description: z.string().max(2000).optional(),
      artifactId: z.string().min(1).max(100).optional(),
    }),
    async execute({ path, content, name, title, description, artifactId }, context) {
      try {
        let result: SaveResult;
        if (path && content === undefined) {
          result = await saveFromThread({ threadId: context.threadId, path, title, description, artifactId, by: "agent" });
        } else if (content !== undefined && !path) {
          if (!name) throw new Error("Give a file `name` with `content`, like report.md, so Studio knows how to show it.");
          result = saveInline({ content, name, title, description, artifactId, projectId: context.projectId ?? null, threadId: context.threadId, by: "agent" });
        } else {
          throw new Error("Pass either `path` or `content`, not both.");
        }
        return `${savedLine(result)}\n\nTo show it in your reply, put this on its own line:\n${directive(result.artifact.id)}`;
      } catch (error) {
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    },
  });

  bb.agents.registerTool({
    name: "artifacts_list",
    description: "List artifacts saved in the user's Studio: id, title, type, size and link. Pass `thisThread` to list only ones saved from this thread.",
    parameters: z.object({ thisThread: z.boolean().optional(), query: z.string().max(200).optional() }),
    execute({ thisThread, query }, context) {
      const needle = query?.trim().toLowerCase();
      const rows = store
        .list({ threadId: thisThread ? context.threadId : undefined, limit: 500 })
        .filter((artifact) => !needle || `${displayTitle(artifact)} ${artifact.description} ${artifact.version.name}`.toLowerCase().includes(needle))
        .slice(0, 100);
      if (!rows.length) return thisThread ? "Nothing has been saved from this thread yet." : "No artifacts match.";
      return rows
        .map(
          (artifact) =>
            `- ${displayTitle(artifact)} (id ${artifact.id}): ${TYPE_LABELS[versionType(artifact.version)]}, ${artifact.version.name}, ` +
            `${formatBytes(artifact.version.size)}, v${artifact.version.number}, link ${artifactHref(artifact.id)}`,
        )
        .join("\n");
    },
  });

  bb.agents.registerTool({
    name: "artifacts_read",
    description: "Read a Studio artifact: its details and, for text types (Markdown, HTML, code, text), its contents. For images and other files, use `bb artifacts export <id>` to copy it into the workspace.",
    parameters: z.object({ artifactId: z.string().min(1).max(100) }),
    execute({ artifactId }) {
      const artifact = store.get(artifactId);
      if (!artifact) return { content: [{ type: "text", text: `Artifact ${artifactId} not found.` }], isError: true };
      const text = artifactText(store, artifact);
      const head = savedLine({ artifact, outcome: "unchanged" }).replace(/ is already saved with these contents/, "");
      if (text === null) return `${head}\n\nNot text. Copy it into the workspace with: bb artifacts export ${artifact.id}`;
      const shown = text.length > MAX_TOOL_TEXT ? `${text.slice(0, MAX_TOOL_TEXT)}\n…(truncated; full text: bb artifacts show ${artifact.id})` : text;
      return `${head}\n\n${artifact.description ? `Description: ${artifact.description}\n\n` : ""}${shown}`;
    },
  });

  bb.agents.configure(() => ({ tools: ["artifacts_save", "artifacts_list", "artifacts_read"], skills: [] }));

  // `@artifact` in any composer.
  bb.ui.registerMentionProvider({
    id: "artifact",
    label: "Artifacts",
    search({ query }) {
      const needle = query.trim().toLowerCase();
      return store
        .list({ limit: 200 })
        .filter((artifact) => !needle || displayTitle(artifact).toLowerCase().includes(needle))
        .slice(0, 50)
        .map((artifact) => ({
          id: artifact.id,
          title: displayTitle(artifact),
          subtitle: `${TYPE_LABELS[versionType(artifact.version)]} · ${formatBytes(artifact.version.size)}`,
        }));
    },
    resolve(itemId) {
      const artifact = mustGet(itemId);
      return {
        context: mentionContext({
          id: artifact.id,
          title: displayTitle(artifact),
          description: artifact.description,
          type: versionType(artifact.version),
          name: artifact.version.name,
          size: artifact.version.size,
          versions: artifact.versions,
          updatedAt: artifact.updated_at,
          text: artifactText(store, artifact),
        }),
      };
    },
  });

  // CLI: `bb artifacts …`
  bb.cli.register({
    name: "artifacts",
    summary: "Save and read Studio artifacts",
    commands: [
      { name: "save", summary: "Save a file from this thread's workspace or thread storage", usage: "bb artifacts save <path> [--title <title>] [--description <text>]" },
      { name: "list", summary: "List artifacts", usage: "bb artifacts list [--thread]" },
      { name: "show", summary: "Print a text artifact's contents", usage: "bb artifacts show <id>" },
      { name: "export", summary: "Copy an artifact into this thread's workspace (or a path you give)", usage: "bb artifacts export <id> [path]" },
      { name: "delete", summary: "Delete an artifact and all its versions", usage: "bb artifacts delete <id>" },
    ],
    async run(argv, ctx) {
      const [cmd, ...rest] = argv;
      const flags = parseFlags(rest, ["thread"]);
      switch (cmd) {
        case "save": {
          const [path] = flags.positional;
          if (!path) return { exitCode: 1, stderr: "usage: bb artifacts save <path> [--title <title>] [--description <text>]\n" };
          if (!ctx.threadId) return { exitCode: 1, stderr: "Run this from a BB thread, so the path can be found.\n" };
          try {
            const result = await saveFromThread({
              threadId: ctx.threadId,
              path,
              cwd: ctx.cwd,
              title: flags.values.title,
              description: flags.values.description,
              by: "cli",
            });
            return { exitCode: 0, stdout: `${savedLine(result)}\nShow it in your reply with:\n${directive(result.artifact.id)}\n` };
          } catch (error) {
            return { exitCode: 1, stderr: `${error instanceof Error ? error.message : String(error)}\n` };
          }
        }
        case "list": {
          const rows = store.list({ threadId: flags.values.thread !== undefined ? ctx.threadId : undefined });
          if (!rows.length) return { exitCode: 0, stdout: "No artifacts yet.\n" };
          const lines = rows.map(
            (artifact) =>
              `${artifact.id}\t${displayTitle(artifact)}\t${TYPE_LABELS[versionType(artifact.version)]}\t${formatBytes(artifact.version.size)}\tv${artifact.version.number}`,
          );
          return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
        }
        case "show": {
          const artifact = store.get(flags.positional[0] ?? "");
          if (!artifact) return { exitCode: 1, stderr: "usage: bb artifacts show <id>\n" };
          const text = artifactText(store, artifact) ?? (isTextType(versionType(artifact.version)) ? store.bytes(artifact.version.sha256)?.toString("utf8") : null);
          if (text == null) return { exitCode: 1, stderr: `${artifact.id} isn't text. Copy it out with: bb artifacts export ${artifact.id}\n` };
          return { exitCode: 0, stdout: text.length > 900_000 ? `${text.slice(0, 900_000)}\n…(truncated)\n` : `${text}\n` };
        }
        case "export": {
          const [id, target] = flags.positional;
          const artifact = store.get(id ?? "");
          if (!artifact) return { exitCode: 1, stderr: "usage: bb artifacts export <id> [path]\n" };
          if (!ctx.threadId) return { exitCode: 1, stderr: "Run this from a BB thread, so there's a workspace to write to.\n" };
          const bytes = store.bytes(artifact.version.sha256);
          if (!bytes) return { exitCode: 1, stderr: "This artifact's contents are missing.\n" };
          try {
            const { roots } = await threadRoots(ctx.threadId);
            const destination = resolveSource(target ?? artifact.version.name, roots, ctx.cwd);
            if ("error" in destination) throw new Error(destination.error);
            await bb.sdk.files.write({
              hostId: destination.root.hostId,
              rootPath: destination.root.path,
              path: destination.path,
              content: bytes.toString("base64"),
              contentEncoding: "base64",
              createParents: true,
            });
            return { exitCode: 0, stdout: `${destination.path}\n` };
          } catch (error) {
            return { exitCode: 1, stderr: `${error instanceof Error ? error.message : String(error)}\n` };
          }
        }
        case "delete": {
          const id = flags.positional[0];
          if (!id) return { exitCode: 1, stderr: "usage: bb artifacts delete <id>\n" };
          if (!store.delete(id)) return { exitCode: 1, stderr: `Artifact ${id} not found\n` };
          changed(id);
          return { exitCode: 0, stdout: `deleted ${id}\n` };
        }
        default:
          return { exitCode: 1, stderr: "unknown command — try: save <path> | list [--thread] | show <id> | export <id> [path] | delete <id>\n" };
      }
    },
  });

  bb.onDispose(() => {
    studioNotifier.dispose();
    bb.log.info("disposed");
  });
}

/** `--name value` flags and positional arguments. A flag with no value is "". */
/** `booleans` name the flags that take no value, so the word after them stays positional. */
export function parseFlags(
  argv: readonly string[],
  booleans: readonly string[] = [],
): { positional: string[]; values: Record<string, string | undefined> } {
  const positional: string[] = [];
  const values: Record<string, string | undefined> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg.startsWith("--")) {
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("--") && !booleans.includes(arg.slice(2))) {
        values[arg.slice(2)] = next;
        index += 1;
      } else {
        values[arg.slice(2)] = "";
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, values };
}

export { MAX_ARTIFACT_BYTES };
