// "Save to Studio" in a thread's side panel: the files a reply made and the
// thread's storage files, to tick and save, and what this thread has saved.
// Opened from a message's action bar (params `{ seq }`) or the panel launcher
// (the latest reply).
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge, Checkbox, EmptyState, Icon, PRIMARY_BUTTON, cn } from "@bb-studio/kit/app";
import { errorMessage, plural, relativeTime } from "@bb-studio/kit/format";
import { useRealtime, useRpc, type PluginThreadPanelProps } from "@get-bb/plugin-sdk/app";
import type { z } from "zod";
import type { rpcContract } from "../server";
import { REALTIME_CHANNEL, SAVE_ICON, TYPE_ICONS, TYPE_LABELS, artifactType, baseName, mimeFor, prunePicked } from "../src/shared";
import { ArtifactViewer } from "./artifact-viewer";

type Candidates = z.infer<(typeof rpcContract)["candidates"]["output"]>;
type Candidate = Candidates["reply"][number];
type Saved = z.infer<(typeof rpcContract)["threadArtifacts"]["output"]>["artifacts"];

const SPIN = "animate-spin motion-reduce:animate-none";
const KIND_LABELS: Record<Candidate["kind"], string> = { image: "Generated", created: "New", changed: "Changed", storage: "" };

/** The `{ seq }` a message action opens the panel with; null for the latest reply. */
export function pickerSeq(params: unknown): number | null {
  const seq = (params as { seq?: unknown } | null)?.seq;
  return typeof seq === "number" && Number.isInteger(seq) && seq >= 0 ? seq : null;
}

export function SavePicker({ threadId, params }: PluginThreadPanelProps) {
  const [openId, setOpenId] = useState<string | null>(null);
  const back = useCallback(() => setOpenId(null), []);
  if (openId) return <ArtifactViewer artifactId={openId} backLabel="Save to Studio" onBack={back} />;
  const seq = pickerSeq(params);
  // Another reply is another list: start its selection afresh.
  return <PickerList key={`${threadId}:${seq}`} threadId={threadId} seq={seq} onOpen={setOpenId} />;
}

function PickerList({ threadId, seq, onOpen }: { threadId: string; seq: number | null; onOpen(id: string): void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [candidates, setCandidates] = useState<Candidates | null>(null);
  const [saved, setSaved] = useState<Saved>([]);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    rpc.call("candidates", { threadId, seq }).then(
      (result) => {
        setCandidates(result);
        setError(null);
        setPicked((current) => prunePicked(current, result));
      },
      (failure) => setError(errorMessage(failure)),
    );
    rpc.call("threadArtifacts", { threadId }).then(
      (result) => setSaved(result.artifacts),
      () => undefined,
    );
  }, [rpc, threadId, seq]);
  useEffect(load, [load]);
  useRealtime(REALTIME_CHANNEL, load);

  const chosen = useMemo(() => [...(picked ?? [])], [picked]);

  function toggle(path: string) {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  async function save() {
    setSaving(true);
    try {
      const { saved: done, failed } = await rpc.call("saveFiles", { threadId, paths: chosen });
      const changed = done.filter((each) => each.outcome !== "unchanged" || each.restored).length;
      if (done.length) {
        toast.success(
          changed === 0
            ? "Already saved with these contents"
            : done.length === 1
              ? "Saved to Studio"
              : `Saved ${plural(done.length, "file")} to Studio`,
        );
      }
      for (const failure of failed) toast.error(`${baseName(failure.path)}: ${failure.error}`);
      setPicked(new Set(failed.map((failure) => failure.path)));
      load();
    } catch (failure) {
      toast.error(errorMessage(failure));
    } finally {
      setSaving(false);
    }
  }

  if (error) return <EmptyState icon="AlertTriangle" title="Couldn't list this thread's files">{error}</EmptyState>;
  if (!candidates) {
    return (
      <div role="status" className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Icon name="Loading" className={cn("size-4", SPIN)} /> Finding files…
      </div>
    );
  }

  const empty = !candidates.reply.length && !candidates.storage.length;
  return (
    <div className="studio-root flex h-full min-h-0 flex-col bg-background text-foreground">
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {empty ? (
          <p className="px-2 py-6 text-center text-sm text-muted-foreground">
            {seq === null ? "The latest reply" : "This reply"} didn't make any files, and there's nothing in thread storage.
            {candidates.storageError ? ` (${candidates.storageError})` : ""}
          </p>
        ) : null}
        <FileSection
          title={seq === null ? "From the latest reply" : "From this reply"}
          files={candidates.reply}
          picked={picked}
          onToggle={toggle}
          onOpen={onOpen}
        />
        <FileSection title="Thread files" files={candidates.storage} picked={picked} onToggle={toggle} onOpen={onOpen} />
        {saved.length ? (
          <section className="mt-4">
            <h3 className="px-2 pb-1 text-xs font-medium text-muted-foreground">Saved from this thread</h3>
            <ul>
              {saved.map((artifact) => (
                <li key={artifact.id}>
                  <button
                    type="button"
                    onClick={() => onOpen(artifact.id)}
                    className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-state-hover"
                  >
                    <Icon name={TYPE_ICONS[artifact.version.type]} className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{artifact.title}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {artifact.versions > 1 ? `v${artifact.version.number} · ` : ""}
                      {relativeTime(artifact.updatedAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
      {empty ? null : (
        <div className="flex shrink-0 items-center gap-2 border-t border-border/70 px-4 py-3">
          <span className="flex-1 text-xs text-muted-foreground">
            {chosen.length ? `${plural(chosen.length, "file")} selected` : "Pick the files to keep"}
          </span>
          <button type="button" className={PRIMARY_BUTTON} disabled={!chosen.length || saving} onClick={() => void save()}>
            <Icon name={saving ? "Loading" : SAVE_ICON} className={cn("size-4", saving && SPIN)} /> Save to Studio
          </button>
        </div>
      )}
    </div>
  );
}

function FileSection({
  title,
  files,
  picked,
  onToggle,
  onOpen,
}: {
  title: string;
  files: readonly Candidate[];
  picked: Set<string> | null;
  onToggle(path: string): void;
  onOpen(id: string): void;
}) {
  if (!files.length) return null;
  return (
    <section className="mb-3">
      <h3 className="px-2 pb-1 text-xs font-medium text-muted-foreground">{title}</h3>
      <ul>
        {files.map((file) => {
          const name = baseName(file.path);
          const type = artifactType(name, mimeFor(name));
          const checked = picked?.has(file.path) ?? false;
          return (
            <li
              key={file.path}
              className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-state-hover"
              onClick={() => onToggle(file.path)}
            >
              <Checkbox checked={checked} label={`Save ${name}`} onToggle={() => onToggle(file.path)} />
              <Icon name={TYPE_ICONS[type]} className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">{name}</div>
                <div className="truncate text-xs text-muted-foreground" title={file.display}>
                  {TYPE_LABELS[type]} · {file.display}
                </div>
              </div>
              {file.artifactId ? (
                <button
                  type="button"
                  title="Saved. A new save adds a version if it changed."
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpen(file.artifactId!);
                  }}
                  className="shrink-0"
                >
                  <Badge label="Saved" tone="success" />
                </button>
              ) : KIND_LABELS[file.kind] ? (
                <Badge label={KIND_LABELS[file.kind]} className="shrink-0" />
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
