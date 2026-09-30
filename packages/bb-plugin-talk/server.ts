// bb-plugin-talk — durable long-form dictation.
//
// The browser captures audio in short segments and uploads each one over RPC
// as soon as it closes (see src/client/). This server writes every segment to
// disk before acknowledging it, then a background queue transcribes segments
// in order through BB's configured voice service (Settings → AI services —
// the user's ChatGPT subscription through Codex by default). Each recording is
// a durable object: a page at /plugins/talk/recordings/<id>, a mention in the
// composer's @ menu, and `bb talk` on the command line.
import { randomBytes } from "node:crypto";
import { studioSchemas } from "@bb-studio/kit/contract";
import { createStudioNotifier } from "@bb-studio/kit/server";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { rpcContract } from "./src/shared/contract";
import { RECORDING_CHANGED, formatLength } from "./src/shared/format";
import { AudioFiles, pluginDataDirectory } from "./src/server/audio-files";
import { MENTION_TRANSCRIPT_CHARS, mentionContext, mentionSubtitle } from "./src/server/mentions";
import { MIGRATIONS, TalkStore } from "./src/server/store";
import { registerStudio } from "./src/server/studio";
import { generateTitle } from "./src/server/titles";
import { Transcriber } from "./src/server/transcriber";

export type { TalkRpcContract } from "./src/shared/contract";

/** A capturing client heartbeats every 20s; after 2 minutes it is gone. */
const STALE_AFTER_MS = 120_000;
/** Enough transcript to say what a recording is about. */
const TITLE_MIN_CHARS = 280;

