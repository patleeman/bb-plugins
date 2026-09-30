// The Studio collection: every add-on's items in one list. The panel's
// sub-path is the kind filter, so /plugins/studio/studio/recording is a
// linkable "Recordings" view.
import {
  CollectionPage,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  GHOST_BUTTON,
  Icon,
  OUTLINE_BUTTON,
  PageColumn,
  openAppPath,
  useProjects,
  type ActionResults,
  type CollectionHandlers,
  type CollectionItem,
  type CollectionKind,
  type CollectionTag,
} from "@bb-studio/kit/app";
import { mentionPrompt, STUDIO_REALTIME_CHANNEL, type StudioCreateEventDetail } from "@bb-studio/kit/contract";
import { errorMessage } from "@bb-studio/kit/format";
import { useBbContext, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { ProviderView, rpcContract, SidebarView, TagView } from "../contract";

type Overview = { providers: ProviderView[]; items: CollectionItem[]; tags: TagView[] };
const TIP_DISMISSED_KEY = "studio:sidebar-tip-dismissed";
const REFETCH_DEBOUNCE_MS = 300;

function useOverview(rpc: ReturnType<typeof useRpc<typeof rpcContract>>) {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  // One request at a time; a change during a request fetches once more after.
  const running = useRef(false);
  const again = useRef(false);
  const refetch = useCallback(() => {
    if (running.current) {
      again.current = true;
      return;
    }
    running.current = true;
    rpc
      .call("overview", null)
      .then(
        (result) => {
          setData(result);
          setError(null);
        },
        (cause: unknown) => setError(errorMessage(cause)),
      )
      .finally(() => {
        running.current = false;
        if (again.current) {
          again.current = false;
          refetch();
        }
      });
  }, [rpc]);

  useEffect(() => {
    refetch();
    const onVisible = () => document.visibilityState === "visible" && refetch();
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refetch]);

  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  useRealtime(STUDIO_REALTIME_CHANNEL, () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(refetch, REFETCH_DEBOUNCE_MS);
  });
  return { data, error, refetch, setData };
}

function useSidebar(rpc: ReturnType<typeof useRpc<typeof rpcContract>>) {
  const [sidebar, setSidebar] = useState<SidebarView | null>(null);
  useEffect(() => {
    rpc.call("sidebar", null).then(setSidebar, () => setSidebar(null));
  }, [rpc]);
  const setVisible = useCallback(
    (visible: boolean) =>
      rpc.call("setSidebar", { visible }).then(
        (next) => {
          setSidebar(next);
          toast.success(visible ? "Add-ons are back in the sidebar" : "Add-ons hidden from the sidebar");
        },
        (cause: unknown) => toast.error(`Couldn't change the sidebar: ${errorMessage(cause)}`),
      ),
    [rpc],
  );
  return { sidebar, setVisible };
}

async function perPlugin(items: CollectionItem[], work: (pluginId: string, ids: string[]) => Promise<ActionResults>): Promise<ActionResults> {
  const groups = new Map<string, string[]>();
  for (const item of items) groups.set(item.pluginId, [...(groups.get(item.pluginId) ?? []), item.id]);
  const results = await Promise.all(
    [...groups].map(([pluginId, ids]) =>
      work(pluginId, ids).catch((cause: unknown) => ({ done: [], failed: ids.map((id) => ({ id, error: errorMessage(cause) })) })),
    ),
  );
  return { done: results.flatMap((result) => result.done), failed: results.flatMap((result) => result.failed) };
}

