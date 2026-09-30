// Studio search: a quick-open box over any page, opened by the "Studio:
// Search" command (Mod+Shift+K). Titles match as you type; content matches
// come from the add-ons, with the text that matched.
import { Highlight, Icon, ItemTile, cn, openAppPath, projectName, useProjects } from "@bb-studio/kit/app";
import { errorMessage, untitled } from "@bb-studio/kit/format";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { ProviderView, rpcContract } from "../contract";
import { QUICK_OPEN_EVENT } from "../ids";
import { studioMatches, type ContentMatches } from "../search";

const CONTENT_DEBOUNCE_MS = 180;
const CONTENT_MIN_CHARS = 2;

/** The overview fields search uses. */
type Item = {
  pluginId: string;
  id: string;
  kind: string;
  title: string;
  icon: string | null;
  projectId: string | null;
  href: string;
  updatedAt: number;
  archived: boolean;
};

/** Mounted on every page; renders only while open. */
export function QuickOpen() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const toggle = () => setOpen((current) => !current);
    window.addEventListener(QUICK_OPEN_EVENT, toggle);
    return () => window.removeEventListener(QUICK_OPEN_EVENT, toggle);
  }, []);
  return open ? <QuickOpenDialog onClose={() => setOpen(false)} /> : null;
}

export function toggleQuickOpen() {
  window.dispatchEvent(new Event(QUICK_OPEN_EVENT));
}

function QuickOpenDialog({ onClose }: { onClose: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const projects = useProjects();
  const [overview, setOverview] = useState<{ items: Item[]; providers: ProviderView[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [content, setContent] = useState<(ContentMatches & { query: string }) | null>(null);
  const [selected, setSelected] = useState(0);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    rpc.call("overview", null).then(setOverview, (cause: unknown) => setError(errorMessage(cause)));
    return () => before?.focus();
  }, [rpc]);

  // Content search trails typing; a reply for an older query is dropped.
  const trimmed = query.trim();
  useEffect(() => {
    if (trimmed.length < CONTENT_MIN_CHARS) return;
    let live = true;
    const timer = setTimeout(() => {
      rpc.call("search", { query: trimmed }).then(
        (found) => live && setContent({ ...found, query: trimmed }),
        () => live && setContent({ keys: [], snippets: {}, query: trimmed }),
      );
    }, CONTENT_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [rpc, trimmed]);

  const current = content?.query === trimmed ? content : null;
  const searching = trimmed.length >= CONTENT_MIN_CHARS && !current;
  const matches = useMemo(() => studioMatches(overview?.items ?? [], query, current), [overview, query, current]);
  const kinds = useMemo(
    () => new Map(overview?.providers.flatMap((provider) => provider.kinds.map((kind) => [`${provider.pluginId}:${kind.id}`, kind])) ?? []),
    [overview],
  );

  useEffect(() => setSelected(0), [query]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const open = (item: Item | undefined) => {
    if (!item) return;
    onClose();
    openAppPath(item.href);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    // Enter confirms an IME candidate; it doesn't open an item.
    if (event.nativeEvent.isComposing) return;
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (step && matches.length) setSelected((index) => (index + step + matches.length) % matches.length);
    else if (event.key === "Enter") open(matches[selected]?.item);
    else if (event.key === "Escape") onClose();
    else return;
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div className="studio-quick-open fixed inset-0 z-50 flex justify-center bg-black/20 px-4 pt-[12vh]" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-label="Search Studio"
        className="flex max-h-[min(34rem,76vh)] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-border px-4">
          <Icon name="Search" className="size-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            role="combobox"
            aria-expanded
            aria-controls="studio-quick-open-list"
            aria-activedescendant={matches.length ? `studio-quick-open-${selected}` : undefined}
            aria-label="Search Studio"
            placeholder="Search Studio titles and content…"
            className="h-12 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
          />
          {searching ? <span className="text-xs text-muted-foreground">Searching content…</span> : null}
        </div>
        <div ref={list} id="studio-quick-open-list" role="listbox" aria-label="Studio items" className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {!trimmed && matches.length ? <p className="px-2.5 pt-1.5 pb-1 text-xs font-medium text-muted-foreground">Recently changed</p> : null}
          {matches.map(({ item, snippet }, index) => {
            const kind = kinds.get(`${item.pluginId}:${item.kind}`);
            return (
              <div
                key={`${item.pluginId}:${item.id}`}
                id={`studio-quick-open-${index}`}
                data-index={index}
                role="option"
                aria-selected={index === selected}
                className={cn(
                  "studio-quick-open-row flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2",
                  index === selected && "bg-state-hover",
                )}
                onMouseMove={() => setSelected(index)}
                onClick={() => open(item)}
              >
                <ItemTile icon={item.icon} kindIcon={kind?.icon ?? "File"} size="md" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="truncate text-sm font-medium">
                      <Highlight text={untitled(item.title)} query={trimmed} />
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {kind?.label ?? item.kind}
                      {item.projectId ? ` · ${projectName(projects, item.projectId)}` : ""}
                    </span>
                  </div>
                  {snippet ? (
                    <p className="studio-quick-open-snippet truncate text-xs text-muted-foreground">
                      <Highlight text={snippet} query={trimmed} />
                    </p>
                  ) : null}
                </div>
              </div>
            );
          })}
          {overview && !matches.length ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              {!trimmed ? "Nothing in Studio yet." : searching ? "No titles match. Searching content…" : "Nothing in Studio matches."}
            </p>
          ) : null}
          {!overview && !error ? <p className="px-3 py-6 text-center text-sm text-muted-foreground">Loading Studio…</p> : null}
          {error ? <p className="px-3 py-6 text-center text-sm text-destructive">{error}</p> : null}
        </div>
        <div className="flex gap-4 border-t border-border px-4 py-2 text-xs text-muted-foreground">
          <span>↑↓ to move</span>
          <span>↵ to open</span>
          <span>esc to close</span>
        </div>
      </div>
    </div>
  );
}
