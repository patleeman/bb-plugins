// The Studio section of the sidebar: a tab for each Studio item the user has
// opened, from any add-on. Opening an item's view adds its tab; × closes it,
// and closing the one on screen opens the next.
import {
  DropdownMenuItem,
  Icon,
  SIDEBAR_ROW,
  SIDEBAR_ROW_SELECTED,
  SidebarDisplayMenuItems,
  SidebarGroupHeading,
  SidebarNote,
  SidebarPortal,
  SidebarSection,
  cn,
  openAppPath,
  studioPath,
  useSidebarDisplay,
  useSidebarHosted,
  useSidebarNavigated,
  usePathname,
} from "@bb-studio/kit/app";
import { STUDIO_REALTIME_CHANNEL } from "@bb-studio/kit/contract";
import { errorMessage } from "@bb-studio/kit/format";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useRef, useState } from "react";
import type { rpcContract, TabView } from "../contract";
import { TABS_CHANNEL } from "../ids";
import { itemAtPath } from "../tabs";

const REFETCH_DEBOUNCE_MS = 300;
const APP_NAMES: Record<string, string> = {
  pages: "Pages",
  talk: "Talk",
  excalidraw: "Drawings",
  artifacts: "Artifacts",
  "studio-tasks": "Tasks",
  "bot-teams": "Bots",
};

function useTabs(enabled: boolean) {
  const rpc = useRpc<typeof rpcContract>();
  const [tabs, setTabs] = useState<TabView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    rpc.call("tabs", null).then(
      (result) => {
        setTabs(result.tabs);
        setError(null);
      },
      (cause: unknown) => setError(errorMessage(cause)),
    );
  }, [rpc]);
  useEffect(() => {
    if (enabled) refetch();
  }, [enabled, refetch]);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const soon = () => {
    if (!enabled) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(refetch, REFETCH_DEBOUNCE_MS);
  };
  useRealtime(TABS_CHANNEL, soon);
  // Titles change and items go away.
  useRealtime(STUDIO_REALTIME_CHANNEL, soon);
  return { tabs, setTabs, error, refetch, rpc };
}

