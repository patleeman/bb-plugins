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
import { openWorkThread } from "./channel-threads";
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
export function FormRow({
  label,
  htmlFor,
  hint,
  children,
  className = "",
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`bot-form-row ${className}`}>
      {htmlFor ? (
        <label htmlFor={htmlFor}>{label}</label>
      ) : (
        <div className="bot-form-row-label">{label}</div>
      )}
      <div className="bot-form-row-control">
        {children}
        {hint && <p className="bot-form-row-hint">{hint}</p>}
      </div>
    </div>
  );
}

export function Section({
  title,
  children,
  className = "",
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`bot-ui-section ${className}`}>
      <h2 className="bot-ui-section-title">{title}</h2>
      <div className="bot-ui-section-content">{children}</div>
    </section>
  );
}

export function EmptyState({
  title,
  description,
  action,
  role,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  role?: "status";
}) {
  return (
    <div className="bot-empty-state" role={role}>
      <p>{title}</p>
      {description && <p className="bot-empty-state-description">{description}</p>}
      {action}
    </div>
  );
}

export type StatusKind = "ready" | "working" | "paused" | "error";
export function StatusBadge({
  status,
  label,
}: {
  status: StatusKind;
  label?: string;
}) {
  const labels: Record<StatusKind, string> = {
    ready: "Ready",
    working: "Working",
    paused: "Paused",
    error: "Error",
  };
  return (
    <span className="bot-status-badge" data-status={status}>
      <span className="bot-status-badge-dot" aria-hidden="true" />
      {label ?? labels[status]}
    </span>
  );
}

