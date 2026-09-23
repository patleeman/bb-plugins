import { useEffect, useId, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { Attachment, RoomMessage, rpcContract } from "./contract";
import {
  channelContext,
  defaultLimits,
  type ChannelContext,
} from "./workspace-contract";
import { Button } from "./components/ui/button";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { IconActionTooltip } from "./channel-controls";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import {
  ActionBar,
  EmptyState,
  ErrorMessage,
  FormRow,
  message,
  Section,
} from "./bot-ui";
import { ChannelAttachments } from "./channel-attachments";

export type WorkbenchPanel =
  | "automations"
  | "activity"
  | "context"
  | "files"
  | "usage"
  | "saved";
export const workbenchLabels: Record<WorkbenchPanel, string> = {
  automations: "Automations",
  activity: "Activity",
  context: "Context",
  files: "Files",
  usage: "Usage",
  saved: "Decisions",
};
import { RevisionList, type Revision } from "./revision-list";

export function ContextPanel({ id }: { id: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const controlId = useId();
  const key = `bb:bots:context:${id}`;
  const [draft, setDraft] = useState<ChannelContext | null>(null),
    [baseline, setBaseline] = useState<ChannelContext | null>(null);
  const [error, setError] = useState<string | null>(null),
    [pending, setPending] = useState(false),
    [notice, setNotice] = useState("");
  const [files, setFiles] = useState<Attachment[]>([]),
    [fileCursor, setFileCursor] = useState<string | null>(null),
    [revisions, setRevisions] = useState<Revision[] | null>(null);
  const historyBusy = useRef(false),
    fileBusy = useRef(false);
  const [historyMore, setHistoryMore] = useState(false),
    [historyPending, setHistoryPending] = useState(false),
    [filePending, setFilePending] = useState(false);
  const dirty =
    !!draft && !!baseline && JSON.stringify(draft) !== JSON.stringify(baseline);
  const load = async () => {
    try {
      const d = await rpc.call("channelContext", { id });
      setBaseline(d);
      let restored: ChannelContext | null = null;
      try {
        const parsed = channelContext.safeParse(
          JSON.parse(localStorage.getItem(key) ?? "null"),
        );
        if (parsed.success) restored = parsed.data;
      } catch {}
      setDraft(restored ?? d);
      if (restored && restored.version !== d.version)
        setError(
        "Channel context changed. Your draft is preserved. Copy your edits or reload the latest version.",
        );
    } catch (e) {
      setError(message(e));
    }
  };
  useEffect(() => {
    void load();
    void rpc.call("channelFiles", { id }).then(
      (p) => {
        setFiles(p.files);
        setFileCursor(p.nextBefore);
      },
      (e) => setError(message(e)),
    );
  }, [id, rpc]);
  useEffect(() => {
    if (!draft || !baseline) return;
    try {
      if (dirty) localStorage.setItem(key, JSON.stringify(draft));
      else localStorage.removeItem(key);
    } catch {
      setError("This draft could not be saved on this device.");
    }
  }, [key, draft, baseline, dirty]);
  const save = async () => {
    if (!draft) return;
    setPending(true);
    setError(null);
    try {
      const d = await rpc.call("saveChannelContext", { id, ...draft });
      setDraft(d);
      setBaseline(d);
      setNotice("Saved. Bots receive this context on their next task.");
      setRevisions(null);
    } catch (e) {
      setError(message(e));
    } finally {
      setPending(false);
    }
  };
  const history = async (before?: number) => {
    if (historyBusy.current) return;
    historyBusy.current = true;
    setHistoryPending(true);
    try {
      const page = await rpc.call("contextHistory", {
        id,
        ...(before !== undefined ? { before } : {}),
      });
      setRevisions((old) => (before ? [...(old ?? []), ...page] : page));
      setHistoryMore(page.length === 20);
    } catch (e) {
      setError(message(e));
    } finally {
      historyBusy.current = false;
      setHistoryPending(false);
    }
  };
  const moreFiles = async () => {
    if (fileBusy.current || !fileCursor) return;
    fileBusy.current = true;
    setFilePending(true);
    try {
      const p = await rpc.call("channelFiles", { id, before: fileCursor });
      setFiles((f) => [
        ...new Map([...f, ...p.files].map((a) => [a.id, a])).values(),
      ]);
      setFileCursor(p.nextBefore);
    } catch (e) {
      setError(message(e));
    } finally {
      fileBusy.current = false;
      setFilePending(false);
    }
  };
  if (!draft)
    return (
      <div className="channel-workbench-panel">
        <ErrorMessage error={error} />
        <p role="status" className="bot-empty-state">Loading context…</p>
      </div>
    );
  return (
    <div className="channel-workbench-panel channel-context-form">
      <p className="channel-workbench-intro">
        Shared guidance that every bot in this channel receives.
      </p>
      <Section title="Channel guidance">
        {(
          [
            ["brief", "Brief and instructions", "What bots should know before working here."],
            ["decisions", "Decisions", "Settled choices and conventions for this channel."],
            ["memory", "Channel memory", "Durable facts shared across the channel."],
          ] as const
        ).map(([field, label, placeholder]) => (
          <FormRow
            key={field}
            label={label}
            htmlFor={`${controlId}-${field}`}
            className={field === "memory" ? "channel-memory-row" : ""}
          >
            <Textarea
              id={`${controlId}-${field}`}
              rows={field === "memory" ? 7 : 3}
              value={draft[field]}
              placeholder={placeholder}
              maxLength={16000}
              disabled={pending}
              onChange={(e) => {
                setDraft({ ...draft, [field]: e.target.value });
                setNotice("");
              }}
            />
          </FormRow>
        ))}
      </Section>
      <Section title="Reference files">
        {files.length ? (
          <div className="channel-reference-files">
            {files.map((a) => (
              <label className="channel-reference-file" key={a.id}>
                <input
                  type="checkbox"
                  checked={draft.attachmentIds.includes(a.id)}
                  disabled={
                    pending ||
                    (!draft.attachmentIds.includes(a.id) &&
                      draft.attachmentIds.length >= 10)
                  }
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      attachmentIds: e.target.checked
                        ? [...draft.attachmentIds, a.id]
                        : draft.attachmentIds.filter((x) => x !== a.id),
                    })
                  }
                />
                {a.name}
              </label>
            ))}
          </div>
        ) : (
          <EmptyState
            title="No reference files"
            description="Send a file in the channel to keep it here."
          />
        )}
        {fileCursor && (
          <Button
            size="sm"
            variant="ghost"
            disabled={filePending}
            onClick={() => void moreFiles()}
          >
            More files
          </Button>
        )}
      </Section>
      <ErrorMessage error={error} />
      <ActionBar
        status={notice || (dirty ? "Unsaved changes · draft saved" : "")}
        secondary={
          <>
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => {
                if (
                  !dirty ||
                  window.confirm("Discard your context draft and reload?")
                ) {
                  localStorage.removeItem(key);
                  void load();
                  setError(null);
                }
              }}
            >
              Reload
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={historyPending}
              onClick={() => void history()}
            >
              Version history
            </Button>
          </>
        }
        primary={dirty || pending ? (
          <Button
            size="sm"
            disabled={pending || !dirty || draft.version !== baseline?.version}
            onClick={() => void save()}
          >
            {pending ? "Saving…" : "Save context"}
          </Button>
        ) : undefined}
      />
      {revisions && (
        <RevisionList
          revisions={revisions.map((r) => ({
            ...r,
            text: JSON.stringify(JSON.parse(r.text), null, 2),
          }))}
          current={JSON.stringify(draft, null, 2)}
          morePending={historyPending}
          onMore={
            historyMore ? () => void history(revisions.at(-1)!.id) : undefined
          }
          onUse={(text) => {
            const old = channelContext.parse(JSON.parse(text));
            setDraft({
              ...old,
              version: baseline!.version,
              updatedAt: baseline!.updatedAt,
            });
            setError(null);
            setNotice(
              "Version loaded into your draft. Save context to restore it.",
            );
          }}
        />
      )}
    </div>
  );
}