function newId(prefix: string): string {
  return `${prefix}${randomBytes(10).toString("hex").slice(0, 16)}`;
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    replaceBuiltInDictation: {
      type: "boolean",
      label: "Replace built-in dictation",
      description:
        "The composer's microphone starts Talk instead of BB's one-shot dictation, so every dictation is saved and can run for hours.",
      default: true,
    },
    segmentSeconds: {
      type: "number",
      label: "Segment length (seconds)",
      description:
        "Audio is uploaded and transcribed in pieces of about this length, cut at a pause. Shorter pieces stream text sooner; 15–40 works well.",
      default: 25,
    },
    autoTitle: {
      type: "boolean",
      label: "Auto-title recordings",
      description: "Ask one of your agent providers for a short title once a recording has some text.",
      default: true,
    },
    titleProvider: {
      type: "string",
      label: "Title provider",
      description: "Provider id for titling, e.g. codex or claude-code. Leave empty to pick automatically.",
      default: "",
    },
    titleModel: {
      type: "string",
      label: "Title model",
      description: "Model for titling. Leave empty for the provider's default.",
      default: "",
    },
  });
  let config = await settings.get();
  settings.onChange((next) => {
    config = next;
  });

  const db = bb.storage.database();
  db.pragma("foreign_keys = ON");
  bb.storage.migrate(db, MIGRATIONS);
  const store = new TalkStore(db);
  const files = new AudioFiles(pluginDataDirectory(db));

  const lifetime = new AbortController();
  const studio = studioSchemas(z);
  // Transcription touches a recording every few seconds; Studio only needs to hear about it now and then.
  const studioNotifier = createStudioNotifier({ plugins: bb.sdk.plugins, pluginId: "talk", schemas: studio, delayMs: 1500 });
  bb.onDispose(() => {
    lifetime.abort();
    studioNotifier.dispose();
  });

  const changed = (id: string) => {
    bb.realtime.publish(RECORDING_CHANGED, { id });
    studioNotifier.changed();
  };

  // Empty recordings are never kept: one that finishes without a word
  // (a mic tapped by accident, silence, noise) is deleted with its audio.
  async function discardEmpty(id?: string): Promise<void> {
    for (const emptyId of store.emptyRecordings(id)) {
      store.delete(emptyId);
      await files.removeRecording(emptyId);
      changed(emptyId);
    }
  }
  await discardEmpty();

  // ── Auto-titling ────────────────────────────────────────────────────────
  const titling = new Set<string>();
  function maybeTitle(id: string): void {
    if (!config.autoTitle || titling.has(id)) return;
    const due = store.titleDue(id, TITLE_MIN_CHARS);
    if (!due) return;
    titling.add(id);
    void generateTitle(
      bb,
      {
        transcript: store.transcript(id),
        providerId: config.titleProvider.trim(),
        model: config.titleModel,
      },
      lifetime.signal,
    )
      .then((title) => {
        if (store.rename(id, title, "auto", due.chars)) changed(id);
      })
      .catch((error) => {
        if (!lifetime.signal.aborted) bb.log.warn(`Talk could not title ${id}: ${String(error)}`);
      })
      .finally(() => titling.delete(id));
  }

  // ── Transcription ───────────────────────────────────────────────────────
  const transcriber = new Transcriber({
    store,
    files,
    async transcribe(audio, hint, signal) {
      const result = await bb.sdk.system.transcribeVoice({
        file: audio,
        ...(hint ? { prompt: hint } : {}),
        signal,
      });
      return result.text;
    },
    onSegment(id) {
      changed(id);
      maybeTitle(id);
      void discardEmpty(id);
    },
    warn: (message) => bb.log.warn(message),
  });
  bb.background.service("transcriber", { start: (signal) => transcriber.run(signal) });

  bb.background.service("watchdog", {
    async start(signal) {
      while (!signal.aborted) {
        for (const id of store.interruptStale(STALE_AFTER_MS)) changed(id);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 30_000);
          signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
        });
      }
    },
  });

  // ── RPC for the frontend ────────────────────────────────────────────────
  function mustGet(id: string) {
    const recording = store.recording(id);
    if (!recording) throw new Error(`No recording ${id}.`);
    return recording;
  }

  bb.rpc.register(rpcContract, {
    recordings_list: ({ query, limit }) => ({ recordings: store.list({ query, limit }) }),
    recording_get: ({ id }) => ({ recording: mustGet(id), segments: store.segments(id) }),
    recording_create: ({ kind, projectId, threadId }) => {
      const recording = store.create({ id: newId("rec_"), kind, projectId, threadId });
      changed(recording.id);
      return recording;
    },
    recording_rename: ({ id, title }) => {
      const recording = store.rename(id, title, "user") ?? mustGet(id);
      changed(id);
      return recording;
    },
    recording_state: ({ id, status }) => {
      const recording = store.setStatus(id, status);
      if (!recording) throw new Error(`No recording ${id}.`);
      changed(id);
      if (recording.status === "done") maybeTitle(id);
      // The caller gets the final state; isEmptyRecording tells it why the
      // recording is about to disappear.
      void discardEmpty(id);
      return recording;
    },
    recording_heartbeat: ({ id }) => {
      const before = store.recording(id)?.status;
      const status = store.heartbeat(id);
      if (status !== before) changed(id);
      return { status };
    },
    segment_put: async (input) => {
      const recording = mustGet(input.recordingId);
      const bytes = Buffer.from(input.audioBase64, "base64");
      if (bytes.length === 0) throw new Error("Empty audio segment.");
      const segmentId = `${input.sessionId}-${input.index}`;
      if (store.segmentFile(recording.id, segmentId)) return { stored: false };
      const file = await files.write(recording.id, segmentId, input.mimeType, bytes);
      const stored = store.addSegment({
        recordingId: recording.id,
        sessionId: input.sessionId,
        index: input.index,
        startedAt: input.startedAt,
        durationMs: input.durationMs,
        mimeType: input.mimeType,
        bytes: bytes.length,
        file,
      });
      // A straggler from an outbox that drained after the user stopped.
      if (stored && recording.status === "done") store.setStatus(recording.id, "finishing");
      transcriber.wake();
      changed(recording.id);
      return { stored };
    },
    recording_retry: ({ id }) => {
      mustGet(id);
      store.retryFailed(id);
      transcriber.wake();
      changed(id);
      return mustGet(id);
    },
    recording_delete: async ({ id }) => {
      // A window is capturing into it; deleting now would strand the audio
      // still on its way. An interrupted one (its window is gone) can go.
      if (store.recording(id)?.status === "recording") {
        throw new Error("Stop the recording before deleting it.");
      }
      const deleted = store.delete(id);
      await files.removeRecording(id);
      if (deleted) changed(id);
      return { deleted };
    },
  });

  registerStudio(bb, studio, { store, removeAudio: (id) => files.removeRecording(id), changed });

  // Segment audio for the recording page's player. Same-origin GET only.
  bb.http.route("GET", "/audio", async (context) => {
    const recordingId = context.req.query("recording") ?? "";
    const segmentId = context.req.query("segment") ?? "";
    const entry = store.segmentFile(recordingId, segmentId);
    if (!entry) return context.text("Not found", 404);
    const bytes = await files.read(entry.file);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": entry.mimeType.split(";")[0]!,
        "cache-control": "private, max-age=31536000, immutable",
      },
    });
  });

  // ── @ mentions ──────────────────────────────────────────────────────────
  bb.ui.registerMentionProvider({
    id: "recordings",
    label: "Talk recordings",
    search: ({ query }) =>
      store.list({ query, limit: 8 }).map((recording) => ({
        id: recording.id,
        title: recording.title,
        subtitle: mentionSubtitle(recording),
        icon: "Mic",
      })),
    resolve: (id) => {
      const recording = mustGet(id);
      return { context: mentionContext(recording, store.transcript(id)) };
    },
  });

  // ── `bb talk` ───────────────────────────────────────────────────────────
  const usage = [
    "Usage:",
    "  bb talk list [--query <text>] [--json]",
    "  bb talk show <recording-id> [--json]",
    "  bb talk transcript <recording-id> [--offset <chars>] [--limit <chars>]",
  ].join("\n");
  bb.cli.register({
    name: "talk",
    summary: "Read Talk recordings and their transcripts",
    commands: [
      { name: "list", summary: "List recent recordings", usage: "bb talk list [--query <text>] [--json]" },
      { name: "show", summary: "Show one recording's details", usage: "bb talk show <recording-id> [--json]" },
      {
        name: "transcript",
        summary: "Print a recording's transcript (paged by characters)",
        usage: "bb talk transcript <recording-id> [--offset <chars>] [--limit <chars>]",
      },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const args = argv.filter((arg) => arg !== "--json");
      const option = (name: string): string | undefined => {
        const at = args.indexOf(name);
        if (at < 0) return undefined;
        const value = args[at + 1];
        args.splice(at, 2);
        return value;
      };
      const query = option("--query");
      const offset = Number(option("--offset") ?? 0);
      const limit = Math.min(Number(option("--limit") ?? 20_000), MENTION_TRANSCRIPT_CHARS);
      const [command, id] = args;
      const missing = (value: string) => ({
        exitCode: 1,
        stderr: `No recording ${value}. Run "bb talk list" to see ids.`,
      });
      switch (command) {
        case undefined:
        case "help":
        case "--help":
          return { exitCode: 0, stdout: usage };
        case "list": {
          const recordings = store.list({ query, limit: 50 });
          if (json) return { exitCode: 0, stdout: JSON.stringify(recordings) };
          return {
            exitCode: 0,
            stdout:
              recordings.length === 0
                ? "No recordings."
                : recordings
                    .map((r) => `${r.id}  ${r.title}  (${mentionSubtitle(r)}, ${r.wordCount} words)`)
                    .join("\n"),
          };
        }
        case "show": {
          if (!id) break;
          const recording = store.recording(id);
          if (!recording) return missing(id);
          if (json) return { exitCode: 0, stdout: JSON.stringify(recording) };
          return {
            exitCode: 0,
            stdout: [
              `${recording.title} (${recording.id})`,
              `Status: ${recording.status}; ${formatLength(recording.durationMs)}; ${recording.wordCount} words`,
              `Segments: ${recording.segmentCount} (${recording.pendingCount} pending, ${recording.failedCount} failed)`,
              `Link: /plugins/talk/recordings/${recording.id}`,
            ].join("\n"),
          };
        }
        case "transcript": {
          if (!id || !Number.isFinite(offset) || !Number.isFinite(limit) || offset < 0 || limit < 1) break;
          if (!store.recording(id)) return missing(id);
          const text = store.transcript(id);
          const page = text.slice(offset, offset + limit);
          const more =
            offset + limit < text.length
              ? `\n\n[${text.length - offset - limit} more characters: bb talk transcript ${id} --offset ${offset + limit}]`
              : "";
          return { exitCode: 0, stdout: page === "" ? "(No transcript.)" : page + more };
        }
      }
      return { exitCode: 1, stderr: usage };
    },
  });
}
