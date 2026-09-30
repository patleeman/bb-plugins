// The Page side-panel tab's frame, shared by a page and an Explore
// explainer: a page's metadata kept current, and its live editor under a
// header.
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/ui/icon";
import { REALTIME_CHANNEL, type RealtimeEvent } from "../constants";
import type { BotView, PageMetaView, rpcContract } from "../contract";
import { PagesUiContext } from "./context";
import { PageEditor } from "./PageEditor";
import { usePagesData, usePagesUiValue } from "./PagesPanel";
import { useConnection } from "./PageView";

/** A page's metadata, kept current: undefined while loading, null once it's gone. */
export function usePanelPage(pageId: string | null): PageMetaView | null | undefined {
  const rpc = useRpc<typeof rpcContract>();
  const [page, setPage] = useState<PageMetaView | null | undefined>(undefined);
  const fetchPage = useCallback(() => {
    if (!pageId) return;
    rpc.call("get", { id: pageId }).then(
      (result) => setPage(result.page?.id === pageId ? result.page : null),
      () => setPage(null),
    );
  }, [rpc, pageId]);
  useEffect(() => {
    setPage(undefined);
    fetchPage();
  }, [fetchPage]);
  useRealtime(REALTIME_CHANNEL, (payload) => {
    const event = payload as RealtimeEvent;
    if (!pageId) return;
    if ((event.type === "page" && event.pageId === pageId) || event.type === "tree") fetchPage();
    if (event.type === "deleted" && event.pageIds.includes(pageId)) setPage(null);
  });
  return pageId ? page : null;
}

export function OpenInPages({ onOpen }: { onOpen(): void }) {
  return (
    <button
      type="button"
      title="Open the full page in Pages"
      className="flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground"
      onClick={onOpen}
    >
      Open in Pages
      <Icon name="ArrowUpRight" className="size-3.5" />
    </button>
  );
}

export function PanelMessage({ title, detail, children }: { title: string; detail?: string; children?: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <Icon name="FileText" className="size-6 text-muted-foreground" />
      <p className="text-sm font-medium">{title}</p>
      {detail ? <p className="max-w-xs text-xs text-muted-foreground">{detail}</p> : null}
      {children}
    </div>
  );
}

/** The panel tab's frame around a page's live editor: a header above it, and anything below it. */
export function PanelShell({ page, header, footer }: { page: PageMetaView; header: React.ReactNode; footer?: React.ReactNode }) {
  const rpc = useRpc<typeof rpcContract>();
  const { pages, bots } = usePagesData(rpc);
  const ui = usePagesUiValue(rpc, pages, bots);
  return (
    <PagesUiContext.Provider value={ui}>
      <div className="pages-doc pages-panel-tab relative flex h-full min-h-0 flex-col bg-background text-foreground">
        {header}
        <PanelEditor key={page.id} page={page} pages={pages ?? []} bots={bots.bots} footer={footer} />
      </div>
    </PagesUiContext.Provider>
  );
}

function PanelEditor({ page, pages, bots, footer }: { page: PageMetaView; pages: PageMetaView[]; bots: BotView[]; footer?: React.ReactNode }) {
  const { connection, status, synced } = useConnection(page.id);
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="flex pt-3 pb-6">
        {connection && synced ? (
          <PageEditor connection={connection} page={page} bots={bots} pages={pages} sidePanel={null} onCloseSidePanel={() => {}} />
        ) : (
          <p className="px-4 text-sm text-muted-foreground">{status === "missing" ? "This page no longer exists." : "Connecting…"}</p>
        )}
      </div>
      {footer ? <div className="px-4 pb-24">{footer}</div> : <div className="pb-20" />}
    </div>
  );
}
