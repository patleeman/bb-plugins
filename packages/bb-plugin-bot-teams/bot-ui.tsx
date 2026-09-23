import { RevisionList, type Revision } from "./revision-list";
import { MarkdownEditor } from "./markdown-editor";
import { isForkConversation } from "./send-mode";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  useBbNavigate,
  useRpc,
  experimental_Icon as Icon,
  experimental_ProviderModelPicker as ProviderModelPicker,
  experimental_PermissionModePicker as PermissionModePicker,
} from "@get-bb/plugin-sdk/app";
import type { Bot, Job, ProfileInput, rpcContract } from "./contract";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import {
  readConfigDraft,
  writeConfigDraft,
  profileDraft,
  documentDraft,
} from "./config-draft";
import { Modal } from "./channel-controls";
import { COARSE_POINTER_HEADER_ICON_BUTTON_CLASS } from "./components/ui/coarse-pointer-sizing";
import "./styles.css";

export const message = (e: unknown) =>
  e instanceof Error ? e.message : String(e);
const defaults: ProfileInput = {
  name: "",
  description: "",
  avatar: "🤖",
  providerId: "codex",
  model: "",
  reasoningLevel: "medium",
  permissionMode: "auto",
  intervalMinutes: 0,
};
function ConfigRow({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="bot-config-row">
      {htmlFor ? (
        <label htmlFor={htmlFor}>{label}</label>
      ) : (
        <div className="bot-config-label">{label}</div>
      )}
      <div className="min-w-0">
        {children}
        {hint && (
          <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
            {hint}
          </p>
        )}
      </div>
    </div>
  );
}
function ConfigSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium leading-5 text-muted-foreground">
        {title}
      </h2>
      <div className="overflow-hidden rounded-md border border-border bg-card divide-y divide-border">
        {children}
      </div>
    </section>
  );
}
export function ErrorMessage({ error }: { error: string | null }) {
  return error ? (
    <p role="alert" className="text-sm text-destructive">
      {error}
    </p>
  ) : null;
}

