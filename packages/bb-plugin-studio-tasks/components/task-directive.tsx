// `::task{id="tsk_…"}` in a reply: a card for a task that opens it on the
// board, with its status and who acts next.
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@bb-studio/kit/app";
import { useBbNavigate, useRealtime, type PluginMessageDirectiveProps } from "@get-bb/plugin-sdk/app";
import { PANEL_PATH, REALTIME_CHANNEL, COLUMNS_UPDATE_TYPE, TASK_UPDATE_TYPE, isTaskId } from "../src/shared";
import { AssigneeChip, DueChip, HandoffBadge, STATUS_ICONS } from "./pieces";
import { useTasksRpc, type Task, type TaskEvent } from "./types";

export function TaskDirective({ attributes }: PluginMessageDirectiveProps) {
  const id = attributes.id ?? "";
  const valid = isTaskId(id);
  const rpc = useTasksRpc();
  const navigate = useBbNavigate();
  const [task, setTask] = useState<Task | null | undefined>(undefined);

  const load = useCallback(() => {
    if (!valid) return;
    rpc.call("get", { id }).then(
      (result) => setTask(result.task),
      () => setTask(null),
    );
  }, [rpc, id, valid]);
  useEffect(load, [load]);
  useRealtime(REALTIME_CHANNEL, (payload) => {
    const event = payload as TaskEvent;
    if (event?.type === COLUMNS_UPDATE_TYPE || (event?.type === TASK_UPDATE_TYPE && event.taskId === id)) load();
  });

  if (!valid || task === null) {
    return (
      <div className="my-2 flex items-center gap-2 rounded-lg border border-border/70 px-3 py-2 text-sm text-muted-foreground">
        <Icon name="ListTodo" className="size-4" /> This task was deleted.
      </div>
    );
  }
  if (!task) {
    return <div className="my-2 h-14 max-w-md animate-pulse rounded-lg border border-border/70 bg-muted/40 motion-reduce:animate-none" />;
  }
  return (
    <button
      type="button"
      onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: task.id })}
      className="group my-2 flex w-full max-w-md items-center gap-3 rounded-lg border border-border/70 bg-background px-3 py-2.5 text-left hover:border-border hover:bg-state-hover"
    >
      <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <Icon name={STATUS_ICONS[task.status] ?? "Circle"} className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{task.title || "Untitled"}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>{task.statusLabel} · Studio Tasks</span>
          <HandoffBadge handoff={task.handoff} status={task.status} />
          <DueChip due={task.due} status={task.status} />
          <AssigneeChip assignee={task.assignee} />
        </div>
      </div>
      <Icon name="ArrowUpRight" className="size-4 shrink-0 text-muted-foreground group-hover:text-foreground" />
    </button>
  );
}
