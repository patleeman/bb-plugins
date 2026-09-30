// One task: its properties and description, what it links to, and the
// agent it was handed to, with the thread's state spelled out.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  Badge,
  DANGER_BUTTON,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  EditableTitle,
  FLOATING,
  FLOATING_BUTTON,
  GHOST_BUTTON,
  ICON_BUTTON,
  Icon,
  ItemHeader,
  OUTLINE_BUTTON,
  PageColumn,
  cn,
  openAppPath,
  projectName,
  useProjects,
} from "@bb-studio/kit/app";
import { mentionPrompt } from "@bb-studio/kit/contract";
import { errorMessage, plural, relativeTime } from "@bb-studio/kit/format";
import { Markdown, useBbNavigate, useRealtime } from "@get-bb/plugin-sdk/app";
import {
  HANDOFF_LABELS,
  HANDOFF_TONES,
  REALTIME_CHANNEL,
  COLUMNS_UPDATE_TYPE,
  type TaskColumn,
  TASK_UPDATE_TYPE,
  isOpenHandoff,
  taskHref,
  type Assignee,
  type TaskStatus,
} from "../src/shared";
import { HandoffPanel } from "./handoff-panel";
import { ASSIGNEE_OPTIONS, DueChip, STATUS_ICONS } from "./pieces";
import { SPIN, useTasksRpc, type Handoff, type Link, type Linkable, type Task, type TaskEvent } from "./types";

type Loaded = { task: Task; links: Link[]; handoffs: Handoff[]; columns: TaskColumn[] };

