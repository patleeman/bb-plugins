// The board: customizable columns you drag tasks between, filtered by project and
// assignee. Each card shows who acts next when an agent has the task.
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  GHOST_BUTTON,
  Icon,
  OUTLINE_BUTTON,
  cn,
  projectName,
  useProjects,
  type Project,
} from "@bb-studio/kit/app";
import { errorMessage, plural } from "@bb-studio/kit/format";
import { useBbContext } from "@get-bb/plugin-sdk/app";
import { DEFAULT_COLUMNS, type TaskColumn, type TaskStatus } from "../src/shared";
import { AssigneeChip, DueChip, HandoffBadge, STATUS_ICONS } from "./pieces";
import { ColumnsEditor } from "./columns-editor";
import { SPIN, useTasksRpc, type Task } from "./types";

/** Done keeps growing; show the newest this many at a time. */
const DONE_PAGE = 20;

export type ProjectFilter = "all" | "global" | string;
export type AssigneeFilter = "everyone" | "me" | "agent";

export function useStored<T extends string>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      return (localStorage.getItem(key) as T | null) ?? initial;
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (next: T) => {
      setValue(next);
      try {
        localStorage.setItem(key, next);
      } catch {
        // private mode: the filter just isn't remembered
      }
    },
    [key],
  );
  return [value, set];
}

function matches(task: Task, project: ProjectFilter, assignee: AssigneeFilter): boolean {
  if (project === "global" && task.projectId !== null) return false;
  if (project !== "all" && project !== "global" && task.projectId !== project) return false;
  if (assignee !== "everyone" && task.assignee !== assignee) return false;
  return true;
}

/** Tasks in board order; Done shows the most recently finished first. */
function column(tasks: readonly Task[], status: TaskStatus): Task[] {
  return tasks.filter((task) => task.status === status);
}

