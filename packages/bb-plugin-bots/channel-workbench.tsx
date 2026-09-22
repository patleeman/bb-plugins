import { useEffect, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { Attachment, RoomMessage, rpcContract } from "./contract";
import {
  channelContext,
  defaultLimits,
  type ChannelContext,
} from "./workspace-contract";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import { ErrorMessage, message } from "./bot-ui";
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
  context: "Channel context",
  files: "Files",
  usage: "Usage and limits",
  saved: "Saved decisions",
};
import { RevisionList, type Revision } from "./revision-list";

export function ContextPanel({ id }: { id: string }) {
  const rpc = useRpc<typeof rpcContract>();
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
        <p>Loading context…</p>
      </div>
    );
  return (
    <div className="channel-workbench-panel channel-context-form">
      <p className="text-sm text-muted-foreground">
        Standing context for every bot in this channel. Bot-wide knowledge stays
        in each bot’s memory.
      </p>
      {(
        [
          ["brief", "Brief and instructions"],
          ["decisions", "Decisions"],
          ["memory", "Channel memory"],
        ] as const
      ).map(([field, label]) => (
        <label key={field}>
          {label}
          <Textarea
            aria-label={label}
            value={draft[field]}
            maxLength={16000}
            disabled={pending}
            onChange={(e) => {
              setDraft({ ...draft, [field]: e.target.value });
              setNotice("");
            }}
          />
        </label>
      ))}
      <fieldset>
        <legend>Reference files</legend>
        {files.length ? (
          files.map((a) => (
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
          ))
        ) : (
          <p className="text-sm text-muted-foreground">
            Send a file in the channel to keep it as a reference.
          </p>
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
      </fieldset>
      <ErrorMessage error={error} />
      <p role="status">
        {notice || (dirty ? "Unsaved changes · draft saved" : "")}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={pending || !dirty || draft.version !== baseline?.version}
          onClick={() => void save()}
        >
          Save context
        </Button>
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
      </div>
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
      {!files.length && (
        <p>
          {pending
            ? "Loading files…"
            : "Files shared by you and the bots appear here."}
        </p>
      )}
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
  const [usage, setUsage] = useState<Awaited<
    ReturnType<typeof rpc.call<"usage">>
  > | null>(null);
  const [limits, setLimits] = useState(defaultLimits),
    [error, setError] = useState<string | null>(null),
    [pending, setPending] = useState(false),
    [notice, setNotice] = useState("");
  useEffect(() => {
    void rpc.call("usage", { id, kind }).then(
      (d) => {
        setUsage(d);
        setLimits(d.limits);
      },
      (e) => setError(message(e)),
    );
  }, [id, kind, rpc]);
  return (
    <div className="channel-workbench-panel channel-context-form">
      <p className="text-sm text-muted-foreground">
        Work requested in the last 24 hours. Bot and channel limits both apply.
      </p>
      {usage && (
        <dl className="channel-usage-stats">
          {[
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
          ].map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
      <p className="text-xs text-muted-foreground">
        Task counts and limits count started turns. Unfinished includes queued
        work. Classifier calls are shown separately. Provider billing and token
        usage remain in View work.
      </p>
      {(
        [
          ["turnsPerHour", "Turns per hour"],
          ["turnsPerDay", "Turns per day"],
          ...(kind === "bot"
            ? [
                ["minutesPerTurn", "Minutes per turn"],
                ["concurrentForks", "Concurrent forks"],
              ]
            : []),
        ] as [keyof typeof limits, string][]
      ).map(([field, label]) => (
        <label key={field}>
          {label}
          <Input
            type="number"
            min={1}
            aria-label={label}
            value={limits[field]}
            onChange={(e) =>
              setLimits({ ...limits, [field]: Number(e.target.value) })
            }
          />
        </label>
      ))}
      <ErrorMessage error={error} />
      <p role="status">{notice}</p>
      <Button
        size="sm"
        disabled={pending || !usage}
        onClick={async () => {
          setPending(true);
          setError(null);
          try {
            const u = await rpc.call("saveLimits", { id, kind, limits });
            setUsage(u);
            setLimits(u.limits);
            setNotice("Limits saved. Queued work uses the new limits.");
          } catch (e) {
            setError(message(e));
          } finally {
            setPending(false);
          }
        }}
      >
        Save limits
      </Button>
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
        <p>Save a message from its menu to keep a decision here.</p>
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
