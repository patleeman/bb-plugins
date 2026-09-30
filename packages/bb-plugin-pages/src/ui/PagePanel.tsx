import { useBbNavigate, useRpc, type PluginThreadPanelProps } from "@get-bb/plugin-sdk/app";
import { useEffect, useState } from "react";
import { Icon } from "@/components/ui/icon";
import type { rpcContract } from "../contract";
import { explainerIdFrom } from "./explore";
import { ExplainerPanel } from "./explore-panel";
import { OpenInPages, PanelMessage, PanelShell, usePanelPage } from "./PanelShell";
import { relativeTime } from "./shared";

/**
 * What the `page` thread panel tab is opened with: a page, or an Explore
 * explainer (its progress while it's written, then its page).
 */
export type PagePanelParams = { pageId: string } | { explainerId: string };

function pageIdFrom(params: PluginThreadPanelProps["params"]): string | null {
  if (!params || typeof params !== "object" || Array.isArray(params)) return null;
  const { pageId } = params as Record<string, unknown>;
  return typeof pageId === "string" && pageId ? pageId : null;
}

/**
 * A page in a thread's side panel: the same live editor as the Pages view,
 * under a compact header. Opened without params (from the panel's launcher),
 * it shows the page the thread was started from, if any.
 */
export function PagePanel({ threadId, params }: PluginThreadPanelProps) {
  const explainerId = explainerIdFrom(params);
  if (explainerId) return <ExplainerPanel key={explainerId} explainerId={explainerId} />;
  return <PageTab threadId={threadId} params={params} />;
}

function PageTab({ threadId, params }: PluginThreadPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [pageId, setPageId] = useState<string | null | undefined>(() => pageIdFrom(params) ?? undefined);
  useEffect(() => {
    const fromParams = pageIdFrom(params);
    if (fromParams) {
      setPageId(fromParams);
      return;
    }
    let live = true;
    rpc.call("chatPage", { threadId }).then(
      (result) => live && setPageId(result.page?.id ?? null),
      () => live && setPageId(null),
    );
    return () => {
      live = false;
    };
  }, [rpc, params, threadId]);
  const page = usePanelPage(pageId ?? null);

  if (pageId === null || page === null) {
    return (
      <PanelMessage
        title={pageId ? "Page not found" : "No page to show"}
        detail={pageId ? "It may have been deleted." : "Open a page from Pages to see it here."}
      />
    );
  }
  if (!pageId || !page) return <p className="p-4 text-sm text-muted-foreground">Loading…</p>;

  return (
    <PanelShell
      page={page}
      header={
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
          {page.icon ? <span className="shrink-0 text-base leading-none">{page.icon}</span> : <Icon name="FileText" className="size-4 shrink-0 text-muted-foreground" />}
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{page.title || "Untitled"}</div>
            <div className="truncate text-[11px] text-muted-foreground">Edited {relativeTime(page.updatedAt)}</div>
          </div>
          <OpenInPages onOpen={() => navigate.toPluginPanel("pages", { subPath: page.id })} />
        </header>
      }
    />
  );
}
