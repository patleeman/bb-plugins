// Explore's findings as full-width rows: "Along the way" at the bottom of a
// reply (the `::explore{items="🐛 …|🏗️ …"}` directive), and "Explore next"
// under an explainer. A row shows its explainer's state (Explore →
// Generating · 45% → Open · generated 2h ago, or Retry) from what's saved,
// so it survives a reload. Clicking one opens it in Pages' side-panel tab.
import { errorMessage } from "@bb-studio/kit/format";
import { useBbNavigate, useRealtime, useRpc, type PluginMessageDirectiveProps } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { REALTIME_CHANNEL } from "../constants";
import type { rpcContract } from "../contract";
import { labelKey, parseExploreItems, type ExploreItem } from "../explore/shared";
import { EXPLORE_ICON, explainerEvent, openExplainer, rowState, useMinuteTick, type ExplainerView } from "./explore";
import { relativeTime } from "./shared";

const POLL_MS = 2_500;

/** `::explore{items="…"}` at the end of a reply. */
export function ExploreDirective({ attributes, message }: PluginMessageDirectiveProps) {
  const raw = attributes.items;
  const items = useMemo(() => parseExploreItems(raw), [raw]);
  if (!items.length) return null;
  return <ExploreRows items={items} threadId={message.threadId} messageId={message.id} turnId={message.turnId} />;
}

export interface ExploreRowsProps {
  items: readonly ExploreItem[];
  threadId: string;
  messageId: string;
  turnId: string | null;
  /** Follow-ups of an explainer: explored from the same message, under it. */
  parentId?: string | null;
  title?: string;
  className?: string;
}

export function ExploreRows({ items, threadId, messageId, turnId, parentId = null, title = "Along the way", className }: ExploreRowsProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  useMinuteTick();
  const [explainers, setExplainers] = useState<ExplainerView[]>([]);
  /** Labels whose click is in flight, and clicks that failed before a job existed. */
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    rpc.call("explainersForMessage", { threadId, messageId, parentId }).then(
      (result) => setExplainers(result.explainers),
      () => undefined,
    );
  }, [rpc, threadId, messageId, parentId]);
  useEffect(load, [load]);
  useRealtime(REALTIME_CHANNEL, (payload) => {
    const event = explainerEvent(payload);
    if (event && event.threadId === threadId && event.messageId === messageId && event.parentId === parentId) load();
  });

  const byLabel = useMemo(() => new Map(explainers.map((explainer) => [labelKey(explainer.label), explainer])), [explainers]);
  const running = explainers.some((explainer) => rowState(explainer) === "running");
  // Realtime is the fast path; polling covers a dropped connection while a job runs.
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [running, load]);

  const replace = (next: ExplainerView) => setExplainers((current) => [...current.filter((each) => each.id !== next.id), next]);

  async function act(item: ExploreItem, explainer: ExplainerView | undefined, regenerate: boolean) {
    const key = labelKey(item.label);
    if (busy[key]) return;
    setErrors(({ [key]: _, ...rest }) => rest);
    const state = rowState(explainer);
    // Written or being written: just open it.
    if (explainer && !regenerate && (state === "ready" || state === "running")) {
      openExplainer(navigate, explainer);
      return;
    }
    setBusy((current) => ({ ...current, [key]: true }));
    try {
      const next =
        regenerate && explainer
          ? (await rpc.call("exploreRegenerate", { explainerId: explainer.id })).explainer
          : (await rpc.call("explore", { threadId, messageId, turnId, emoji: item.emoji, label: item.label, parentId })).explainer;
      replace(next);
      openExplainer(navigate, next);
    } catch (error) {
      setErrors((current) => ({ ...current, [key]: errorMessage(error) }));
    } finally {
      setBusy(({ [key]: _, ...rest }) => rest);
    }
  }

  if (!items.length) return null;
  return (
    <section aria-label={title} className={cn("my-3 w-full overflow-hidden rounded-lg border border-border/70 bg-background", className)}>
      <header className="flex items-center gap-1.5 px-3 pt-2 pb-1 text-xs text-muted-foreground">
        <Icon name={EXPLORE_ICON} fallback="Compass" className="size-3.5" />
        {title}
      </header>
      <ul className="divide-y divide-border/60 border-t border-border/60">
        {items.map((item) => {
          const key = labelKey(item.label);
          const explainer = byLabel.get(key);
          return (
            <ExploreRow
              key={key}
              item={item}
              explainer={explainer}
              pending={Boolean(busy[key])}
              clickError={errors[key] ?? null}
              onOpen={() => void act(item, explainer, false)}
              onRegenerate={() => void act(item, explainer, true)}
            />
          );
        })}
      </ul>
    </section>
  );
}