export function Board({
  refreshKey,
  viewToggle,
  onOpen,
}: {
  refreshKey: unknown;
  viewToggle: ReactNode;
  onOpen(id: string): void;
}) {
  const rpc = useTasksRpc();
  const context = useBbContext();
  const projects = useProjects();
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [columns, setColumns] = useState<TaskColumn[]>(DEFAULT_COLUMNS);
  const [revision, setRevision] = useState(0);
  const [editingColumns, setEditingColumns] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [project, setProject] = useStored<ProjectFilter>("tasks:project", "all");
  const [assignee, setAssignee] = useStored<AssigneeFilter>("tasks:assignee", "everyone");
  const [adding, setAdding] = useState<TaskStatus | null>(null);
  const [doneShown, setDoneShown] = useState(DONE_PAGE);
  const latest = useRef(0);

  const refetch = useCallback(() => {
    const request = ++latest.current;
    rpc.call("board", {}).then(
      (result) => {
        if (request !== latest.current) return;
        setTasks(result.tasks);
        setColumns(result.columns);
        setRevision(result.revision);
        setError(null);
      },
      (failure) => request === latest.current && setError(errorMessage(failure)),
    );
  }, [rpc]);
  useEffect(refetch, [refetch, refreshKey]);

  // A project filter for a project that's gone shows everything again.
  const projectFilter: ProjectFilter =
    project === "all" || project === "global" || !projects.length || projects.some((each) => each.id === project) ? project : "all";
  const visible = useMemo(() => (tasks ?? []).filter((task) => matches(task, projectFilter, assignee)), [tasks, projectFilter, assignee]);

  /** Where new tasks go: the filtered project, else the one BB has open. */
  const newProjectId = projectFilter === "global" ? null : projectFilter !== "all" ? projectFilter : (context.projectId ?? null);

  async function create(status: TaskStatus, title: string) {
    try {
      await rpc.call("create", { title, status, projectId: newProjectId, assignee: assignee === "me" ? "me" : null });
      refetch();
    } catch (failure) {
      toast.error(`Couldn't add the task: ${errorMessage(failure)}`);
    }
  }

  async function move(task: Task, status: TaskStatus, visibleIndex?: number) {
    if (!tasks) return;
    // The drop position among the visible cards, as a position in the whole column.
    const whole = column(tasks, status).filter((each) => each.id !== task.id);
    const shown = column(visible, status).filter((each) => each.id !== task.id);
    let index: number | undefined;
    if (visibleIndex !== undefined) {
      const before = shown[visibleIndex];
      const after = shown[shown.length - 1];
      index = before ? whole.indexOf(before) : after ? whole.indexOf(after) + 1 : 0;
    }
    // Show the move straight away; the refetch settles it.
    const others = tasks.filter((each) => each.id !== task.id);
    const next = whole[index ?? 0];
    const last = whole[whole.length - 1];
    const at = next ? others.indexOf(next) : last ? others.indexOf(last) + 1 : others.length;
    setTasks([...others.slice(0, at), { ...task, status }, ...others.slice(at)]);
    try {
      const result = await rpc.call("move", { id: task.id, status, ...(index !== undefined ? { index } : {}) });
      if (status === "done" && task.status !== "done") doneToast(task, result.archivedThreads);
    } catch (failure) {
      toast.error(`Couldn't move the task: ${errorMessage(failure)}`);
    } finally {
      refetch();
    }
  }

  function doneToast(task: Task, archived: number) {
    if (archived) {
      toast.success(`Done. Archived ${plural(archived, "thread")}.`);
      return;
    }
    if (!task.openThreads) return;
    toast.success(`Done: ${task.title || "Untitled"}`, {
      action: {
        label: task.openThreads === 1 ? "Archive thread" : "Archive threads",
        onClick: () =>
          void rpc.call("archiveThreads", { id: task.id }).then(
            (result) => toast.success(`Archived ${plural(result.archived, "thread")}`),
            (failure) => toast.error(errorMessage(failure)),
          ),
      },
    });
  }

  return (
    <div className="studio-root flex h-full min-h-0 flex-col bg-background text-foreground">
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-6 pt-10 pb-4 max-md:px-3 max-md:pt-4">
        <h1 className="mr-auto text-2xl font-semibold tracking-tight">Tasks</h1>
        <ProjectPicker projects={projects} value={projectFilter} onChange={setProject} />
        <AssigneePicker value={assignee} onChange={setAssignee} />
        {viewToggle}
        <button type="button" className={GHOST_BUTTON} disabled={!tasks} onClick={() => setEditingColumns((open) => !open)}>
          <Icon name="GridView" /> Columns
        </button>
        <button type="button" className={OUTLINE_BUTTON} onClick={() => setAdding("todo")}>
          <Icon name="Plus" /> New task
        </button>
      </div>
      {editingColumns ? <ColumnsEditor columns={columns} revision={revision} onClose={() => setEditingColumns(false)} onSaved={() => { setEditingColumns(false); refetch(); }} /> : null}
      {error && !tasks ? (
        <div role="alert" className="px-6 text-sm text-destructive">
          {error}
        </div>
      ) : !tasks ? (
        <div role="status" className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Icon name="Loading" className={cn("size-4", SPIN)} /> Loading tasks…
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-6 pb-6 max-md:px-3">
          {columns.map(({ id: status, label }) => {
            const cards = column(visible, status);
            const shown = status === "done" ? cards.slice(0, doneShown) : cards;
            return (
              <Column
                key={status}
                status={status}
                label={label}
                columns={columns}
                count={cards.length}
                tasks={shown}
                projects={projects}
                showProject={projectFilter === "all"}
                adding={adding === status}
                onAdd={() => setAdding(status)}
                onAddDone={(title) => {
                  setAdding(null);
                  if (title) void create(status, title);
                }}
                onDrop={(id, index) => {
                  const task = tasks.find((each) => each.id === id);
                  if (task) void move(task, status, index);
                }}
                onMove={(task, to) => void move(task, to)}
                onArchive={(task) =>
                  void rpc.call("archive", { id: task.id, archived: true }).then(
                    () => {
                      toast.success("Task archived", {
                        action: { label: "Undo", onClick: () => void rpc.call("archive", { id: task.id, archived: false }).then(refetch) },
                      });
                      refetch();
                    },
                    (failure) => toast.error(errorMessage(failure)),
                  )
                }
                onOpen={onOpen}
                footer={
                  cards.length > shown.length ? (
                    <button type="button" className={cn(GHOST_BUTTON, "w-full justify-center")} onClick={() => setDoneShown((n) => n + DONE_PAGE)}>
                      Show more ({cards.length - shown.length})
                    </button>
                  ) : null
                }
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function Column({
  status,
  label,
  columns,
  count,
  tasks,
  projects,
  showProject,
  adding,
  onAdd,
  onAddDone,
  onDrop,
  onMove,
  onArchive,
  onOpen,
  footer,
}: {
  status: TaskStatus;
  label: string;
  columns: TaskColumn[];
  count: number;
  tasks: Task[];
  projects: Project[];
  showProject: boolean;
  adding: boolean;
  onAdd(): void;
  onAddDone(title: string | null): void;
  onDrop(id: string, index: number): void;
  onMove(task: Task, status: TaskStatus): void;
  onArchive(task: Task): void;
  onOpen(id: string): void;
  footer: ReactNode;
}) {
  const [dropAt, setDropAt] = useState<number | null>(null);
  const list = useRef<HTMLDivElement>(null);

  /** The card index the pointer is above, by card midpoints. */
  function indexAt(event: DragEvent): number {
    const cards = [...(list.current?.querySelectorAll<HTMLElement>("[data-task-card]") ?? [])];
    const position = cards.findIndex((card) => {
      const box = card.getBoundingClientRect();
      return event.clientY < box.top + box.height / 2;
    });
    return position < 0 ? cards.length : position;
  }

  return (
    <section
      aria-label={label}
      className={cn(
        "flex w-72 min-w-64 shrink-0 flex-col rounded-lg bg-muted/40 max-md:w-64",
        dropAt !== null && "bg-state-hover ring-1 ring-border",
      )}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setDropAt(indexAt(event));
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropAt(null);
      }}
      onDrop={(event) => {
        const id = event.dataTransfer.getData(DRAG_TYPE);
        const index = indexAt(event);
        setDropAt(null);
        if (id) {
          event.preventDefault();
          // The dragged card itself doesn't count as a position.
          const from = tasks.findIndex((task) => task.id === id);
          onDrop(id, from >= 0 && from < index ? index - 1 : index);
        }
      }}
    >
      <div className="flex items-center gap-2 px-3 pt-3 pb-2">
        <Icon name={STATUS_ICONS[status] ?? "Circle"} className="size-4 text-muted-foreground" />
        <h2 title={label} className="min-w-0 truncate text-sm font-medium">{label}</h2>
        <span className="text-xs text-muted-foreground tabular-nums">{count}</span>
        <button
          type="button"
          aria-label={`Add to ${label}`}
          title="Add a task"
          className="ml-auto flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground"
          onClick={onAdd}
        >
          <Icon name="Plus" className="size-4" />
        </button>
      </div>
      <div ref={list} className="flex min-h-16 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
        {adding ? <NewCard onDone={onAddDone} /> : null}
        {tasks.map((task, index) => (
          <div key={task.id} className="relative">
            {dropAt === index ? <DropLine /> : null}
            <TaskCard columns={columns} task={task} projects={projects} showProject={showProject} onOpen={onOpen} onMove={onMove} onArchive={onArchive} />
          </div>
        ))}
        {dropAt !== null && dropAt >= tasks.length ? <DropLine last /> : null}
        {!tasks.length && !adding ? <p className="px-2 py-3 text-center text-xs text-muted-foreground">No tasks</p> : null}
        {footer}
      </div>
    </section>
  );
}

const DRAG_TYPE = "application/x-bb-task";

function DropLine({ last = false }: { last?: boolean }) {
  return <div aria-hidden className={cn("pointer-events-none h-0.5 rounded-full bg-primary", last ? "" : "absolute inset-x-0 -top-[5px]")} />;
}

function NewCard({ onDone }: { onDone(title: string | null): void }) {
  return (
    <textarea
      autoFocus
      aria-label="New task title"
      placeholder="What needs doing?"
      rows={2}
      maxLength={300}
      className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm shadow-sm outline-none focus:ring-1 focus:ring-ring"
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          const title = event.currentTarget.value.trim();
          onDone(title || null);
        }
        if (event.key === "Escape") onDone(null);
      }}
      onBlur={(event) => onDone(event.currentTarget.value.trim() || null)}
    />
  );
}

function TaskCard({
  task,
  columns,
  projects,
  showProject,
  onOpen,
  onMove,
  onArchive,
}: {
  task: Task;
  columns: TaskColumn[];
  projects: Project[];
  showProject: boolean;
  onOpen(id: string): void;
  onMove(task: Task, status: TaskStatus): void;
  onArchive(task: Task): void;
}) {
  const [dragging, setDragging] = useState(false);
  return (
    <div
      data-task-card
      draggable
      role="button"
      tabIndex={0}
      aria-label={task.title || "Untitled"}
      className={cn(
        "group relative cursor-grab rounded-md border border-border/70 bg-background px-3 py-2.5 text-left shadow-xs hover:border-border active:cursor-grabbing",
        dragging && "opacity-40",
      )}
      onDragStart={(event) => {
        event.dataTransfer.setData(DRAG_TYPE, task.id);
        event.dataTransfer.effectAllowed = "move";
        setDragging(true);
      }}
      onDragEnd={() => setDragging(false)}
      onClick={() => onOpen(task.id)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen(task.id);
        }
      }}
    >
      <div className="flex items-start gap-2">
        <span className={cn("min-w-0 flex-1 text-sm break-words", task.status === "done" && "text-muted-foreground line-through decoration-muted-foreground/50")}>
          {task.title || <span className="text-muted-foreground">Untitled</span>}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Task actions"
              className="-mt-0.5 -mr-1.5 flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-state-hover hover:text-foreground focus-visible:opacity-100 data-[state=open]:opacity-100"
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <Icon name="MoreHorizontal" className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-80 w-48 overflow-y-auto" onClick={(event) => event.stopPropagation()}>
            <DropdownMenuLabel className="text-xs text-muted-foreground">Move to</DropdownMenuLabel>
            {columns.map(({ id: status, label }) => (
              <DropdownMenuItem key={status} disabled={status === task.status} onSelect={() => onMove(task, status)}>
                <Icon name={STATUS_ICONS[status] ?? "Circle"} className="size-4" /> {label}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onArchive(task)}>
              <Icon name="Archive" className="size-4" /> Archive
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {task.handoff?.note && task.status !== "done" && task.handoff.state !== "working" ? (
        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{task.handoff.note}</p>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 empty:hidden">
        <HandoffBadge handoff={task.handoff} status={task.status} />
        <DueChip due={task.due} status={task.status} />
        <AssigneeChip assignee={task.assignee} />
        {task.links ? (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" title={plural(task.links, "link")}>
            <Icon name="Paperclip" className="size-3.5" />
            {task.links}
          </span>
        ) : null}
        {showProject && task.projectId ? (
          <span className="inline-flex min-w-0 items-center gap-1 truncate text-xs text-muted-foreground">
            <Icon name="Folder" className="size-3.5 shrink-0" />
            <span className="truncate">{projectName(projects, task.projectId)}</span>
          </span>
        ) : null}
      </div>
    </div>
  );
}

function ProjectPicker({ projects, value, onChange }: { projects: Project[]; value: ProjectFilter; onChange(value: ProjectFilter): void }) {
  const label = value === "all" ? "All projects" : value === "global" ? "Global" : projectName(projects, value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={OUTLINE_BUTTON}>
          <Icon name={value === "all" ? "GridView" : value === "global" ? "Globe" : "Folder"} /> {label}
          <Icon name="ChevronDown" className="text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80 w-56 overflow-y-auto">
        {[{ id: "all", name: "All projects", icon: "GridView" }, { id: "global", name: "Global", icon: "Globe" }].map((each) => (
          <DropdownMenuItem key={each.id} onSelect={() => onChange(each.id)}>
            <Icon name={each.icon} className="size-4" /> {each.name}
            {value === each.id ? <Icon name="Check" className="ml-auto size-4" /> : null}
          </DropdownMenuItem>
        ))}
        {projects.length ? <DropdownMenuSeparator /> : null}
        {projects.map((each) => (
          <DropdownMenuItem key={each.id} onSelect={() => onChange(each.id)}>
            <Icon name="Folder" className="size-4" /> <span className="truncate">{each.name}</span>
            {value === each.id ? <Icon name="Check" className="ml-auto size-4" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const ASSIGNEE_FILTERS: { value: AssigneeFilter; label: string; icon: string }[] = [
  { value: "everyone", label: "Everyone", icon: "Circle" },
  { value: "me", label: "Me", icon: "UserRound" },
  { value: "agent", label: "Agent", icon: "Bot" },
];

function AssigneePicker({ value, onChange }: { value: AssigneeFilter; onChange(value: AssigneeFilter): void }) {
  const current = ASSIGNEE_FILTERS.find((each) => each.value === value) ?? ASSIGNEE_FILTERS[0]!;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={OUTLINE_BUTTON}>
          <Icon name={current.icon} /> {current.label}
          <Icon name="ChevronDown" className="text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {ASSIGNEE_FILTERS.map((each) => (
          <DropdownMenuItem key={each.value} onSelect={() => onChange(each.value)}>
            <Icon name={each.icon} className="size-4" /> {each.label}
            {value === each.value ? <Icon name="Check" className="ml-auto size-4" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
