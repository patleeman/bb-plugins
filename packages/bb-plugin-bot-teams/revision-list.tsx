import { useState } from "react";
import { Button } from "./components/ui/button";
export type Revision = {
  id: number;
  text: string;
  actor: string;
  createdAt: number;
};

/** A valid replacement diff, bounded by the document size, without quadratic LCS. */
export function revisionDiff(previous: string, current: string) {
  const a = previous.split("\n"),
    b = current.split("\n");
  let start = 0,
    end = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  while (
    end < a.length - start &&
    end < b.length - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  )
    end++;
  return (
    [
      ...a.slice(Math.max(0, start - 2), start).map((s) => `  ${s}`),
      ...a.slice(start, a.length - end).map((s) => `− ${s}`),
      ...b.slice(start, b.length - end).map((s) => `+ ${s}`),
      ...a.slice(a.length - end, a.length - end + 2).map((s) => `  ${s}`),
    ].join("\n") || "No changes"
  );
}
export function RevisionList({
  revisions,
  current,
  onUse,
  onMore,
  morePending,
}: {
  revisions: Revision[];
  current: string;
  onUse: (text: string) => void;
  onMore?: () => void;
  morePending?: boolean;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  return (
    <div className="channel-revisions">
      {!revisions.length && <p>No saved versions yet.</p>}
      {revisions.map((r) => (
        <details
          key={r.id}
          open={selected === r.id}
          onToggle={(e) => {
            if (e.currentTarget.open) setSelected(r.id);
          }}
        >
          <summary>
            {new Date(r.createdAt).toLocaleString()} · {r.actor}
          </summary>
          <pre aria-label="Version compared with current draft">
            {revisionDiff(r.text, current)}
          </pre>
          <Button size="sm" variant="outline" onClick={() => onUse(r.text)}>
            Use this version
          </Button>
        </details>
      ))}
      {onMore && (
        <Button
          variant="ghost"
          size="sm"
          disabled={morePending}
          onClick={onMore}
        >
          Earlier versions
        </Button>
      )}
    </div>
  );
}
