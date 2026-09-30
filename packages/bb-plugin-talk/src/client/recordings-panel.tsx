// The Recordings page: /plugins/talk/recordings lists every recording, and
// /plugins/talk/recordings/<id> is one recording's durable home — the link
// target for mentions and the CLI. With BB Studio installed, the list is
// Studio's collection.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  AddOnCollection,
  Badge,
  DANGER_BUTTON,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EditableTitle,
  FLOATING_BUTTON,
  GHOST_BUTTON,
  ICON_BUTTON,
  ItemHeader,
  OUTLINE_BUTTON,
  PageColumn,
  openAppPath,
  studioPath,
  useStudioPresent,
  type ProviderCall,
} from "@bb-studio/kit/app";
import { mentionPrompt, type StudioSchemas } from "@bb-studio/kit/contract";
import { shortDateTime } from "@bb-studio/kit/format";
import {
  useBbNavigate,
  useRealtime,
  useRpc,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import type { Recording, Segment, TalkRpcContract } from "../shared/contract";
import {
  PANEL_PATH,
  RECORDING_CHANGED,
  formatClock,
  formatLength,
  joinTranscript,
  recordingBadge,
  recordingHref,
} from "../shared/format";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { talk, useTalkState } from "./controller";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function useChangedSignal(onChange: (id: string) => void): void {
  useRealtime(RECORDING_CHANGED, (payload) => {
    const id = (payload as { id?: unknown } | null)?.id;
    if (typeof id === "string") onChange(id);
  });
}

// ── List ─────────────────────────────────────────────────────────────────
function RecordingList() {
  const rpc = useRpc<StudioSchemas["provider"]>();
  const call = useCallback<ProviderCall>((method, input) => rpc.call(method, input as never) as never, [rpc]);
  const [version, setVersion] = useState(0);
  useChangedSignal(() => setVersion((value) => value + 1));
  return <AddOnCollection pluginId="talk" title="Recordings" kind="recording" call={call} refreshKey={version} />;
}

// ── One recording ────────────────────────────────────────────────────────
function useRecording(id: string) {
  const rpc = useRpc<TalkRpcContract>();
  const [data, setData] = useState<{ recording: Recording; segments: Segment[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    rpc.call("recording_get", { id }).then(
      (result) => {
        setData(result);
        setError(null);
      },
      (cause) => setError(message(cause)),
    );
  }, [rpc, id]);
  useEffect(() => {
    setData(null);
    refetch();
  }, [refetch]);
  useChangedSignal((changed) => {
    if (changed === id) refetch();
  });
  return { rpc, data, error, refetch };
}

/** Plays segment files back to back, starting from any one of them. */
function usePlayer(recordingId: string, segments: readonly Segment[]) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const order = useRef(segments);
  order.current = segments;

  const stop = useCallback(() => {
    audio.current?.pause();
    audio.current = null;
    setPlaying(null);
  }, []);

  const play = useCallback(
    (segmentId: string) => {
      audio.current?.pause();
      const element = new Audio(
        `/api/v1/plugins/talk/http/audio?recording=${encodeURIComponent(recordingId)}&segment=${encodeURIComponent(segmentId)}`,
      );
      audio.current = element;
      setPlaying(segmentId);
      element.addEventListener("ended", () => {
        if (audio.current !== element) return;
        const list = order.current;
        const next = list[list.findIndex((segment) => segment.id === segmentId) + 1];
        if (next) play(next.id);
        else stop();
      });
      element.play().catch((error: unknown) => {
        if (audio.current === element) stop();
        toast.error(`Could not play audio: ${message(error)}`);
      });
    },
    [recordingId, stop],
  );

  useEffect(() => stop, [stop, recordingId]);
  return { playing, play, stop };
}

interface Paragraph {
  sessionId: string;
  offsetMs: number;
  segments: Segment[];
}

function paragraphs(segments: readonly Segment[]): Paragraph[] {
  const out: Paragraph[] = [];
  for (const segment of segments) {
    const last = out.at(-1);
    if (last && last.sessionId === segment.sessionId) last.segments.push(segment);
    else out.push({ sessionId: segment.sessionId, offsetMs: segment.offsetMs, segments: [segment] });
  }
  return out;
}