export function SidebarTabs() {
  const hosted = useSidebarHosted();
  const path = usePathname();
  const { tabs, setTabs, error, refetch, rpc } = useTabs(hosted);
  const navigated = useSidebarNavigated();
  const [display, setDisplay] = useSidebarDisplay(
    "studio:sidebar-tabs-display",
    { organization: "none", sort: "opened", direction: "ascending" },
    { organization: ["none", "app"], sort: ["opened", "alpha"] },
  );

  // Visiting an item's view opens its tab.
  const visited = useRef<string | null>(null);
  useEffect(() => {
    if (!hosted || visited.current === path) return;
    visited.current = path;
    if (!path.startsWith("/plugins/") || (tabs && itemAtPath(tabs, path))) return;
    rpc.call("visitTab", { path }).then(
      ({ tab }) => {
        if (tab) setTabs((current) => (current && !current.some((each) => each.pluginId === tab.pluginId && each.id === tab.id) ? [...current, tab] : current));
      },
      // Try again the next time this effect runs, e.g. when the tabs refresh.
      () => {
        if (visited.current === path) visited.current = null;
      },
    );
  }, [hosted, path, tabs, rpc, setTabs]);

  const active = tabs ? itemAtPath(tabs, path) : null;
  const open = (tab: TabView) => {
    openAppPath(tab.href);
    navigated();
  };
  const close = (closing: readonly TabView[]) => {
    if (!tabs || !closing.length) return;
    const gone = new Set(closing.map((tab) => `${tab.pluginId}:${tab.id}`));
    const left = tabs.filter((tab) => !gone.has(`${tab.pluginId}:${tab.id}`));
    if (active && gone.has(`${active.pluginId}:${active.id}`)) {
      // The next tab, or the one before when it was last.
      const index = tabs.indexOf(active);
      const next = tabs.slice(index + 1).find((tab) => !gone.has(`${tab.pluginId}:${tab.id}`)) ?? [...tabs.slice(0, index)].reverse().find((tab) => !gone.has(`${tab.pluginId}:${tab.id}`));
      openAppPath(next?.href ?? studioPath());
    }
    setTabs(left);
    rpc.call("closeTabs", { items: closing.map((tab) => ({ pluginId: tab.pluginId, id: tab.id })) }).then(undefined, refetch);
  };

  const sorted = [...(tabs ?? [])];
  if (display.sort === "alpha") sorted.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
  if (display.direction === "descending") sorted.reverse();
  const groups =
    display.organization === "app"
      ? [...new Set(sorted.map((tab) => tab.pluginId))].map((pluginId) => ({ label: APP_NAMES[pluginId] ?? pluginId, tabs: sorted.filter((tab) => tab.pluginId === pluginId) }))
      : [{ label: null, tabs: sorted }];

  return (
    <SidebarPortal id="tabs" title="Studio" order={0}>
      <SidebarSection
        title="Studio"
        actions={[{ label: "Open Studio", icon: "studio/studio", onClick: () => (openAppPath(studioPath()), navigated()) }]}
        menu={
          <>
            <SidebarDisplayMenuItems
              noun="tabs"
              display={display}
              onChange={setDisplay}
              organize={[
                ["none", "No grouping"],
                ["app", "By app"],
              ]}
              sort={[
                ["opened", "Opened", "ascending"],
                ["alpha", "Alphabetical", "ascending"],
              ]}
            />
            {active && tabs && tabs.length > 1 ? (
              <DropdownMenuItem onSelect={() => close(tabs.filter((tab) => tab !== active))}>
                <Icon name="X" />
                Close other tabs
              </DropdownMenuItem>
            ) : null}
            {tabs?.length ? (
              <DropdownMenuItem onSelect={() => close(tabs)}>
                <Icon name="X" />
                Close all tabs
              </DropdownMenuItem>
            ) : null}
          </>
        }
      >
        {error && !tabs ? <SidebarNote tone="danger">{error}</SidebarNote> : null}
        {tabs && !tabs.length ? <SidebarNote>Pages, drawings and recordings you open show here.</SidebarNote> : null}
        {groups.map((group) => (
          <div key={group.label ?? "all"} className="flex flex-col gap-px">
            {group.label ? <SidebarGroupHeading>{group.label}</SidebarGroupHeading> : null}
            {group.tabs.map((tab) => (
              <TabRow key={`${tab.pluginId}:${tab.id}`} tab={tab} selected={tab === active} onOpen={() => open(tab)} onClose={() => close([tab])} />
            ))}
          </div>
        ))}
      </SidebarSection>
    </SidebarPortal>
  );
}

function TabRow({ tab, selected, onOpen, onClose }: { tab: TabView; selected: boolean; onOpen(): void; onClose(): void }) {
  return (
    <div className="group/tab relative" data-studio-tab={`${tab.pluginId}:${tab.id}`}>
      <a
        href={tab.href}
        aria-current={selected ? "page" : undefined}
        className={cn(SIDEBAR_ROW, "pr-8", selected && SIDEBAR_ROW_SELECTED)}
        onClick={(event) => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          onOpen();
        }}
        onAuxClick={(event) => {
          // Middle-click closes, as in a browser.
          if (event.button !== 1) return;
          event.preventDefault();
          onClose();
        }}
      >
        <span className="flex size-4 shrink-0 items-center justify-center text-subtle-foreground">
          {tab.icon ? <span className="text-sm leading-none">{tab.icon}</span> : <Icon name={tab.kindIcon} className="size-4" />}
        </span>
        <span className="min-w-0 flex-1 truncate">{tab.title}</span>
      </a>
      <button
        type="button"
        aria-label={`Close ${tab.title}`}
        title="Close tab"
        className={cn(
          "absolute top-1/2 right-0.5 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-subtle-foreground opacity-0 outline-none hover:bg-state-hover hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-sidebar-ring group-hover/tab:opacity-100 pointer-coarse:opacity-100",
          selected && "opacity-100",
        )}
        onClick={onClose}
      >
        <Icon name="X" className="size-3.5" />
      </button>
    </div>
  );
}