function ExploreRow({
  item,
  explainer,
  pending,
  clickError,
  onOpen,
  onRegenerate,
}: {
  item: ExploreItem;
  explainer: ExplainerView | undefined;
  pending: boolean;
  clickError: string | null;
  onOpen(): void;
  onRegenerate(): void;
}) {
  const state = clickError ? "error" : rowState(explainer);
  const progress = Math.round(explainer?.job?.progress ?? 0);
  const error = clickError ?? explainer?.job?.error ?? explainer?.error ?? null;
  const writtenAt = explainer?.regeneratedAt ?? explainer?.generatedAt ?? null;
  const regenerating = state === "running" && explainer?.job?.kind === "regenerate";

  let status: string;
  let title: string | undefined;
  if (state === "running") {
    status = `${regenerating ? "Regenerating" : "Generating"} · ${progress}%`;
    title = explainer?.job ? `${explainer.job.label}: ${explainer.job.detail}` : undefined;
  } else if (state === "ready") {
    status = writtenAt ? `Open · ${explainer?.regeneratedAt ? "regenerated" : "generated"} ${relativeTime(writtenAt)}` : "Open";
  } else if (state === "error") {
    status = "Retry";
    title = error ?? undefined;
  } else {
    status = "Explore";
  }

  return (
    <li className="group relative flex items-stretch">
      <button
        type="button"
        onClick={onOpen}
        disabled={pending}
        title={title}
        className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left hover:bg-state-hover disabled:cursor-progress"
      >
        <span aria-hidden className="w-5 shrink-0 text-center text-base leading-none">
          {item.emoji}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">{item.label}</span>
        <span
          className={cn(
            "flex shrink-0 items-center gap-1.5 text-xs tabular-nums",
            state === "error" ? "text-destructive" : state === "idle" ? "text-muted-foreground group-hover:text-foreground" : "text-muted-foreground",
            state === "running" && "animate-pulse motion-reduce:animate-none",
          )}
        >
          {pending ? <Icon name="Loading" fallback="Loader2" className="size-3.5 animate-spin motion-reduce:animate-none" /> : null}
          {status}
          {state === "ready" ? <Icon name="ArrowUpRight" className="size-3.5" /> : null}
          {state === "error" ? <Icon name="RotateCcw" className="size-3.5" /> : null}
        </span>
      </button>
      {state === "ready" ? (
        <button
          type="button"
          onClick={onRegenerate}
          disabled={pending}
          aria-label={`Regenerate "${item.label}"`}
          title="Regenerate"
          className="flex w-9 shrink-0 items-center justify-center text-muted-foreground hover:bg-state-hover hover:text-foreground disabled:opacity-40"
        >
          <Icon name="RotateCw" fallback="RotateCcw" className="size-3.5" />
        </button>
      ) : null}
      {state === "running" ? (
        <>
          <span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-foreground/[0.06]">
            <span className="block h-full bg-foreground/40 transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${Math.max(progress, 3)}%` }} />
          </span>
          <span role="progressbar" aria-label={`${item.label}: ${status}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} className="sr-only" />
        </>
      ) : null}
    </li>
  );
}