export function ProfileForm({
  bot,
  onSaved,
}: {
  bot: Bot;
  onSaved: (bot: Bot) => void | Promise<void>;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const draftKey = `bb:bots:profile:${bot.id}`;
  const [restored] = useState(() => readConfigDraft(draftKey, profileDraft));
  const [draft, setDraft] = useState<ProfileInput>(
    restored?.draft ?? bot,
  );
  const [version, setVersion] = useState<number | null>(
    restored?.version ?? bot.updatedAt,
  );
  const submitting = useRef(false);
  const id = useId();
  const [baseline, setBaseline] = useState<ProfileInput>(
    restored?.baseline ?? bot,
  );
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = (Object.keys(defaults) as (keyof ProfileInput)[]).some(
    (key) => draft[key] !== baseline[key],
  );
  const changedProfile = (Object.keys(defaults) as (keyof ProfileInput)[]).some(
    (key) => bot[key] !== baseline[key],
  );
  const conflict = changedProfile && dirty;
  useEffect(() => {
    if (!changedProfile) setVersion(bot.updatedAt);
  }, [bot, changedProfile]);
  useEffect(() => {
    if (!dirty && !submitting.current) {
      setDraft(bot);
      setBaseline(bot);
      setVersion(bot.updatedAt);
    }
  }, [bot, dirty]);
  useEffect(() => {
    try {
      writeConfigDraft(
        draftKey,
        dirty ? { draft, baseline, version } : null,
      );
    } catch {
      setError(
        "Draft could not be saved on this device. Save your changes before leaving.",
      );
    }
  }, [draftKey, draft, baseline, version, dirty]);
  const set = <K extends keyof ProfileInput>(
    key: K,
    value: ProfileInput[K],
  ) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setSaved(false);
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting.current || pending || conflict) return;
    submitting.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await rpc.call("update", {
        ...draft,
        id: bot.id,
        expectedUpdatedAt: version ?? undefined,
      });
      setDraft(result);
      setBaseline(result);
      setSaved(true);
      setVersion(result.updatedAt);
      try {
        writeConfigDraft(draftKey, null);
      } catch {
        /* Saving succeeded even if local storage is unavailable. */
      }
      await onSaved(result);
    } catch (e) {
      setError(message(e));
    } finally {
      submitting.current = false;
      setPending(false);
    }
  };
  const schedules = [
    [0, "Only when messaged or woken manually"],
    [15, "Every 15 minutes"],
    [60, "Every hour"],
    [360, "Every 6 hours"],
    [1440, "Every day"],
  ] as const;
  return (
    <form
      onSubmit={submit}
      className="bot-config-form"
      aria-label="Bot profile"
    >
      <fieldset disabled={pending} className="min-w-0 space-y-5 border-0 p-0">
        <ConfigSection title="Identity">
          <ConfigRow label="Name" htmlFor={`${id}-name`}>
            <Input
              id={`${id}-name`}
              aria-label="Bot name"
              required
              maxLength={80}
              value={draft.name}
              onChange={(e) => set("name", e.target.value)}
            />
          </ConfigRow>
          <ConfigRow label="Avatar" htmlFor={`${id}-avatar`}>
            <Input
              id={`${id}-avatar`}
              aria-label="Avatar"
              className="w-20 text-center"
              maxLength={16}
              value={draft.avatar}
              onChange={(e) => set("avatar", e.target.value)}
            />
          </ConfigRow>
          <ConfigRow label="Role" htmlFor={`${id}-role`}>
            <Input
              id={`${id}-role`}
              aria-label="Bot role"
              maxLength={500}
              value={draft.description}
              onChange={(e) => set("description", e.target.value)}
              placeholder="What this bot is responsible for"
            />
          </ConfigRow>
        </ConfigSection>
        <ConfigSection title="Behavior">
          <ConfigRow label="Model">
            <ProviderModelPicker
              disabled={pending}
              className="h-9 max-w-full justify-start"
              allowProviderChange={false}
              value={{
                providerId: draft.providerId,
                model: draft.model,
                reasoningLevel: draft.reasoningLevel,
              }}
              onChange={(v) => {
                setDraft((d) => ({ ...d, ...v }));
                setSaved(false);
              }}
              routing={{ kind: "host", hostId: bot.hostId }}
            />
          </ConfigRow>
          <ConfigRow label="Permissions">
            <PermissionModePicker
              disabled={pending}
              className="h-9 max-w-full justify-start"
              align="start"
              providerId={draft.providerId}
              value={draft.permissionMode}
              onChange={(v) => set("permissionMode", v)}
              routing={{ kind: "host", hostId: bot.hostId }}
            />
          </ConfigRow>
          <ConfigRow
            label="Mission schedule"
            htmlFor={`${id}-schedule`}
            hint="Channel replies are always available. Scheduled work follows the mission's pause setting."
          >
            <Select
              disabled={pending}
              value={String(draft.intervalMinutes)}
              onValueChange={(value) => set("intervalMinutes", Number(value))}
            >
              <SelectTrigger
                id={`${id}-schedule`}
                aria-label="Mission schedule"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {schedules.map(([value, label]) => (
                  <SelectItem key={value} value={String(value)}>
                    {label}
                  </SelectItem>
                ))}
                {!schedules.some(
                  ([value]) => value === draft.intervalMinutes,
                ) && (
                  <SelectItem value={String(draft.intervalMinutes)}>
                    Every {draft.intervalMinutes} minutes
                  </SelectItem>
                )}
              </SelectContent>
            </Select>
          </ConfigRow>
        </ConfigSection>
      </fieldset>
      <ErrorMessage error={error} />
      {conflict && (
        <div role="alert" className="text-sm text-muted-foreground">
          This profile changed elsewhere. Your draft is saved on this device.{" "}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setDraft(bot);
              setBaseline(bot);
              setVersion(bot.updatedAt);
              setError(null);
            }}
          >
            Discard draft and load latest
          </Button>
        </div>
      )}
      <div className="flex min-h-8 flex-wrap items-center justify-end gap-2">
        <span role="status" className="mr-auto text-xs text-muted-foreground">
          {pending
            ? "Saving…"
            : dirty
              ? "Unsaved changes · draft saved"
              : saved
                ? "Saved"
                : ""}
        </span>
        <Button
          size="sm"
          disabled={pending || conflict || !draft.name.trim() || !dirty}
        >
          {pending ? "Saving…" : "Save profile"}
        </Button>
      </div>
      <details className="bot-config-workspace">
        <summary className="cursor-pointer text-sm text-muted-foreground">
          Workspace
        </summary>
        <p className="bot-path">{bot.home}</p>
        <p className="text-xs leading-5 text-muted-foreground">
          MISSION.md, MEMORY.md, and working files live here and persist
          across conversations and BB restarts.
        </p>
      </details>
    </form>
  );
}

