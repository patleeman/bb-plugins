// An Explore explainer in the Page side-panel tab (`{ explainerId }`
// params): live progress (with Stop) while it's written, the error with
// Retry when it failed, and once it's ready the page's live editor under a
// header (when it was written, Regenerate, Open in Pages) with its follow-up
// findings below.
import { errorMessage, shortDateTime } from "@bb-studio/kit/format";
import { useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { REALTIME_CHANNEL } from "../constants";
import type { rpcContract } from "../contract";
import { EXPLORE_ICON, explainerEvent, rowState, useMinuteTick, type ExplainerView, type RowState } from "./explore";
import { ExploreRows } from "./explore-rows";
import { OpenInPages, PanelMessage, PanelShell, usePanelPage } from "./PanelShell";
import { relativeTime } from "./shared";

const POLL_MS = 2_000;

export function ExplainerPanel({ explainerId }: { explainerId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  useMinuteTick();
  const [explainer, setExplainer] = useState<ExplainerView | null | undefined>(undefined);
  const [actionError, setActionError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);

  const load = useCallback(() => {
    rpc.call("explainer", { explainerId }).then(
      (result) => setExplainer(result.explainer),
      (error: unknown) => {
        setActionError(errorMessage(error));
        setExplainer((current) => current ?? null);
      },
    );
  }, [rpc, explainerId]);
  useEffect(load, [load]);
  useRealtime(REALTIME_CHANNEL, (payload) => {
    if (explainerEvent(payload)?.explainerId === explainerId) load();
  });

  const state = rowState(explainer);
  // Realtime is the fast path; polling covers a dropped connection while a job runs.
  useEffect(() => {
    if (state !== "running") return;
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [state, load]);

  const page = usePanelPage(explainer?.pageId ?? null);

  async function run(method: "exploreRegenerate" | "exploreStop") {
    setActing(true);
    setActionError(null);
    try {
      const result = await rpc.call(method, { explainerId });
      if (result.explainer) setExplainer(result.explainer);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setActing(false);
    }
  }

  if (explainer === undefined) return <p className="p-4 text-sm text-muted-foreground">Loading…</p>;
  if (explainer === null) return <PanelMessage title="Explainer not found" detail={actionError ?? "It may have been removed."} />;

  const job = explainer.job;
  const error =
    actionError ??
    (state === "error" ? (job?.error ?? explainer.error) : null) ??
    (state === "ready" && job?.status === "error" ? `Regenerating failed: ${job.error ?? "unknown error"}` : null);
  const header = (
    <>
      <ExplainerHeader
        explainer={explainer}
        title={page?.title || explainer.label}
        state={state}
        acting={acting}
        onRegenerate={() => void run("exploreRegenerate")}
        onStop={() => void run("exploreStop")}
        onOpenPage={explainer.pageId && page ? () => navigate.toPluginPanel("pages", { subPath: explainer.pageId! }) : null}
      />
      {state === "running" && job ? (
        <Progress label={job.kind === "regenerate" ? `Regenerating · ${job.label}` : job.label} detail={job.detail} progress={job.progress} startedAt={job.createdAt} />
      ) : null}
      {error ? (
        <div role="alert" className="mx-3 mt-3 flex shrink-0 items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/[0.06] px-3 py-2 text-xs text-destructive">
          <Icon name="AlertTriangle" fallback="CircleAlert" className="mt-px size-3.5 shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
        </div>
      ) : null}
    </>
  );
  const followUps = explainer.followUps.length ? (
    <ExploreRows
      title="Explore next"
      items={explainer.followUps}
      threadId={explainer.threadId}
      messageId={explainer.messageId}
      turnId={explainer.turnId}
      parentId={explainer.id}
    />
  ) : null;

  if (explainer.pageId && page) return <PanelShell page={page} header={header} footer={followUps} />;

  return (
    <div className="pages-doc relative flex h-full min-h-0 flex-col overflow-auto bg-background text-foreground">
      {header}
      {explainer.pageId && page === undefined ? (
        <p className="p-4 text-sm text-muted-foreground">Loading…</p>
      ) : state === "idle" ? (
        <p className="p-4 text-sm text-muted-foreground">{explainer.pageId ? "Its page was deleted. Generate it again to write a new one." : "Not written yet."}</p>
      ) : null}
    </div>
  );
}

function writtenLine(explainer: ExplainerView, state: RowState): string {
  if (state === "running" && !explainer.pageId) return "Writing an explainer…";
  if (explainer.regeneratedAt) return `Regenerated ${relativeTime(explainer.regeneratedAt)}`;
  if (explainer.generatedAt) return `Generated ${relativeTime(explainer.generatedAt)}`;
  return state === "error" ? "Couldn't write the explainer" : "Explore";
}

function ExplainerHeader({
  explainer,
  title,
  state,
  acting,
  onRegenerate,
  onStop,
  onOpenPage,
}: {
  explainer: ExplainerView;
  title: string;
  state: RowState;
  acting: boolean;
  onRegenerate(): void;
  onStop(): void;
  onOpenPage: (() => void) | null;
}) {
  const writtenAt = explainer.regeneratedAt ?? explainer.generatedAt;
  const button = "flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground disabled:opacity-50";
  return (
    <header className="flex min-h-11 shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
      <span className="shrink-0 text-base leading-none" aria-hidden>
        {explainer.emoji}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{title}</div>
        <div className="flex items-center gap-1 truncate text-[11px] text-muted-foreground" title={writtenAt ? shortDateTime(writtenAt) : undefined}>
          <Icon name={EXPLORE_ICON} fallback="Compass" className="size-3 shrink-0" />
          {writtenLine(explainer, state)}
        </div>
      </div>
      {state === "running" ? (
        <button type="button" className={button} disabled={acting} onClick={onStop} title="Stop writing this explainer">
          <Icon name="Square" className="size-3.5" /> Stop
        </button>
      ) : (
        <button type="button" className={button} disabled={acting} onClick={onRegenerate} title={state === "ready" ? "Write it again; the current page is kept as a version" : undefined}>
          <Icon name={state === "ready" ? "RotateCw" : "RotateCcw"} fallback="RotateCcw" className="size-3.5" />
          {state === "ready" ? "Regenerate" : state === "error" ? "Retry" : "Generate"}
        </button>
      )}
      {onOpenPage ? <OpenInPages onOpen={onOpenPage} /> : null}
    </header>
  );
}

function Progress({ label, detail, progress, startedAt }: { label: string; detail: string; progress: number; startedAt: number }) {
  const value = Math.round(progress);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="mx-3 mt-3 shrink-0 rounded-lg border border-border/70 px-3 py-2.5">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="flex min-w-0 items-center gap-2 font-medium">
          <Icon name="Loading" fallback="Loader2" className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
          <span className="truncate">{label}</span>
        </span>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {value}% · {elapsed(now - startedAt)}
        </span>
      </div>
      <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value} className="mt-2 h-1 overflow-hidden rounded-full bg-foreground/[0.06]">
        <div className="h-full rounded-full bg-foreground/50 transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${Math.max(value, 3)}%` }} />
      </div>
      <p className={cn("mt-2 text-xs text-muted-foreground")}>{detail}</p>
      <p className="mt-1 text-xs text-muted-foreground">A private copy of this thread is investigating. You can keep working; the page is saved in Pages under Explore.</p>
    </div>
  );
}

function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}