export function FilesPanel({ id }: { id: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [files, setFiles] = useState<Attachment[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [error, setError] = useState<string | null>(null),
    [pending, setPending] = useState(false);
  const load = async (before?: string) => {
    setPending(true);
    try {
      const p = await rpc.call("channelFiles", {
        id,
        ...(before !== undefined ? { before } : {}),
      });
      setFiles((old) => (before ? [...old, ...p.files] : p.files));
      setCursor(p.nextBefore);
    } catch (e) {
      setError(message(e));
    } finally {
      setPending(false);
    }
  };
  useEffect(() => {
    void load();
  }, [id, rpc]);
  return (
    <div className="channel-workbench-panel">
      <ErrorMessage error={error} />
      {!files.length && (pending ? (
        <p role="status" className="bot-empty-state">Loading files…</p>
      ) : (
        <EmptyState
          title="No files yet"
          description="Shared files will appear here."
        />
      ))}
      <ChannelAttachments attachments={files} />
      {cursor && (
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => void load(cursor)}
        >
          Earlier files
        </Button>
      )}
    </div>
  );
}

export function UsagePanel({
  id,
  kind,
}: {
  id: string;
  kind: "bot" | "channel";
}) {
  const rpc = useRpc<typeof rpcContract>();
  const controlId = useId();
  const [usage, setUsage] = useState<Awaited<
    ReturnType<typeof rpc.call<"usage">>
  > | null>(null);
  const [limits, setLimits] = useState(defaultLimits),
    [baselineLimits, setBaselineLimits] = useState(defaultLimits),
    [error, setError] = useState<string | null>(null),
    [pending, setPending] = useState(false),
    [notice, setNotice] = useState("");
  const dirty = JSON.stringify(limits) !== JSON.stringify(baselineLimits);
  useEffect(() => {
    void rpc.call("usage", { id, kind }).then(
      (data) => {
        setUsage(data);
        setLimits(data.limits);
        setBaselineLimits(data.limits);
      },
      (cause) => setError(message(cause)),
    );
  }, [id, kind, rpc]);
  const limitsValid = Object.entries({
    turnsPerHour: [1, 1000],
    turnsPerDay: [1, 10000],
    minutesPerTurn: [1, 180],
    concurrentForks: [1, 16],
  }).every(([field, [minimum, maximum]]) => {
    const value = limits[field as keyof typeof limits];
    return Number.isInteger(value) && value >= minimum! && value <= maximum!;
  });
  const save = async () => {
    if (pending || !usage || !dirty || !limitsValid) return;
    setPending(true);
    setError(null);
    setNotice("");
    try {
      const data = await rpc.call("saveLimits", { id, kind, limits });
      setUsage(data);
      setLimits(data.limits);
      setBaselineLimits(data.limits);
      setNotice("Limits saved.");
    } catch (cause) {
      setError(message(cause));
    } finally {
      setPending(false);
    }
  };
  const values = usage
    ? [
        ["Tasks", usage.turns],
        ["Forks", usage.forks],
        ["Unfinished", usage.active],
        ["Failed", usage.errors],
        ...(kind === "channel"
          ? [
              ["Classifier calls", usage.routingCalls],
              [
                "Classifier time",
                `${Math.round(usage.routingMilliseconds / 1000)}s`,
              ],
            ]
          : []),
      ]
    : [];
  return (
    <div className="channel-workbench-panel channel-context-form">
      <Section title="Last 24 hours">
        <div className="channel-usage-heading">
          <IconActionTooltip
            label="Task counts and limits count started turns. Unfinished includes queued work. Classifier calls are shown separately. Provider billing and token usage remain in View work."
          >
            <Button
              size="icon"
              variant="ghost"
              aria-label="How usage is counted"
            >
              <Icon name="Info" />
            </Button>
          </IconActionTooltip>
        </div>
        {usage ? (
          <dl className="channel-usage-stats">
            {values.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p role="status" className="bot-empty-state">Loading usage…</p>
        )}
      </Section>
      <Section title="Limits">
        <FormRow label="Work limits">
          <div className="channel-usage-limit-row">
            <label htmlFor={`${controlId}-hour`}>
              <Input
                id={`${controlId}-hour`}
                type="number"
                min={1}
                max={1000}
                aria-label="Turns per hour"
                disabled={pending}
                value={limits.turnsPerHour}
                onChange={(e) => setLimits({ ...limits, turnsPerHour: Number(e.target.value) })}
              />
              turns per hour
            </label>
            <label htmlFor={`${controlId}-day`}>
              <Input
                id={`${controlId}-day`}
                type="number"
                min={1}
                max={10000}
                aria-label="Turns per day"
                disabled={pending}
                value={limits.turnsPerDay}
                onChange={(e) => setLimits({ ...limits, turnsPerDay: Number(e.target.value) })}
              />
              turns per day
            </label>
            {kind === "bot" && (
              <>
                <label htmlFor={`${controlId}-minutes`}>
                  <Input
                    id={`${controlId}-minutes`}
                    type="number"
                    min={1}
                    max={180}
                    aria-label="Minutes per turn"
                    disabled={pending}
                    value={limits.minutesPerTurn}
                    onChange={(e) => setLimits({ ...limits, minutesPerTurn: Number(e.target.value) })}
                  />
                  minutes per turn
                </label>
                <label htmlFor={`${controlId}-forks`}>
                  <Input
                    id={`${controlId}-forks`}
                    type="number"
                    min={1}
                    max={16}
                    aria-label="Concurrent forks"
                    disabled={pending}
                    value={limits.concurrentForks}
                    onChange={(e) => setLimits({ ...limits, concurrentForks: Number(e.target.value) })}
                  />
                  concurrent forks
                </label>
              </>
            )}
          </div>
        </FormRow>
      </Section>
      <ErrorMessage
        error={error || (dirty && !limitsValid ? "Use whole numbers within the allowed ranges." : null)}
      />
      <ActionBar
        status={notice || (dirty ? "Unsaved changes" : "")}
        primary={dirty || pending ? (
          <Button size="sm" disabled={pending || !usage || !dirty || !limitsValid} onClick={() => void save()}>
            {pending ? "Saving…" : "Save limits"}
          </Button>
        ) : undefined}
      />
    </div>
  );
}

export function SavedPanel({
  id,
  onJump,
}: {
  id: string;
  onJump: (id: string) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [items, setItems] = useState<RoomMessage[]>([]),
    [error, setError] = useState<string | null>(null),
    [more, setMore] = useState(false),
    [pending, setPending] = useState(false);
  const busy = useRef(false);
  const load = async (before?: string) => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    try {
      const p = await rpc.call("savedMessages", {
        id,
        ...(before !== undefined ? { before } : {}),
      });
      setItems((old) =>
        before
          ? [...new Map([...old, ...p].map((m) => [m.id, m])).values()]
          : p,
      );
      setMore(p.length === 50);
    } catch (e) {
      setError(message(e));
    } finally {
      busy.current = false;
      setPending(false);
    }
  };
  useEffect(() => {
    void load();
  }, [id, rpc]);
  return (
    <div className="channel-workbench-panel">
      <ErrorMessage error={error} />
      {!items.length && (
        <EmptyState
          title="No saved decisions"
          description="Save a message from its menu to keep it here."
        />
      )}
      {items.map((m) => (
        <button
          className="channel-search-result"
          key={m.id}
          onClick={() => onJump(m.id)}
        >
          <strong>{m.speaker}</strong>
          <span className="line-clamp-3">{m.text}</span>
        </button>
      ))}
      {more && (
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => void load(items.at(-1)!.id)}
        >
          Earlier decisions
        </Button>
      )}
    </div>
  );
}