export function DocumentEditor({
  bot,
  file,
}: {
  bot: Bot;
  file: "MISSION.md" | "MEMORY.md";
}) {
  const rpc = useRpc<typeof rpcContract>();
  const editorId = useId();
  const [revisions, setRevisions] = useState<Revision[] | null>(null);
  const historyBusy = useRef(false);
  const [historyMore, setHistoryMore] = useState(false),
    [historyPending, setHistoryPending] = useState(false);
  const loadHistory = async (before?: number) => {
    if (historyBusy.current) return;
    historyBusy.current = true;
    setHistoryPending(true);
    try {
      const page = await rpc.call("documentHistory", {
        id: bot.id,
        file,
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
  const draftKey = `bb:bots:document:${bot.id}:${file}`;
  const [restored] = useState(() => readConfigDraft(draftKey, documentDraft));
  const initialLoad = useRef(true);
  const [remoteConflict, setRemoteConflict] = useState(false);
  const [operation, setOperation] = useState("Loading…");
  const [doc, setDoc] = useState<{ text: string; version: string } | null>(
    null,
  );
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null),
    [pending, setPending] = useState(false),
    [saved, setSaved] = useState(false),
    [reloading, setReloading] = useState(false);
  const dirty = !!doc && text !== doc.text;
  const tooLong = text.length > 64000;
  const load = useCallback(() => {
    setPending(true);
    setOperation("Loading…");
    rpc
      .call("document", { id: bot.id, file })
      .then(
        (d) => {
          const draft = initialLoad.current ? restored : null;
          initialLoad.current = false;
          setRemoteConflict(!!draft && draft.doc.version !== d.version);
          setDoc(draft?.doc ?? d);
          setText(draft?.text ?? d.text);
          setError(
            draft && draft.doc.version !== d.version
              ? "This file changed while you were away. Your draft is preserved; copy your edits before reloading the latest file."
              : null,
          );
          setSaved(false);
        },
        (e) => setError(message(e)),
      )
      .finally(() => setPending(false));
  }, [rpc, bot.id, file]);
  useEffect(load, [load]);
  useEffect(() => {
    if (!doc) return;
    try {
      writeConfigDraft(draftKey, dirty ? { text, doc } : null);
    } catch {
      setError(
        "Draft could not be saved on this device. Save your changes before leaving.",
      );
    }
  }, [draftKey, text, doc, dirty]);
  const save = async () => {
    if (!doc || pending || !dirty || remoteConflict || tooLong) return;
    setPending(true);
    setOperation("Saving…");
    try {
      const d = await rpc.call("saveDocument", {
        id: bot.id,
        file,
        text,
        version: doc.version,
      });
      setDoc(d);
      setText(d.text);
      setError(null);
      setSaved(true);
    } catch (e) {
      if (message(e).includes("document changed")) setRemoteConflict(true);
      setError(message(e));
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="bot-document">
      <p className="text-sm leading-5 text-muted-foreground">
        {file === "MISSION.md"
          ? "The standing direction this bot reads at the start of every turn."
          : "Durable facts and decisions shared across this bot’s conversations. The bot can update this file."}
      </p>
      {doc ? (
        <MarkdownEditor
          id={editorId}
          label={file}
          value={text}
          disabled={pending}
          onSave={() => void save()}
          onChange={(value) => {
            setText(value);
            setSaved(false);
          }}
        />
      ) : (
        <p role="status">Loading {file}…</p>
      )}
      <ErrorMessage
        error={
          tooLong
            ? "This file exceeds 64,000 characters. Shorten it before saving; your draft is preserved."
            : error
        }
      />
      <div className="bot-document-actions">
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => {
            if (dirty) setReloading(true);
            else load();
          }}
        >
          <Icon name="RotateCcw" /> Reload file
        </Button>
        <span
          role="status"
          className="bot-document-status text-xs text-muted-foreground"
        >
          {pending
            ? operation
            : dirty
              ? "Unsaved changes · draft saved"
              : saved
                ? "Saved"
                : ""}
        </span>
        <Button
          size="sm"
          disabled={!doc || pending || !dirty || remoteConflict || tooLong}
          onClick={save}
        >
          Save {file === "MISSION.md" ? "mission" : "memory"}
        </Button>
      </div>
      <Button
        className="self-start"
        size="sm"
        variant="ghost"
        onClick={() => void loadHistory()}
      >
        Version history
      </Button>
      {revisions && (
        <RevisionList
          revisions={revisions}
          current={text}
          morePending={historyPending}
          onMore={
            historyMore
              ? () => void loadHistory(revisions.at(-1)!.id)
              : undefined
          }
          onUse={(value) => {
            if (pending) return;
            setText(value);
            setSaved(false);
          }}
        />
      )}
      <Modal
        title="Discard unsaved changes?"
        open={reloading}
        onOpenChange={setReloading}
      >
        <p className="text-sm leading-5">
          Reloading {file} replaces your unsaved edits with the latest file.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button
            autoFocus
            size="sm"
            variant="ghost"
            onClick={() => setReloading(false)}
          >
            Keep editing
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setReloading(false);
              load();
            }}
          >
            Discard and reload
          </Button>
        </div>
      </Modal>
    </div>
  );
}

export function BackButton({
  onClick,
  label = "All bots",
}: { onClick?: () => void; label?: string } = {}) {
  const navigate = useBbNavigate();
  return (
    <Button
      variant="ghost"
      size="icon"
      className={COARSE_POINTER_HEADER_ICON_BUTTON_CLASS}
      aria-label={label}
      onClick={onClick ?? (() => navigate.toPluginPanel("bots"))}
    >
      <Icon name="ChevronLeft" />
    </Button>
  );
}
export function TabBar({
  items,
  selected,
  onSelect,
  label,
}: {
  items: readonly string[];
  selected: string;
  onSelect: (tab: string) => void;
  label: string;
}) {
  return (
    <nav className="bot-tabs" aria-label={label}>
      {items.map((tab) => (
        <Button
          variant="ghost"
          size="sm"
          key={tab}
          aria-current={selected === tab ? "page" : undefined}
          onClick={() => onSelect(tab)}
        >
          {tab[0].toUpperCase() + tab.slice(1)}
        </Button>
      ))}
    </nav>
  );
}
export function WorkList({
  jobs,
  bots,
  onCancel,
  onJump,
}: {
  onJump?: (id: string) => void;
  jobs: Job[];
  bots: Bot[];
  onCancel: (id: string) => void;
}) {
  const navigate = useBbNavigate();
  return (
    <div className="bot-work-list">
      {!jobs.length ? (
        <p className="bot-help">No activity yet.</p>
      ) : (
        jobs.map((j) => (
          <article key={j.id}>
            <span
              className={`bot-presence-dot state-${j.status}`}
              aria-hidden
            />
            <div>
              <strong>
                {bots.find((b) => b.id === j.botId)?.name ?? "Bot"}
              </strong>
              <span className="bot-help">
                {j.status === "running"
                  ? j.startedAt
                    ? "Working"
                    : "Waiting to start"
                  : j.status === "done"
                    ? "Finished"
                    : j.status === "queued"
                      ? "Waiting"
                      : j.status}
              </span>
              {j.taskTitle && (
                <button
                  className="bot-message-reference"
                  disabled={!onJump || !j.triggerMessageId}
                  onClick={() =>
                    j.triggerMessageId && onJump?.(j.triggerMessageId)
                  }
                >
                  {j.taskTitle}
                </button>
              )}
              <span className="text-xs text-muted-foreground">
                {isForkConversation(j.conversationKey) ? "Fork" : "Primary"}
                {j.queuePosition ? ` · Queue ${j.queuePosition}` : ""}
              </span>
              {j.queueReason && (
                <p className="text-xs text-muted-foreground">{j.queueReason}</p>
              )}
              {j.error && <ErrorMessage error={j.error} />}
              <time>
                {new Intl.DateTimeFormat(undefined, {
                  dateStyle: "short",
                  timeStyle: "short",
                }).format(j.createdAt)}
              </time>
            </div>
            {j.threadId && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => navigate.toThread(j.threadId!)}
              >
                View work
              </Button>
            )}
            {["queued", "running", "dispatching"].includes(j.status) && (
              <Button variant="ghost" size="sm" onClick={() => onCancel(j.id)}>
                Stop
              </Button>
            )}
          </article>
        ))
      )}
    </div>
  );
}
