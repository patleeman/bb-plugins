// Talk as a Studio add-on: the `studio_*` methods Studio calls to list and
// manage recordings in its collection.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { eachId, type StudioItem, type StudioKind, type StudioSchemas } from "@bb-studio/kit/contract";
import { snippets } from "@bb-studio/kit/format";
import { registerStudioProvider } from "@bb-studio/kit/server";
import type { Recording } from "../shared/contract";
import { NEW_RECORDING_EVENT, TALK_ICON, formatLength, recordingBadge, recordingHref } from "../shared/format";
import type { TalkStore } from "./store";

const COLUMNS = [
  { id: "length", label: "Length" },
  { id: "words", label: "Words" },
];
const COPY_TRANSCRIPT = { id: "copy-transcript", label: "Copy transcript", icon: "Copy", result: "copy" } as const;

export const RECORDING_KINDS: StudioKind[] = [
  {
    id: "recording",
    label: "Recording",
    plural: "Recordings",
    icon: TALK_ICON,
    columns: COLUMNS,
    actions: [COPY_TRANSCRIPT],
    create: { mode: "event", event: NEW_RECORDING_EVENT },
    canArchive: true,
    blurb: "Long voice notes, transcribed.",
    agentHint: "Read the transcript with `bb talk transcript <id>`; `bb talk show <id>` has the details.",
  },
  {
    id: "dictation",
    label: "Dictation",
    plural: "Dictations",
    icon: "Mic",
    columns: COLUMNS,
    actions: [COPY_TRANSCRIPT],
    // Dictations start from a composer or a field's microphone.
    create: null,
    canArchive: true,
    blurb: "Your dictations, with audio.",
    agentHint: "Read the transcript with `bb talk transcript <id>`; `bb talk show <id>` has the details.",
  },
];

const PREVIEW_CHARS = 140;

export function toStudioItem(recording: Recording, transcript: string): StudioItem {
  const text = transcript.replace(/\s+/g, " ").trim();
  return {
    id: recording.id,
    kind: recording.kind,
    title: recording.title,
    icon: null,
    projectId: recording.projectId,
    parentId: null,
    createdAt: recording.createdAt,
    updatedAt: recording.updatedAt,
    updatedBy: "user",
    preview: text ? (text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS - 1).trimEnd()}…` : text) : null,
    facts: [
      { id: "length", value: formatLength(recording.durationMs), sort: recording.durationMs },
      { id: "words", value: recording.wordCount.toLocaleString("en-US"), sort: recording.wordCount },
    ],
    badge: recordingBadge(recording),
    thumbnailUrl: null,
    href: recordingHref(recording.id),
    archived: recording.archived,
  };
}

const LIVE = new Set(["recording", "paused"]);

/** Studio lists at most this many; past it, Studio keeps tags of items it didn't see. */
const LIST_LIMIT = 10_000;

export function registerStudio(
  bb: BbPluginApi,
  schemas: StudioSchemas,
  deps: { store: TalkStore; removeAudio(id: string): Promise<void>; changed(id: string): void },
): void {
  const { store } = deps;
  const mustGet = (id: string) => {
    const recording = store.recording(id);
    if (!recording) throw new Error("Recording not found.");
    return recording;
  };

  registerStudioProvider(bb, schemas, {
    studio_describe: () => ({ pluginId: "talk", version: 1, panel: "recordings", kinds: RECORDING_KINDS }),
    studio_list: () => {
      const rows = store.list({ includeArchived: true, limit: LIST_LIMIT });
      return {
        items: rows.map((recording) => toStudioItem(recording, store.transcript(recording.id))),
        truncated: rows.length === LIST_LIMIT,
      };
    },
    studio_search: ({ query }) => {
      const found = store.list({ query, limit: 200 });
      return {
        ids: found.map((recording) => recording.id),
        snippets: snippets(found, query, (recording) => store.transcript(recording.id)),
      };
    },
    studio_create: () => {
      throw new Error("Start a recording from Talk's microphone.");
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
      eachId(ids, async (id) => {
        if (LIVE.has(mustGet(id).status)) throw new Error("Stop the recording before deleting it.");
        store.delete(id);
        await deps.removeAudio(id);
        deps.changed(id);
      }),
    studio_action: ({ action, ids }) => {
      if (action !== COPY_TRANSCRIPT.id) throw new Error(`Unknown action "${action}".`);
      const parts = ids.map((id) => {
        const recording = mustGet(id);
        const transcript = store.transcript(id);
        return ids.length === 1 ? transcript : `## ${recording.title}\n\n${transcript || "(No transcript.)"}`;
      });
      return {
        message: ids.length === 1 ? "Transcript copied" : `Copied ${ids.length} transcripts`,
        text: parts.join("\n\n"),
      };
    },
  });
}