export function StudioPanel({ subPath }: { subPath: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const context = useBbContext();
  const projects = useProjects();
  const { data, error, refetch, setData } = useOverview(rpc);
  const { sidebar, setVisible } = useSidebar(rpc);
  const [tipDismissed, setTipDismissed] = useState(() => {
    try {
      return localStorage.getItem(TIP_DISMISSED_KEY) === "1";
    } catch {
      return false;
    }
  });

  const providers = useMemo(() => data?.providers ?? [], [data]);
  const kinds = useMemo<CollectionKind[]>(
    () => providers.filter((provider) => provider.state === "ready").flatMap((provider) => provider.kinds.map((kind) => ({ ...kind, pluginId: provider.pluginId }))),
    [providers],
  );
  const requested = decodeSegment(subPath.split("/").filter(Boolean)[0] ?? "") || "all";
  const kind = requested === "all" || !data || kinds.some((candidate) => candidate.id === requested) ? requested : "all";
  const setKind = useCallback((next: string) => navigate.toPluginPanel("studio", { subPath: next === "all" ? "" : encodeURIComponent(next) }), [navigate]);
  const nameOf = useCallback((pluginId: string) => providers.find((provider) => provider.pluginId === pluginId)?.name ?? pluginId, [providers]);

  const handlers = useMemo<CollectionHandlers>(
    () => ({
      onOpen: (item) => openAppPath(item.href),
      onCreate: async (target, projectId) => {
        if (!target.create) return;
        if (target.create.mode === "event") {
          // Client-side creation, like starting a Talk recording.
          const event = new CustomEvent<StudioCreateEventDetail>(target.create.event, { detail: { projectId }, cancelable: true });
          window.dispatchEvent(event);
          if (!event.defaultPrevented) toast.error(`${nameOf(target.pluginId)} isn't loaded yet. Reload BB and try again.`);
          return;
        }
        try {
          const { item } = await rpc.call("create", { pluginId: target.pluginId, kind: target.id, projectId });
          openAppPath(item.href);
        } catch (cause) {
          toast.error(`Couldn't create a ${target.label.toLowerCase()}: ${errorMessage(cause)}`);
        }
      },
      onNewThread: (items) => navigate.toCompose({ initialPrompt: mentionPrompt(items), focusPrompt: true }),
      onMove: async (items, projectId) => {
        const result = await perPlugin(items, (pluginId, ids) => rpc.call("move", { pluginId, ids, projectId }));
        refetch();
        return result;
      },
      onArchive: async (items, archived) => {
        const result = await perPlugin(items, (pluginId, ids) => rpc.call("archive", { pluginId, ids, archived }));
        refetch();
        return result;
      },
      onDelete: async (items) => {
        const result = await perPlugin(items, (pluginId, ids) => rpc.call("remove", { pluginId, ids }));
        refetch();
        return result;
      },
      onAction: async (target, action, items) => {
        const result = await rpc.call("action", { pluginId: target.pluginId, action: action.id, ids: items.map((item) => item.id) });
        refetch();
        return result;
      },
      onSearch: async (query) => {
        const { keys, snippets } = await rpc.call("search", { query });
        return new Map(keys.map((key) => [key, snippets[key] ?? null]));
      },
      onTag: async (items, add, remove) => {
        // Show the change now; the refetch confirms it.
        const keys = new Set(items.map((item) => `${item.pluginId}:${item.id}`));
        setData((previous) =>
          previous && {
            ...previous,
            items: previous.items.map((item) =>
              keys.has(`${item.pluginId}:${item.id}`)
                ? { ...item, tags: [...new Set([...(item.tags ?? []), ...add])].filter((id) => !remove.includes(id)) }
                : item,
            ),
          },
        );
        try {
          await rpc.call("tagItems", { items: items.map((item) => ({ pluginId: item.pluginId, id: item.id })), add, remove });
        } finally {
          refetch();
        }
      },
      onCreateTag: async (name): Promise<CollectionTag> => {
        const { tag } = await rpc.call("createTag", { name });
        setData((previous) => previous && { ...previous, tags: previous.tags.some((each) => each.id === tag.id) ? previous.tags : [...previous.tags, tag] });
        return tag;
      },
      onRenameTag: async (tag, name) => {
        await rpc.call("renameTag", { id: tag.id, name });
        refetch();
      },
      onDeleteTag: async (tag) => {
        await rpc.call("deleteTag", { id: tag.id });
        toast.success(`Deleted the tag ${tag.name}`);
        refetch();
      },
    }),
    [nameOf, navigate, refetch, rpc, setData],
  );

  const shownPanels = sidebar?.panels.filter((panel) => panel.visible) ?? [];
  const dismissTip = () => {
    setTipDismissed(true);
    try {
      localStorage.setItem(TIP_DISMISSED_KEY, "1");
    } catch {
      // The tip comes back next session.
    }
  };
  const unavailable = providers.filter((provider) => provider.state !== "ready");

  const notice = (
    <>
      {unavailable.map((provider) => (
        <p key={provider.pluginId} className="mb-2 flex items-center gap-2 text-sm text-muted-foreground">
          <Icon name={provider.state === "outdated" ? "Info" : "AlertTriangle"} className="size-4 shrink-0" />
          {provider.detail ?? `${provider.name} isn't available.`}
        </p>
      ))}
      {shownPanels.length && !tipDismissed && kinds.length ? (
        <div className="flex items-center gap-3 rounded-lg border border-border px-4 py-3 text-sm max-md:flex-wrap">
          <Icon name="PanelLeft" className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            {shownPanels.map((panel) => panel.label).join(", ")} {shownPanels.length === 1 ? "is" : "are"} also in the sidebar.
          </span>
          <button type="button" className={OUTLINE_BUTTON} onClick={() => void setVisible(false).then(dismissTip)}>
            Hide from sidebar
          </button>
          <button type="button" className={GHOST_BUTTON} onClick={dismissTip}>
            Not now
          </button>
        </div>
      ) : null}
    </>
  );

  const headerActions = sidebar?.panels.length ? (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Studio options"
          className="flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground data-[state=open]:bg-state-active"
        >
          <Icon name="MoreHorizontal" className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Add-ons in the sidebar</DropdownMenuLabel>
        {shownPanels.length ? (
          <DropdownMenuItem onSelect={() => void setVisible(false)}>
            <Icon name="EyeOff" className="size-4" /> Hide {sidebar.panels.map((panel) => panel.label).join(", ")}
          </DropdownMenuItem>
        ) : null}
        {shownPanels.length < sidebar.panels.length ? (
          <DropdownMenuItem onSelect={() => void setVisible(true)}>
            <Icon name="Eye" className="size-4" /> Show {sidebar.panels.map((panel) => panel.label).join(", ")}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Add-ons</DropdownMenuLabel>
        {providers.map((provider) => (
          <DropdownMenuItem key={provider.pluginId} disabled className="opacity-100">
            <span className="truncate">{provider.name}</span>
            <span className="ml-auto text-xs text-muted-foreground">{provider.state === "ready" ? "Ready" : provider.state === "outdated" ? "Needs update" : "Offline"}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null;

  if (data && !providers.length) {
    return (
      <PageColumn>
        <h1 className="text-[28px] leading-tight font-semibold tracking-tight">Studio</h1>
        <EmptyState icon="studio/studio" title="No add-ons installed">
          Install one from Extensions.
        </EmptyState>
      </PageColumn>
    );
  }

  return (
    <CollectionPage
      title="Studio"
      kinds={kinds}
      items={data?.items ?? null}
      error={error && !data ? error : null}
      projects={projects}
      defaultProjectId={context.projectId ?? null}
      storageKey="studio:collection"
      tags={data?.tags ?? []}
      kind={kind}
      onKindChange={setKind}
      notice={notice}
      headerActions={headerActions}
      handlers={handlers}
    />
  );
}

/** A path segment, or "" for a malformed one like `100%`. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return "";
  }
}
