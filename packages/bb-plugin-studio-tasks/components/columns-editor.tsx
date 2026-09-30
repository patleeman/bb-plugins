import { useState } from "react";
import { toast } from "sonner";
import { GHOST_BUTTON, Icon, OUTLINE_BUTTON, cn } from "@bb-studio/kit/app";
import { errorMessage } from "@bb-studio/kit/format";
import { STATUSES, STATUS_LABELS, type TaskColumn } from "../src/shared";
import { SPIN, useTasksRpc } from "./types";

const isWorkflowColumn = (id: string) => (STATUSES as readonly string[]).includes(id);

/** A draft until Save; stable IDs keep renaming separate from task status. */
export function ColumnsEditor({ columns, revision, onClose, onSaved }: {
  columns: TaskColumn[];
  revision: number;
  onClose(): void;
  onSaved(): void;
}) {
  const rpc = useTasksRpc();
  const [draft, setDraft] = useState(() => columns.map((column) => ({ ...column })));
  const [baseRevision] = useState(revision);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reorder(index: number, offset: number) {
    setDraft((current) => {
      const next = [...current];
      [next[index], next[index + offset]] = [next[index + offset]!, next[index]!];
      return next;
    });
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await rpc.call("saveColumns", { columns: draft, revision: baseRevision });
      toast.success("Columns saved");
      onSaved();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setSaving(false);
    }
  }

  function add() {
    const id = `col_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
    let label = "New column";
    for (let n = 2; draft.some((column) => column.label.trim().toLowerCase() === label.toLowerCase()); n++) {
      label = `New column ${n}`;
    }
    setDraft((current) => [...current, { id, label }]);
  }

  return (
    <form
      aria-label="Customize columns"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      className="mx-6 mb-4 flex max-h-[60vh] max-w-2xl shrink-0 flex-col overflow-y-auto rounded-lg border border-border p-4 max-md:mx-3"
    >
      <h2 className="mb-2 text-sm font-medium">Customize columns</h2>
      <p className="mb-3 text-xs text-muted-foreground">
        Columns apply to all projects. The four workflow stages stay available for agent handoffs.
        Move tasks out of a custom column before removing it, including archived tasks.
      </p>
      <fieldset disabled={saving} className="flex flex-col gap-2">
        {draft.map((column, index) => (
          <div key={column.id} className="flex items-center gap-1.5">
            <div className="min-w-0 flex-1">
              <input
                aria-label={`Column ${index + 1} name`}
                value={column.label}
                maxLength={60}
                required
                className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm outline-none focus:ring-1 focus:ring-ring"
                onChange={(event) => {
                  const label = event.currentTarget.value;
                  setDraft((current) => current.map((item) => item.id === column.id ? { ...item, label } : item));
                }}
              />
              {isWorkflowColumn(column.id) ? (
                <span className="text-xs text-muted-foreground">Workflow: {STATUS_LABELS[column.id]}</span>
              ) : null}
            </div>
            <button
              type="button"
              className={cn(GHOST_BUTTON, "px-2")}
              aria-label={`Move ${column.label} left`}
              disabled={index === 0}
              onClick={() => reorder(index, -1)}
            >
              <Icon name="ArrowLeft" />
            </button>
            <button
              type="button"
              className={cn(GHOST_BUTTON, "px-2")}
              aria-label={`Move ${column.label} right`}
              disabled={index === draft.length - 1}
              onClick={() => reorder(index, 1)}
            >
              <Icon name="ArrowRight" />
            </button>
            <button
              type="button"
              className={cn(GHOST_BUTTON, "px-2")}
              aria-label={`Remove ${column.label}`}
              disabled={isWorkflowColumn(column.id)}
              onClick={() => setDraft((current) => current.filter((item) => item.id !== column.id))}
            >
              <Icon name="Trash2" />
            </button>
          </div>
        ))}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button type="button" className={OUTLINE_BUTTON} disabled={draft.length >= 20} onClick={add}>
            <Icon name="Plus" /> Add column
          </button>
          <button type="submit" className={cn(OUTLINE_BUTTON, "ml-auto")}>
            <Icon name={saving ? "Loading" : "Check"} className={cn(saving && SPIN)} /> Save columns
          </button>
          <button type="button" className={GHOST_BUTTON} onClick={onClose}>Cancel</button>
        </div>
      </fieldset>
      {error ? <p role="alert" className="mt-2 text-sm text-destructive">{error}</p> : null}
    </form>
  );
}
