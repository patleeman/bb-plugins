// Explore in the app: an explainer's state, realtime events about it, and
// opening it in Pages' side-panel tab.
import type { BbNavigate } from "@get-bb/plugin-sdk/app";
import { useEffect, useState } from "react";
import type { RealtimeEvent } from "../constants";
import type { ExplainerView } from "../explore/contract";
import { isActiveJob, PAGE_PANEL_ACTION } from "../explore/shared";

export type { ExplainerView };

export const EXPLORE_ICON = "pages/explore";

/** What a finding's row shows. */
export type RowState = "idle" | "running" | "ready" | "error";

export function rowState(explainer: ExplainerView | null | undefined): RowState {
  if (!explainer) return "idle";
  if (explainer.job && isActiveJob(explainer.job.status)) return "running";
  if (explainer.pageId) return "ready";
  if (explainer.status === "error") return "error";
  return "idle";
}

export type ExplainerEvent = Extract<RealtimeEvent, { type: "explainer" }>;

export function explainerEvent(payload: unknown): ExplainerEvent | null {
  const event = payload as Partial<ExplainerEvent> | null;
  if (event?.type !== "explainer" || typeof event.explainerId !== "string" || typeof event.threadId !== "string" || typeof event.messageId !== "string") return null;
  return { type: "explainer", explainerId: event.explainerId, threadId: event.threadId, messageId: event.messageId, parentId: event.parentId ?? null };
}

/** The `page` panel tab's params for an explainer. */
export function explainerIdFrom(params: unknown): string | null {
  if (!params || typeof params !== "object" || Array.isArray(params)) return null;
  const { explainerId } = params as Record<string, unknown>;
  return typeof explainerId === "string" && explainerId ? explainerId : null;
}

/** Opens an explainer (its progress, or its page once written) in the thread's side panel. */
export function openExplainer(navigate: BbNavigate, explainer: Pick<ExplainerView, "id" | "label">): boolean {
  return navigate.openThreadPanel({ actionId: PAGE_PANEL_ACTION, title: explainer.label, params: { explainerId: explainer.id } });
}

/** Re-renders every minute so "2m ago" stays true. */
export function useMinuteTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 60_000);
    return () => clearInterval(timer);
  }, []);
  return tick;
}