export function ActionBar({
  status,
  secondary,
  primary,
  className = "",
}: {
  status?: ReactNode;
  secondary?: ReactNode;
  primary?: ReactNode;
  className?: string;
}) {
  if (!status && !secondary && !primary) return null;
  return (
    <div className={`bot-action-bar ${className}`}>
      <div className="bot-action-bar-start">
        {status && (
          <span className="bot-action-bar-status" role="status">
            {status}
          </span>
        )}
        {secondary && <div className="bot-action-bar-secondary">{secondary}</div>}
      </div>
      {primary && <div className="bot-action-bar-primary">{primary}</div>}
    </div>
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
  onRetire,
}: {
  bot: Bot;
  onSaved: (bot: Bot) => void | Promise<void>;
  onRetire?: () => void;
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
        <Section title="Identity">
          <FormRow label="Name" htmlFor={`${id}-name`}>
            <Input
              id={`${id}-name`}
              aria-label="Bot name"
              required
              maxLength={80}
              value={draft.name}
              className="max-w-[360px]"
              onChange={(e) => set("name", e.target.value)}
            />
          </FormRow>
          <FormRow label="Avatar" htmlFor={`${id}-avatar`}>
            <Input
              id={`${id}-avatar`}
              aria-label="Avatar"
              className="w-20 text-center"
              maxLength={16}
              value={draft.avatar}
              onChange={(e) => set("avatar", e.target.value)}
            />
          </FormRow>
          <FormRow label="Role" htmlFor={`${id}-role`}>
            <Input
              id={`${id}-role`}
              aria-label="Bot role"
              maxLength={500}
              value={draft.description}
              onChange={(e) => set("description", e.target.value)}
              placeholder="What this bot is responsible for"
            />
          </FormRow>
        </Section>
        <Section title="Behavior">
          <FormRow label="Model">
            <ProviderModelPicker
              disabled={pending}
              className="profile-picker-control max-w-[360px]"
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
          </FormRow>
          <FormRow label="Permissions">
            <PermissionModePicker
              disabled={pending}
              className="profile-picker-control max-w-[360px]"
              align="start"
              providerId={draft.providerId}
              value={draft.permissionMode}
              onChange={(v) => set("permissionMode", v)}
              routing={{ kind: "host", hostId: bot.hostId }}
            />
          </FormRow>
          <FormRow
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
                className="profile-picker-control max-w-[360px]"
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
          </FormRow>
        </Section>
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
      <ActionBar
        status={
          pending
            ? "Saving…"
            : dirty
              ? "Unsaved changes · draft saved"
              : saved
                ? "Saved"
                : ""
        }
        primary={dirty || pending ? (
          <Button
            size="sm"
            disabled={pending || conflict || !draft.name.trim() || !dirty}
          >
            {pending ? "Saving…" : "Save profile"}
          </Button>
        ) : undefined}
      />
      {bot && (
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
      )}
      {bot && onRetire && (
        <Section title="Danger zone" className="bot-danger-zone">
          <div className="bot-danger-zone-content">
            <p>
              {bot.retired
                ? "This bot is retired. Restore it to make it available again."
                : "Retiring stops this bot and removes it from every channel. Its workspace and history are preserved."}
            </p>
            <Button
              type="button"
              size="sm"
              variant={bot.retired ? "outline" : "destructive"}
              className={bot.retired ? undefined : "bot-retire-button"}
              disabled={pending}
              onClick={onRetire}
            >
              {bot.retired ? "Restore bot" : "Retire bot"}
            </Button>
          </div>
        </Section>
      )}
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
      <ActionBar
        status={
          pending
            ? operation
            : dirty
              ? "Unsaved changes · draft saved"
              : saved
                ? "Saved"
                : ""
        }
        secondary={
          <>
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => {
                if (dirty) setReloading(true);
                else load();
              }}
            >
              <Icon name="RotateCcw" /> Reload
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={historyPending}
              onClick={() => void loadHistory()}
            >
              Version history
            </Button>
          </>
        }
        primary={dirty || pending ? (
          <Button
            size="sm"
            disabled={!doc || pending || !dirty || remoteConflict || tooLong}
            onClick={save}
          >
            {pending ? "Saving…" : `Save ${file === "MISSION.md" ? "mission" : "memory"}`}
          </Button>
        ) : undefined}
      />
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
const activityTime = (at: number) =>
  new Intl.DateTimeFormat(
    undefined,
    new Date(at).toDateString() === new Date().toDateString()
      ? { timeStyle: "short" }
      : { dateStyle: "short", timeStyle: "short" },
  ).format(at);
/** Read-only log of bot calls. Each row opens the bot's work thread. */
export function WorkList({ jobs, bots }: { jobs: Job[]; bots: Bot[] }) {
  const navigate = useBbNavigate();
  if (!jobs.length) return <EmptyState title="No activity yet" />;
  return (
    <ol className="activity-list">
      {jobs.map((job) => {
        const bot = bots.find((candidate) => candidate.id === job.botId);
        const status: { kind: StatusKind; label: string } =
          job.status === "error"
            ? { kind: "error", label: "Failed" }
            : job.status === "done"
              ? { kind: "ready", label: "Finished" }
              : job.status === "cancelled"
                ? { kind: "paused", label: "Stopped" }
                : { kind: "working", label: job.status === "queued" ? "Queued" : job.startedAt ? "Working" : "Starting" };
        const title = job.taskTitle || job.text || "Untitled request";
        return (
          <li key={job.id}>
            <button
              type="button"
              className="activity-row"
              disabled={!job.threadId}
              title={job.threadId ? "Open work thread" : undefined}
              aria-label={`${bot?.name ?? "Bot"}, ${status.label}: ${title}`}
              onClick={() => job.threadId && openWorkThread(navigate, job.threadId, job.roomId)}
            >
              <span className="activity-dot" data-status={status.kind} aria-hidden="true" />
              <span className="activity-bot">{bot?.name ?? "Bot"}</span>
              <span className="activity-title">
                {isForkConversation(job.conversationKey) && <span className="activity-tag">Fork</span>}
                {title}
              </span>
              <time dateTime={new Date(job.updatedAt || job.createdAt).toISOString()}>
                {activityTime(job.updatedAt || job.createdAt)}
              </time>
              {job.error && <span className="activity-error">{job.error}</span>}
            </button>
          </li>
        );
      })}
    </ol>
  );
}
