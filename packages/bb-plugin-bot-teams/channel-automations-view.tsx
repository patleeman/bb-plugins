import { AutomationEditor, scheduleDescription } from "./automation-editor";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc, useRealtime, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { Bot, rpcContract } from "./contract";
import type {
  ChannelAutomation,
  ChannelAutomationRunPage,
} from "./automation-contract";
import { Button } from "./components/ui/button";
import { ErrorMessage, message } from "./bot-ui";
import { Modal } from "./channel-controls";

export function ChannelAutomationsView({
  id,
  bots,
  open,
  onOpenChange,
  presentation = "modal",
}: {
  id: string;
  bots: Bot[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  presentation?: "modal" | "panel";
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [editing, setEditing] = useState<ChannelAutomation | "new" | null>(
    null,
  );
  const [history, setHistory] = useState<
    (ChannelAutomationRunPage & { automationId: string }) | null
  >(null);
  const [items, setItems] = useState<ChannelAutomation[]>([]);
  const [offset, setOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const request = useRef(0);
  const runKeys = useRef(new Map<string, string>());
  const load = useCallback(
    async (next = 0) => {
      const seq = ++request.current;
      setLoading(true);
      try {
        const result = await rpc.call("automationList", {
          channelId: id,
          offset: next,
          limit: 20,
        });
        if (seq !== request.current) return;
        setItems((old) =>
          next ? [...old, ...result.automations] : result.automations,
        );
        setOffset(result.nextOffset);
        setError(null);
      } catch (e) {
        if (seq === request.current) setError(message(e));
      } finally {
        if (seq === request.current) setLoading(false);
      }
    },
    [id, rpc],
  );
  useEffect(() => {
    setItems([]);
    setOffset(null);
    setError(null);
    setNotice(null);
    setDeleting(null);
    setHistory(null);
    if (open) void load();
    return () => {
      request.current++;
    };
  }, [open, load]);
  useRealtime("changed", () => {
    if (open && !pending) {
      void load();
      const selected = items.find((a) => a.id === history?.automationId);
      if (selected) void showHistory(selected);
    }
  });
  useEffect(() => {
    if (
      !open ||
      !history ||
      !history.runs.some(
        (r) =>
          r.status === "running" ||
          ["queued", "dispatching", "running"].includes(r.responseStatus ?? ""),
      )
    )
      return;
    const timer = setInterval(() => {
      const selected = items.find((a) => a.id === history.automationId);
      if (!pending && selected && document.visibilityState === "visible")
        void showHistory(selected);
    }, 5000);
    return () => clearInterval(timer);
  }, [open, history, items, pending]);
  async function act(
    a: ChannelAutomation,
    action: "pause" | "resume" | "run" | "delete",
  ) {
    setPending(a.id);
    setError(null);
    setNotice(null);
    if (action === "run" && !runKeys.current.has(a.id))
      runKeys.current.set(a.id, crypto.randomUUID());
    try {
      await rpc.call("automationAction", {
        channelId: id,
        automationId: a.id,
        action,
        ...(action === "run" ? { requestId: runKeys.current.get(a.id)! } : {}),
      });
      runKeys.current.delete(a.id);
      setDeleting(null);
      setNotice(
        action === "run"
          ? "Run requested. The bot’s response appears in this channel; check Activity for progress."
          : action === "pause"
            ? "Paused. Any response already in progress continues."
            : action === "delete"
              ? "Automation deleted."
              : "Automation resumed.",
      );
      await load();
    } catch (e) {
      setError(message(e));
    } finally {
      setPending(null);
    }
  }
  async function showHistory(a: ChannelAutomation, cursor?: string) {
    const seq = request.current;
    setPending(a.id);
    setError(null);
    try {
      const page = await rpc.call("automationRuns", {
        channelId: id,
        automationId: a.id,
        limit: 10,
        ...(cursor ? { cursor } : {}),
      });
      if (seq !== request.current) return;
      setHistory((previous) => ({
        ...page,
        automationId: a.id,
        runs:
          cursor && previous?.automationId === a.id
            ? [...previous.runs, ...page.runs]
            : page.runs,
      }));
    } catch (e) {
      if (seq === request.current) setError(message(e));
    } finally {
      setPending(null);
    }
  }
  const content = (
    <div className="channel-workbench-panel">
      {editing ? (
        <AutomationEditor
          key={editing === "new" ? "new" : editing.id}
          id={id}
          bots={bots.filter((b) => !b.retired)}
          initial={editing === "new" ? undefined : editing}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      ) : (
        <Button
          size="sm"
          disabled={!bots.some((b) => !b.retired)}
          onClick={() => setEditing("new")}
        >
          New automation
        </Button>
      )}
      <p className="channel-automation-hint">
        Ask a bot to schedule a task here, including the time and timezone. For
        example: “Every weekday at 9am New York time, summarize our open
        questions.”
      </p>
      <div
        className="channel-automation-list"
        aria-label="Channel automations"
        aria-busy={loading}
      >
        {items.map((a) => (
          <article className="channel-automation" key={a.id}>
            <div className="channel-automation-title">
              <strong>{a.name}</strong>
              <span>{a.enabled ? "Enabled" : "Paused"}</span>
            </div>
            <p>
              {bots.find((b) => b.id === a.botId)?.name ?? "Unavailable bot"} ·{" "}
              {scheduleDescription(a)}
            </p>
            <p>
              {a.nextRunAt
                ? `Next: ${new Date(a.nextRunAt).toLocaleString()}`
                : "No scheduled run"}
            </p>
            <details>
              <summary>Task details</summary>
              <p className="channel-automation-prompt">{a.prompt}</p>
              {(a.lastRunAt || a.lastRunStatus) && (
                <p>
                  Last dispatch:{" "}
                  {a.lastRunAt
                    ? `${new Date(a.lastRunAt).toLocaleString()} · `
                    : ""}
                  {a.lastRunStatus ?? "pending"}
                </p>
              )}
              {a.lastError && <p role="alert">{a.lastError}</p>}
            </details>
            <div className="channel-automation-actions">
              <Button
                variant="ghost"
                size="sm"
                disabled={!!pending}
                onClick={() => setEditing(a)}
              >
                Edit
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!!pending}
                onClick={() => void act(a, a.enabled ? "pause" : "resume")}
              >
                {a.enabled ? "Pause" : "Resume"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!!pending}
                onClick={() => void act(a, "run")}
              >
                {pending === a.id ? "Working…" : "Run now"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={!!pending}
                onClick={() => void showHistory(a)}
              >
                Run history
              </Button>
              {deleting === a.id ? (
                <>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={!!pending}
                    onClick={() => void act(a, "delete")}
                  >
                    Confirm delete
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!!pending}
                    onClick={() => setDeleting(null)}
                  >
                    Cancel
                  </Button>
                </>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!!pending}
                  onClick={() => setDeleting(a.id)}
                >
                  Delete
                </Button>
              )}
            </div>
            {history?.automationId === a.id && (
              <section
                aria-label={`Run history for ${a.name}`}
                className="channel-automation-history"
              >
                <p>Dispatch and response history</p>
                {!history.runs.length && <p>No runs yet.</p>}
                {history.runs.map((run) => (
                  <div key={run.id}>
                    <p>
                      {new Date(run.startedAt).toLocaleString()} ·{" "}
                      {run.trigger === "manual" ? "Manual" : "Scheduled"} ·{" "}
                      {run.status}
                    </p>
                    {run.responseStatus && (
                      <p>Response: {run.responseStatus}</p>
                    )}
                    {run.responseError && (
                      <p role="alert">{run.responseError}</p>
                    )}
                    {run.responseMessageId && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          navigate.toPluginPanel("channels", {
                            subPath: `${id}/message/${encodeURIComponent(run.responseMessageId!)}`,
                          });
                          window.dispatchEvent(
                            new CustomEvent("bb:bots:jump", {
                              detail: {
                                roomId: id,
                                messageId: run.responseMessageId,
                              },
                            }),
                          );
                        }}
                      >
                        View response
                      </Button>
                    )}
                    {run.responseThreadId && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => navigate.toThread(run.responseThreadId!)}
                      >
                        View work
                      </Button>
                    )}
                    {run.error && <p role="alert">{run.error}</p>}
                    {run.skipReason && <p>{run.skipReason}</p>}
                  </div>
                ))}
                {history.nextCursor && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!!pending}
                    onClick={() => void showHistory(a, history.nextCursor!)}
                  >
                    Earlier runs
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!!pending}
                  onClick={() => setHistory(null)}
                >
                  Hide history
                </Button>
              </section>
            )}
          </article>
        ))}
        {!items.length && !loading && !error && (
          <p>No automations in this channel yet.</p>
        )}
        {loading && <p role="status">Loading automations…</p>}
        {offset !== null && (
          <Button
            variant="outline"
            disabled={loading || !!pending}
            onClick={() => void load(offset)}
          >
            Load more
          </Button>
        )}
      </div>
      {notice && <p role="status">{notice}</p>}
      <ErrorMessage error={error} />
      {error && (
        <Button
          variant="outline"
          disabled={loading || !!pending}
          onClick={() => void load()}
        >
          Refresh
        </Button>
      )}
    </div>
  );
  return presentation === "panel" ? (
    content
  ) : (
    <Modal title="Channel automations" open={open} onOpenChange={onOpenChange}>
      {content}
    </Modal>
  );
}