export function TaskView({ taskId, onBack }: { taskId: string; onBack: (replace?: boolean) => void }) {
  const rpc = useTasksRpc();
  const navigate = useBbNavigate();
  const projects = useProjects();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [handingOff, setHandingOff] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;

  const load = useCallback(
    () =>
      rpc.call("get", { id: taskId }).then(
        (result) => {
          if (!result.task) {
            toast.info("This task was deleted.");
            onBackRef.current(true);
            return;
          }
          setLoaded({ task: result.task, links: result.links, handoffs: result.handoffs, columns: result.columns });
          setError(null);
        },
        (failure) => setError(errorMessage(failure)),
      ),
    [rpc, taskId],
  );
  useEffect(() => {
    void load();
  }, [load]);
  useRealtime(REALTIME_CHANNEL, (payload) => {
    const event = payload as TaskEvent;
    if (event?.type === COLUMNS_UPDATE_TYPE || (event?.type === TASK_UPDATE_TYPE && event.taskId === taskId)) void load();
  });

  if (!loaded) {
    return (
      <div className="studio-root relative flex h-full min-h-0 flex-col bg-background text-foreground">
        <ItemHeader backLabel="Tasks" onBack={() => onBack()} />
        <div role="status" className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
          {error ?? (
            <>
              <Icon name="Loading" className={cn("size-4", SPIN)} /> Loading task…
            </>
          )}
        </div>
      </div>
    );
  }

  const { task, links, handoffs, columns } = loaded;
  const latest = handoffs[0] ?? null;
  const openThreads = handoffs.filter((handoff) => isOpenHandoff(handoff.state)).length;

  /** Runs an update and reloads; errors become a toast. */
  async function run<T>(work: Promise<T>, failed: string): Promise<T | undefined> {
    try {
      return await work;
    } catch (failure) {
      toast.error(`${failed}: ${errorMessage(failure)}`);
      return undefined;
    } finally {
      void load();
    }
  }

  const update = (patch: { title?: string; description?: string; projectId?: string | null; due?: string | null; assignee?: Assignee }) =>
    run(rpc.call("update", { id: taskId, ...patch }), "Couldn't save the task");

  async function move(status: TaskStatus, archive = false) {
    const result = await run(rpc.call("move", { id: taskId, status }), "Couldn't move the task");
    if (!result) return;
    let archived = result.archivedThreads;
    if (archive && openThreads && !archived) archived = (await run(rpc.call("archiveThreads", { id: taskId }), "Couldn't archive threads"))?.archived ?? 0;
    if (status === "done") toast.success(archived ? `Done. Archived ${plural(archived, "thread")}.` : "Marked done");
  }

  async function archiveThreads() {
    const result = await run(rpc.call("archiveThreads", { id: taskId }), "Couldn't archive threads");
    if (result) toast.success(`Archived ${plural(result.archived, "thread")}${result.failed ? `; ${result.failed} failed` : ""}`);
  }

  async function remove() {
    try {
      await rpc.call("delete", { id: taskId });
      toast.success("Task deleted");
      onBack(true);
    } catch (failure) {
      toast.error(errorMessage(failure));
    }
  }

  function newThread() {
    navigate.toCompose({ initialPrompt: mentionPrompt([{ title: task.title || "Untitled", href: taskHref(taskId) }]), focusPrompt: true });
  }

  const done = task.status === "done";
  const trailing = confirmDelete ? (
    <div className={cn(FLOATING, "flex items-center gap-1.5 rounded-md py-1 pr-1 pl-3 text-sm")}>
      <span className="max-sm:hidden">Delete this task?</span>
      <button type="button" className={DANGER_BUTTON} onClick={() => void remove()}>
        Delete
      </button>
      <button type="button" className={GHOST_BUTTON} onClick={() => setConfirmDelete(false)}>
        Cancel
      </button>
    </div>
  ) : (
    <>
      {!done ? (
        <button type="button" className={cn(FLOATING_BUTTON, "max-sm:hidden")} onClick={() => setHandingOff(true)}>
          <Icon name="Bot" /> {latest ? "Hand off again" : "Hand off"}
        </button>
      ) : null}
      <button type="button" className={FLOATING_BUTTON} onClick={() => void move(done ? "todo" : "done")}>
        <Icon name={done ? "RotateCcw" : "CircleCheck"} /> {done ? "Reopen" : "Mark done"}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label="More" className={ICON_BUTTON}>
            <Icon name="MoreHorizontal" className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          {!done && openThreads ? (
            <DropdownMenuItem onSelect={() => void move("done", true)}>
              <Icon name="CircleCheck" className="size-4" /> Mark done and archive threads
            </DropdownMenuItem>
          ) : null}
          {!done ? (
            <DropdownMenuItem className="sm:hidden" onSelect={() => setHandingOff(true)}>
              <Icon name="Bot" className="size-4" /> Hand off
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onSelect={newThread}>
            <Icon name="MessageSquarePlus" className="size-4" /> New thread about this
          </DropdownMenuItem>
          {openThreads ? (
            <DropdownMenuItem onSelect={() => void archiveThreads()}>
              <Icon name="Archive" className="size-4" /> Archive {openThreads === 1 ? "thread" : `${openThreads} threads`}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Icon name="MoveTo" className="size-4" /> Move to project
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-80 w-56 overflow-y-auto">
              <DropdownMenuLabel className="text-xs text-muted-foreground">Now in {projectName(projects, task.projectId)}</DropdownMenuLabel>
              {[{ id: null, name: "Global" }, ...projects].map((project) => (
                <DropdownMenuItem key={project.id ?? "global"} disabled={project.id === task.projectId} onSelect={() => void update({ projectId: project.id })}>
                  <Icon name={project.id ? "Folder" : "Globe"} className="size-4" /> {project.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem onSelect={() => void run(rpc.call("archive", { id: taskId, archived: !task.archived }), "Couldn't archive the task")}>
            <Icon name={task.archived ? "ArchiveRestore" : "Archive"} className="size-4" /> {task.archived ? "Unarchive task" : "Archive task"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => setConfirmDelete(true)}>
            <Icon name="Trash2" className="size-4" /> Delete…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );

  return (
    <div className="relative h-full min-h-0">
      <ItemHeader backLabel="Tasks" onBack={() => onBack()} trailing={trailing} />
      <PageColumn className="max-w-3xl">
        {task.archived ? (
          <div className="mb-4 flex items-center gap-2 rounded-md bg-muted/60 px-3 py-2 text-sm text-muted-foreground">
            <Icon name="Archive" className="size-4" /> This task is archived.
          </div>
        ) : null}
        <EditableTitle title={task.title} placeholder="Untitled task" onRename={(title) => void update({ title })} />

        <dl className="mt-6 grid grid-cols-[7rem_1fr] items-center gap-x-4 gap-y-2 text-sm max-sm:grid-cols-[5.5rem_1fr]">
          <Property label="Status">
            <Select
              label="Status"
              value={task.status}
              options={columns.map(({ id, label }) => ({ value: id, label, icon: STATUS_ICONS[id] ?? "Circle" }))}
              onChange={(status) => void move(status as TaskStatus)}
            />
          </Property>
          <Property label="Assignee">
            <Select
              label="Assignee"
              value={task.assignee ?? ""}
              options={ASSIGNEE_OPTIONS.map((option) => ({ value: option.value ?? "", label: option.label, icon: option.icon }))}
              onChange={(value) => void update({ assignee: (value || null) as Assignee })}
            />
          </Property>
          <Property label="Due">
            <div className="flex items-center gap-2">
              <input
                type="date"
                aria-label="Due date"
                value={task.due ?? ""}
                className="h-8 rounded-md border border-transparent bg-transparent px-2 text-sm hover:border-border focus:border-border"
                onChange={(event) => void update({ due: event.currentTarget.value || null })}
              />
              <DueChip due={task.due} status={task.status} />
            </div>
          </Property>
          <Property label="Project">
            <Select
              label="Project"
              value={task.projectId ?? ""}
              options={[{ value: "", label: "Global", icon: "Globe" }, ...projects.map((project) => ({ value: project.id, label: project.name, icon: "Folder" }))]}
              onChange={(value) => void update({ projectId: value || null })}
            />
          </Property>
        </dl>

        <Section title="Agent">
          {handingOff ? <HandoffPanel task={task} projects={projects} onClose={() => setHandingOff(false)} /> : null}
          {latest ? (
            <LatestHandoff handoff={latest} task={task} onSendBack={(message) => run(rpc.call("sendBack", { id: taskId, message }), "Couldn't send it")} />
          ) : !handingOff ? (
            <div className="flex items-center gap-3 rounded-lg border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">
              <span className="flex-1">No agent yet.</span>
              {!done ? (
                <button type="button" className={OUTLINE_BUTTON} onClick={() => setHandingOff(true)}>
                  <Icon name="Bot" /> Hand off
                </button>
              ) : null}
            </div>
          ) : null}
          {handoffs.length > 1 ? (
            <details className="mt-2 text-sm">
              <summary className="cursor-pointer text-muted-foreground">Earlier handoffs ({handoffs.length - 1})</summary>
              <ul className="mt-2 flex flex-col gap-1">
                {handoffs.slice(1).map((handoff) => (
                  <li key={handoff.threadId}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-state-hover"
                      onClick={() => navigate.toThread(handoff.threadId)}
                    >
                      <Icon name="MessageSquare" className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{handoff.agent ?? "Agent"}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {HANDOFF_LABELS[handoff.state]} · {relativeTime(handoff.createdAt)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </Section>

        <Section title="Description">
          <Description text={task.description} onSave={(description) => update({ description })} />
        </Section>

        <Section title="Links">
          <Links
            task={task}
            links={links}
            onOpen={(link) => (link.target === "thread" ? navigate.toThread(link.itemId) : link.href ? openAppPath(link.href) : undefined)}
            onAdd={(link) => void run(rpc.call("link", { id: taskId, link }), "Couldn't add the link")}
            onRemove={(link) => void run(rpc.call("unlink", { id: taskId, target: link.target, itemId: link.itemId }), "Couldn't remove the link")}
          />
        </Section>

        <p className="mt-10 text-xs text-muted-foreground">
          Created {relativeTime(task.createdAt)} · Updated {relativeTime(task.updatedAt)}
          {task.updatedBy === "agent" ? " by an agent" : ""}
        </p>
      </PageColumn>
    </div>
  );
}

function Property({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</h2>
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  );
}

function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string; icon: string }[];
  onChange(value: string): void;
}) {
  const current = options.find((option) => option.value === value) ?? options[0]!;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`${label}: ${current.label}`}
          className="flex h-8 max-w-full items-center gap-2 rounded-md px-2 text-sm hover:bg-state-hover data-[state=open]:bg-state-active"
        >
          <Icon name={current.icon} className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{current.label}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 w-56 overflow-y-auto">
        {options.map((option) => (
          <DropdownMenuItem key={option.value} onSelect={() => option.value !== value && onChange(option.value)}>
            <Icon name={option.icon} className="size-4" /> <span className="truncate">{option.label}</span>
            {option.value === value ? <Icon name="Check" className="ml-auto size-4" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function LatestHandoff({ handoff, task, onSendBack }: { handoff: Handoff; task: Task; onSendBack(message: string): Promise<unknown> }) {
  const navigate = useBbNavigate();
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const open = isOpenHandoff(handoff.state);
  // Worth answering once the agent stopped: it replied, is ready, or asked.
  const canReply = open && task.status !== "done" && handoff.state !== "starting";

  async function send() {
    const message = reply.trim();
    if (!message) return;
    setSending(true);
    const sent = await onSendBack(message);
    setSending(false);
    if (sent) {
      setReply("");
      toast.success("Sent to the agent");
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge label={HANDOFF_LABELS[handoff.state]} tone={HANDOFF_TONES[handoff.state]} />
        <span className="text-xs text-muted-foreground">
          {handoff.agent ?? "Agent"} · handed off {relativeTime(handoff.createdAt)}
        </span>
        <button type="button" className={cn(GHOST_BUTTON, "ml-auto h-7 px-2")} onClick={() => navigate.toThread(handoff.threadId)}>
          <Icon name="ArrowUpRight" /> Open thread
        </button>
      </div>
      {handoff.note ? <p className="text-sm">{handoff.note}</p> : null}
      {canReply ? (
        <div className="flex items-end gap-2">
          <textarea
            aria-label="Send back to the agent"
            placeholder={handoff.state === "needs-input" ? "Answer in the thread, or reply here" : "Send feedback back to the agent"}
            rows={1}
            value={reply}
            className="min-h-8 flex-1 resize-y rounded-md border border-border bg-background px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
            onChange={(event) => setReply(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void send();
            }}
          />
          <button type="button" className={OUTLINE_BUTTON} disabled={sending || !reply.trim()} onClick={() => void send()}>
            <Icon name={sending ? "Loading" : "Sent"} className={cn(sending && SPIN)} /> Send back
          </button>
        </div>
      ) : null}
    </div>
  );
}

function Description({ text, onSave }: { text: string; onSave(text: string): Promise<unknown> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);

  if (editing) {
    return (
      <div className="flex flex-col gap-2">
        <textarea
          autoFocus
          aria-label="Description"
          value={draft}
          rows={Math.min(20, Math.max(5, draft.split("\n").length + 1))}
          maxLength={20_000}
          className="w-full resize-y rounded-md border border-border bg-background px-3 py-2 font-mono text-sm outline-none focus:ring-1 focus:ring-ring"
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setEditing(false);
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              void onSave(draft);
              setEditing(false);
            }
          }}
        />
        <div className="flex justify-end gap-2">
          <button type="button" className={GHOST_BUTTON} onClick={() => setEditing(false)}>
            Cancel
          </button>
          <button
            type="button"
            className={OUTLINE_BUTTON}
            onClick={() => {
              void onSave(draft);
              setEditing(false);
            }}
          >
            Save
          </button>
        </div>
      </div>
    );
  }
  if (!text) {
    return (
      <button
        type="button"
        className="rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-state-hover"
        onClick={() => {
          setDraft("");
          setEditing(true);
        }}
      >
        Add a description…
      </button>
    );
  }
  return (
    <div className="group relative rounded-md">
      <Markdown content={text} className="text-sm" />
      <button
        type="button"
        aria-label="Edit description"
        className={cn(ICON_BUTTON, "absolute top-0 right-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100")}
        onClick={() => {
          setDraft(text);
          setEditing(true);
        }}
      >
        <Icon name="Edit" className="size-4" />
      </button>
    </div>
  );
}

function Links({
  task,
  links,
  onOpen,
  onAdd,
  onRemove,
}: {
  task: Task;
  links: Link[];
  onOpen(link: Link): void;
  onAdd(link: Link): void;
  onRemove(link: Link): void;
}) {
  const [picking, setPicking] = useState(false);
  return (
    <>
      {links.length ? (
        <ul className="flex flex-col">
          {links.map((link) => (
            <li key={`${link.target}:${link.itemId}`} className="group flex items-center gap-1 rounded-md hover:bg-state-hover">
              <button type="button" className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm" onClick={() => onOpen(link)}>
                <Icon name={link.target === "thread" ? "MessageSquare" : "File"} className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{link.label}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{link.target === "thread" ? "Thread" : (link.pluginId ?? "")}</span>
              </button>
              <button
                type="button"
                aria-label={`Remove ${link.label}`}
                className="mr-1 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100"
                onClick={() => onRemove(link)}
              >
                <Icon name="X" className="size-4" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {picking ? (
        <LinkPicker
          projectId={task.projectId}
          linked={links}
          onPick={(link) => {
            onAdd(link);
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      ) : (
        <button type="button" className={cn(GHOST_BUTTON, "self-start px-2")} onClick={() => setPicking(true)}>
          <Icon name="Plus" /> Link a page, artifact, drawing or thread
        </button>
      )}
    </>
  );
}

function LinkPicker({
  projectId,
  linked,
  onPick,
  onClose,
}: {
  projectId: string | null;
  linked: Link[];
  onPick(link: Link): void;
  onClose(): void;
}) {
  const rpc = useTasksRpc();
  const [items, setItems] = useState<Linkable[] | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let live = true;
    rpc.call("linkables", { projectId }).then(
      (result) => live && setItems(result.items),
      (failure) => {
        if (!live) return;
        toast.error(errorMessage(failure));
        setItems([]);
      },
    );
    return () => {
      live = false;
    };
  }, [rpc, projectId]);

  const taken = useMemo(() => new Set(linked.map((link) => `${link.target}:${link.itemId}`)), [linked]);
  const needle = query.trim().toLowerCase();
  const shown = (items ?? [])
    .filter((item) => !taken.has(`${item.target}:${item.itemId}`))
    .filter((item) => !needle || item.label.toLowerCase().includes(needle) || item.kind.toLowerCase().includes(needle))
    .slice(0, 50);

  return (
    <div className="flex flex-col rounded-lg border border-border">
      <div className="flex items-center gap-2 border-b border-border px-3">
        <Icon name="Search" className="size-4 text-muted-foreground" />
        <input
          autoFocus
          aria-label="Find something to link"
          placeholder="Find a page, artifact, drawing or thread…"
          value={query}
          className="h-9 flex-1 bg-transparent text-sm outline-none"
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") onClose();
            if (event.key === "Enter" && shown[0]) onPick(toLink(shown[0]));
          }}
        />
        <button type="button" aria-label="Close" className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover" onClick={onClose}>
          <Icon name="X" className="size-4" />
        </button>
      </div>
      <ul className="max-h-72 overflow-y-auto p-1">
        {!items ? (
          <li className="flex items-center gap-2 px-2 py-2 text-sm text-muted-foreground">
            <Icon name="Loading" className={cn("size-4", SPIN)} /> Loading…
          </li>
        ) : !shown.length ? (
          <li className="px-2 py-2 text-sm text-muted-foreground">Nothing to link{needle ? ` matches "${query.trim()}"` : ""}.</li>
        ) : (
          shown.map((item) => (
            <li key={`${item.target}:${item.pluginId}:${item.itemId}`}>
              <button type="button" className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-state-hover" onClick={() => onPick(toLink(item))}>
                <ItemIcon icon={item.icon} fallback={item.target === "thread" ? "MessageSquare" : "File"} />
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{item.kind}</span>
              </button>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}

/** Studio icons are an emoji, a host icon name, or a plugin's own icon. */
function ItemIcon({ icon, fallback }: { icon: string | null; fallback: string }) {
  if (icon && !/^[A-Za-z0-9/_-]+$/.test(icon)) return <span className="flex size-4 shrink-0 items-center justify-center text-sm leading-none">{icon}</span>;
  return <Icon name={icon ?? fallback} className="size-4 shrink-0 text-muted-foreground" />;
}

function toLink({ kind: _kind, icon: _icon, ...link }: Linkable): Link {
  return link;
}