function RecordingDetail({ id }: { id: string }) {
  const { rpc, data, error, refetch } = useRecording(id);
  const navigate = useBbNavigate();
  const studio = useStudioPresent();
  const state = useTalkState();
  const segments = data?.segments ?? [];
  const player = usePlayer(id, segments);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const transcript = useMemo(() => joinTranscript(segments), [segments]);
  const groups = useMemo(() => paragraphs(segments), [segments]);
  // Tells the recording pill this page is where the recording lives.
  useEffect(() => {
    talk.setViewing(id);
    return () => talk.setViewing(null);
  }, [id]);
  // With Studio installed, the collection is Studio's.
  const toCollection = useCallback(
    (replace = false) => (studio ? openAppPath(studioPath("recording"), { replace }) : navigate.toPluginPanel(PANEL_PATH, { replace })),
    [navigate, studio],
  );
  // The recording went away while open: deleted elsewhere, or discarded
  // because it finished without a word.
  const gone = Boolean(data && error && /No recording/.test(error));
  const wasEmpty = data?.recording.wordCount === 0;
  const leaving = useRef(false);
  useEffect(() => {
    if (!gone || leaving.current) return;
    leaving.current = true;
    toast.info(wasEmpty ? "Talk heard nothing, so it didn't keep this recording." : "This recording was deleted.");
    toCollection(true);
  }, [gone, wasEmpty, toCollection]);

  const backLabel = studio ? "Studio" : "Recordings";
  if (error && !data) {
    return (
      <div className="relative h-full">
        <ItemHeader backLabel={backLabel} onBack={() => toCollection()} />
        <PageColumn className="max-w-3xl">
          <p className="text-sm text-destructive">{error}</p>
        </PageColumn>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="relative h-full">
        <ItemHeader backLabel={backLabel} onBack={() => toCollection()} />
        <PageColumn className="max-w-3xl">
          <p className="text-sm text-muted-foreground">Loading…</p>
        </PageColumn>
      </div>
    );
  }
  const { recording } = data;
  const activeHere = state.recordingId === id && state.phase !== "idle";
  const badge = recordingBadge(recording, activeHere && state.phase === "recording");
  const run = (work: () => Promise<unknown>) => {
    void work().then(refetch, (cause) => toast.error(message(cause)));
  };
  const copy = () =>
    void navigator.clipboard.writeText(transcript).then(
      () => toast.success("Transcript copied"),
      (cause: unknown) => toast.error(message(cause)),
    );

  return (
    <div className="relative h-full">
      <ItemHeader
        backLabel={backLabel}
        onBack={() => toCollection()}
        leading={badge ? <Badge label={badge.label} tone={badge.tone} /> : null}
        trailing={
          <>
            <button
              type="button"
              className={cn(FLOATING_BUTTON, "max-md:hidden")}
              onClick={() =>
                navigate.toCompose({
                  initialPrompt: mentionPrompt([{ title: recording.title, href: recordingHref(recording.id) }]),
                  focusPrompt: true,
                })
              }
            >
              <Icon name="MessageSquarePlus" /> New thread
            </button>
            <button type="button" aria-label="Copy transcript" title="Copy transcript" className={ICON_BUTTON} disabled={transcript === ""} onClick={copy}>
              <Icon name="Copy" className="size-4" />
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" aria-label="More" className={ICON_BUTTON}>
                  <Icon name="MoreHorizontal" className="size-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuItem
                  className="md:hidden"
                  onSelect={() =>
                    navigate.toCompose({
                      initialPrompt: mentionPrompt([{ title: recording.title, href: recordingHref(recording.id) }]),
                      focusPrompt: true,
                    })
                  }
                >
                  <Icon name="MessageSquarePlus" className="size-4" /> New thread
                </DropdownMenuItem>
                {recording.failedCount > 0 ? (
                  <DropdownMenuItem onSelect={() => run(() => rpc.call("recording_retry", { id }))}>
                    <Icon name="RotateCcw" className="size-4" /> Retry {recording.failedCount} failed
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" disabled={activeHere || recording.status === "recording"} onSelect={() => setConfirmDelete(true)}>
                  <Icon name="Trash2" className="size-4" /> Delete…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />
      <PageColumn className="max-w-3xl">
        <EditableTitle
          title={recording.title}
          placeholder="Untitled recording"
          onRename={(title) =>
            void rpc.call("recording_rename", { id, title }).then(refetch, (cause: unknown) => toast.error(message(cause)))
          }
        />
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
          <span>{shortDateTime(recording.createdAt)}</span>
          <span aria-hidden>·</span>
          <span>{formatLength(recording.durationMs)}</span>
          <span aria-hidden>·</span>
          <span>{recording.wordCount.toLocaleString()} words</span>
          {recording.kind === "dictation" ? (
            <>
              <span aria-hidden>·</span>
              <span>Dictation</span>
            </>
          ) : null}
        </div>

        {confirmDelete ? (
          <div className="mt-6 flex items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm max-md:flex-wrap">
            <span className="min-w-0 flex-1">Delete this recording and its audio? This can't be undone.</span>
            <button
              type="button"
              className={DANGER_BUTTON}
              onClick={() => {
                player.stop();
                void rpc.call("recording_delete", { id }).then(
                  () => toCollection(true),
                  (cause) => toast.error(message(cause)),
                );
              }}
            >
              Delete
            </button>
            <button type="button" className={GHOST_BUTTON} onClick={() => setConfirmDelete(false)}>
              Cancel
            </button>
          </div>
        ) : null}

        <div className="mt-6 flex flex-wrap gap-2">
          {activeHere ? (
            <>
              {state.phase === "recording" ? (
                <button type="button" className={OUTLINE_BUTTON} onClick={() => void talk.pause()}>
                  <Icon name="Pause" /> Pause
                </button>
              ) : null}
              {state.phase === "paused" || state.phase === "needs-resume" ? (
                <button type="button" className={OUTLINE_BUTTON} onClick={() => void talk.resume()}>
                  <Icon name="Mic" /> Resume
                </button>
              ) : null}
              {state.phase === "recording" || state.phase === "paused" || state.phase === "needs-resume" ? (
                <button type="button" className={DANGER_BUTTON} onClick={() => void talk.stop(false)}>
                  <Icon name="Square" /> Stop
                </button>
              ) : null}
            </>
          ) : recording.status !== "finishing" ? (
            <button
              type="button"
              className={OUTLINE_BUTTON}
              disabled={state.phase !== "idle"}
              onClick={() => void talk.continueRecording(recording)}
            >
              <Icon name="Mic" /> {recording.status === "interrupted" ? "Resume recording" : "Record more"}
            </button>
          ) : null}
        </div>

        {groups.length === 0 ? (
          <div className="mt-8 rounded-lg border border-dashed border-border px-6 py-10 text-center text-sm text-muted-foreground">
            {activeHere ? "Text appears here as each piece is transcribed." : "This recording has no audio."}
          </div>
        ) : (
          <div className="mt-8 flex flex-col gap-5">
            {groups.map((group) => (
              <section key={group.sessionId} className="flex gap-3">
                <button
                  type="button"
                  onClick={() => player.play(group.segments[0]!.id)}
                  className="mt-0.5 h-6 shrink-0 cursor-pointer rounded px-1 font-mono text-xs tabular-nums text-muted-foreground hover:bg-state-hover hover:text-foreground"
                  title="Play from here"
                >
                  {formatClock(group.offsetMs)}
                </button>
                <p className="min-w-0 flex-1 text-[15px] leading-relaxed">
                  {group.segments.map((segment) => (
                    <SegmentText
                      key={segment.id}
                      segment={segment}
                      playing={player.playing === segment.id}
                      onPlay={() => (player.playing === segment.id ? player.stop() : player.play(segment.id))}
                    />
                  ))}
                </p>
              </section>
            ))}
          </div>
        )}
      </PageColumn>
    </div>
  );
}

function SegmentText({ segment, playing, onPlay }: { segment: Segment; playing: boolean; onPlay: () => void }) {
  const at = formatClock(segment.offsetMs);
  if (segment.status === "empty") return null;
  if (segment.status === "pending") {
    return (
      <span className="mr-1 inline-flex items-center gap-1 text-sm text-muted-foreground" title={`${at} — transcribing`}>
        <Icon name="Loading" className="size-3.5 animate-spin motion-reduce:animate-none" />
        {segment.attempts > 0 ? "retrying…" : "…"}
      </span>
    );
  }
  if (segment.status === "failed") {
    return (
      <button
        type="button"
        onClick={onPlay}
        title={segment.error ?? "Transcription failed"}
        className="mr-1 cursor-pointer rounded bg-destructive/10 px-1 text-sm text-destructive"
      >
        [{at} not transcribed]
      </button>
    );
  }
  return (
    <span
      role="button"
      tabIndex={0}
      onClick={onPlay}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onPlay();
        }
      }}
      title={`${at} — play`}
      className={cn(
        "cursor-pointer rounded-sm hover:bg-state-hover",
        playing && "bg-primary/15 hover:bg-primary/20",
      )}
    >
      {segment.text}{" "}
    </span>
  );
}

export function RecordingsPanel({ subPath }: PluginNavPanelProps) {
  const id = subPath.split("/")[0] ?? "";
  return /^rec_[a-z0-9]{8,32}$/.test(id) ? <RecordingDetail id={id} /> : <RecordingList />;
}
