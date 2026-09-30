// The Studio collection: one searchable, filterable list or grid of items of
// any kind. Studio renders it for every installed add-on; an add-on renders
// it alone for its own kind when Studio isn't installed.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import type { StudioAction } from "../contract";
import { errorMessage, plural, relativeTime, untitled } from "../format";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Icon } from "../ui/icon";
import { cn } from "../ui/utils";
import {
  Badge,
  Checkbox,
  DANGER_BUTTON,
  EmptyState,
  GHOST_BUTTON,
  Highlight,
  ItemTile,
  OUTLINE_BUTTON,
  PageColumn,
  PILL,
  PRIMARY_BUTTON,
  projectName,
  THUMBNAIL,
  type Project,
} from "./pieces";
import {
  DEFAULT_SORT,
  itemKey,
  nextSort,
  sortItems,
  toggleSelection,
  type ActionResults,
  type CollectionItem,
  type CollectionKind,
  type Sort,
  type SortKey,
} from "./selection";
import { TagChips, TagDot, TagMenuItems, TagNameInput, type CollectionTag } from "./tags";

export type { CollectionTag } from "./tags";
export { itemKey, sortItems, toggleSelection, type ActionResults, type CollectionItem, type CollectionKind, type Sort } from "./selection";

export interface CollectionHandlers {
  onOpen(item: CollectionItem): void;
  onCreate(kind: CollectionKind, projectId: string | null): Promise<void> | void;
  onNewThread(items: CollectionItem[]): void;
  onMove(items: CollectionItem[], projectId: string | null): Promise<ActionResults>;
  onArchive(items: CollectionItem[], archived: boolean): Promise<ActionResults>;
  onDelete(items: CollectionItem[]): Promise<ActionResults>;
  onAction(kind: CollectionKind, action: StudioAction, items: CollectionItem[]): Promise<{ message: string | null; text: string | null }>;
  /** Item keys whose content matches, beyond title matches, each with the text that matched if known. */
  onSearch?(query: string): Promise<ReadonlyMap<string, string | null>>;
  /** Tagging, when the collection has `tags`. */
  onTag?(items: CollectionItem[], add: string[], remove: string[]): Promise<void>;
  /** Makes a tag, or returns the one with this name. */
  onCreateTag?(name: string): Promise<CollectionTag>;
  onRenameTag?(tag: CollectionTag, name: string): Promise<void>;
  onDeleteTag?(tag: CollectionTag): Promise<void>;
}

type View = "list" | "grid";
const ALL = "all";
const GLOBAL = "global";
const UNTAGGED = "untagged";

function useStoredState<T extends string>(key: string, fallback: T, allowed?: readonly T[]): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key) as T | null;
      return stored !== null && (!allowed || allowed.includes(stored)) ? stored : fallback;
    } catch {
      return fallback;
    }
  });
  const set = useCallback(
    (next: T) => {
      setValue(next);
      try {
        localStorage.setItem(key, next);
      } catch {
        // Private windows can refuse storage; the choice lasts this session.
      }
    },
    [key],
  );
  return [value, set];
}

/**
 * Copies text that is still being fetched. Handing the clipboard a promise
 * keeps the click's permission in Safari, which drops it after an await.
 */
function copyLater(text: Promise<string>): Promise<void> {
  if (typeof ClipboardItem === "undefined") return text.then((value) => navigator.clipboard.writeText(value));
  return navigator.clipboard.write([new ClipboardItem({ "text/plain": text.then((value) => new Blob([value], { type: "text/plain" })) })]);
}

function reportResults(results: ActionResults, verb: string, noun = "item") {
  if (results.done.length) toast.success(`${verb} ${plural(results.done.length, noun)}`);
  if (results.failed.length) toast.error(`Couldn't ${verb.toLowerCase()} ${plural(results.failed.length, noun)}: ${results.failed[0]!.error}`);
}

export function CollectionPage({
  title,
  kinds,
  items,
  error,
  projects,
  defaultProjectId,
  storageKey,
  tags,
  kind: kindFilter,
  onKindChange,
  isSelectable,
  notice,
  headerActions,
  handlers,
}: {
  title: string;
  kinds: readonly CollectionKind[];
  /** null while loading. */
  items: readonly CollectionItem[] | null;
  error?: string | null;
  projects: readonly Project[];
  /** Where new items go when the filter doesn't pick a project. */
  defaultProjectId: string | null;
  /** Prefix for remembered view and filter choices. */
  storageKey: string;
  /** Every tag, or undefined when the collection has no tags. */
  tags?: readonly CollectionTag[];
  /** The kind filter; "all" or a kind id. */
  kind: string;
  onKindChange(kind: string): void;
  /** Items that can't be picked, with the reason shown on hover. */
  isSelectable?(item: CollectionItem): true | string;
  /** Shown under the header, e.g. a one-time tip. */
  notice?: ReactNode;
  /** Extra buttons beside New, e.g. a settings menu. */
  headerActions?: ReactNode;
  handlers: CollectionHandlers;
}) {
  const [query, setQuery] = useState("");
  const [project, setProject] = useStoredState<string>(`${storageKey}:project`, ALL);
  const [view, setView] = useStoredState<View>(`${storageKey}:view`, "list", ["list", "grid"]);
  const [tagFilter, setTagFilter] = useStoredState<string>(`${storageKey}:tag`, ALL);
  const [renaming, setRenaming] = useState(false);
  const [archived, setArchived] = useState(false);
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT);
  const [contentMatches, setContentMatches] = useState<ReadonlyMap<string, string | null>>(() => new Map());
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [working, setWorking] = useState(false);
  const anchor = useRef<string | null>(null);

  const kindById = useMemo(() => new Map(kinds.map((kind) => [`${kind.pluginId}:${kind.id}`, kind])), [kinds]);
  const kindOf = useCallback((item: CollectionItem) => kindById.get(`${item.pluginId}:${item.kind}`), [kindById]);
  const activeKind = kindFilter === ALL ? null : (kinds.find((kind) => kind.id === kindFilter) ?? null);
  const single = kinds.length === 1 ? kinds[0]! : activeKind;
  const canArchive = kinds.some((kind) => kind.canArchive);
  const projectLabel = useCallback((item: CollectionItem) => projectName(projects, item.projectId), [projects]);
  const kindLabel = useCallback((item: CollectionItem) => kindOf(item)?.label ?? item.kind, [kindOf]);

  // A project that no longer exists falls back to every project.
  useEffect(() => {
    if (project !== ALL && project !== GLOBAL && projects.length && !projects.some((candidate) => candidate.id === project)) setProject(ALL);
  }, [project, projects, setProject]);
  const tagging = tags !== undefined && handlers.onTag !== undefined;
  const tagById = useMemo(() => new Map((tags ?? []).map((tag) => [tag.id, tag])), [tags]);
  const activeTag = tagById.get(tagFilter) ?? null;
  // A deleted tag falls back to every item.
  useEffect(() => {
    if (tags && tagFilter !== ALL && tagFilter !== UNTAGGED && !tagById.has(tagFilter)) setTagFilter(ALL);
  }, [tags, tagById, tagFilter, setTagFilter]);
  // Sorting by a column the new filter doesn't show would be invisible.
  useEffect(() => {
    if (sort.key.startsWith("fact:") && !single?.columns.some((column) => `fact:${column.id}` === sort.key)) setSort(DEFAULT_SORT);
    if (sort.key === "kind" && single) setSort(DEFAULT_SORT);
  }, [single, sort.key]);

  const { onSearch } = handlers;
  useEffect(() => {
    const text = query.trim();
    if (!text || !onSearch) {
      setContentMatches(new Map());
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      onSearch(text).then(
        (keys) => live && setContentMatches(keys),
        () => {},
      );
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [onSearch, query]);

  const byKey = useMemo(() => new Map((items ?? []).map((item) => [itemKey(item), item])), [items]);
  const shown = useMemo(() => {
    const text = query.trim().toLowerCase();
    const filtered = (items ?? []).filter(
      (item) =>
        item.archived === archived &&
        (kindFilter === ALL || item.kind === kindFilter) &&
        (project === ALL ? true : project === GLOBAL ? !item.projectId : item.projectId === project) &&
        (!tagging || tagFilter === ALL || (tagFilter === UNTAGGED ? !item.tags?.length : !!item.tags?.includes(tagFilter))) &&
        (!text || untitled(item.title).toLowerCase().includes(text) || contentMatches.has(itemKey(item))),
    );
    return sortItems(filtered, sort, { kindLabel, projectLabel });
  }, [items, archived, kindFilter, project, tagging, tagFilter, query, contentMatches, sort, kindLabel, projectLabel]);

  const selectable = useCallback((item: CollectionItem) => (isSelectable ? isSelectable(item) : true), [isSelectable]);
  const selectableKeys = useMemo(() => shown.filter((item) => selectable(item) === true).map(itemKey), [shown, selectable]);
  const chosen = useMemo(() => shown.filter((item) => selected.has(itemKey(item)) && selectable(item) === true), [shown, selected, selectable]);
  // Forget picks that were deleted, filtered out, or became unpickable.
  useEffect(() => {
    setSelected((previous) => {
      const visible = new Set(selectableKeys);
      const next = new Set([...previous].filter((key) => visible.has(key)));
      return next.size === previous.size ? previous : next;
    });
  }, [selectableKeys]);
  useEffect(() => setConfirmDelete(false), [selected]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) setSelected(new Set());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const toggle = (item: CollectionItem, range: boolean) => {
    const key = itemKey(item);
    setSelected((previous) => toggleSelection(previous, selectableKeys, key, { range, anchor: anchor.current }));
    anchor.current = key;
  };
  const allChecked = chosen.length > 0 && chosen.length === selectableKeys.length;
  const clear = () => setSelected(new Set());

  const run = (work: () => Promise<unknown>) => {
    setWorking(true);
    void work()
      .catch((cause: unknown) => toast.error(errorMessage(cause)))
      .finally(() => setWorking(false));
  };
  const move = (targets: CollectionItem[], projectId: string | null) =>
    run(async () => reportResults(await handlers.onMove(targets, projectId), "Moved"));
  const archive = (targets: CollectionItem[], value: boolean) =>
    run(async () => reportResults(await handlers.onArchive(targets, value), value ? "Archived" : "Restored"));
  const remove = (targets: CollectionItem[]) =>
    run(async () => {
      reportResults(await handlers.onDelete(targets), "Deleted");
      clear();
    });
  const act = (kind: CollectionKind, action: StudioAction, targets: CollectionItem[]) => {
    if (action.result === "copy") {
      // The clipboard write must start inside the click.
      const result = handlers.onAction(kind, action, targets);
      setWorking(true);
      copyLater(result.then((value) => value.text ?? ""))
        .then(
          () =>
            result.then((value) =>
              value.text ? toast.success(value.message ?? "Copied") : toast.info(value.message ?? "Nothing to copy"),
            ),
          (cause: unknown) => toast.error(errorMessage(cause)),
        )
        .finally(() => setWorking(false));
      return;
    }
    run(async () => {
      const result = await handlers.onAction(kind, action, targets);
      if (result.message) toast.success(result.message);
    });
  };

  const tag = (targets: CollectionItem[], add: string[], remove: string[]) =>
    run(async () => {
      await handlers.onTag?.(targets, add, remove);
    });
  const createTag = (targets: CollectionItem[], name: string) =>
    run(async () => {
      if (!handlers.onCreateTag) return;
      const created = await handlers.onCreateTag(name);
      if (targets.length) await handlers.onTag?.(targets, [created.id], []);
    });
  const tagState = (targets: readonly CollectionItem[]) => (candidate: CollectionTag) => {
    const count = targets.filter((item) => item.tags?.includes(candidate.id)).length;
    return count === 0 ? false : count === targets.length ? true : ("mixed" as const);
  };
  const tagMenu = (targets: CollectionItem[]) => (
    <TagMenuItems
      tags={tags ?? []}
      state={tagState(targets)}
      onToggle={(candidate, add) => tag(targets, add ? [candidate.id] : [], add ? [] : [candidate.id])}
      onCreate={(name) => createTag(targets, name)}
    />
  );
  const pickTag = useCallback((candidate: CollectionTag) => setTagFilter(candidate.id), [setTagFilter]);

  // New items land in the filtered project, else the one BB has open.
  const newProject = project === GLOBAL ? null : project === ALL ? defaultProjectId : project;
  const creatable = kinds.filter((kind) => kind.create);
  const createTargets = activeKind ? creatable.filter((kind) => kind.id === activeKind.id) : creatable;
  const newButton = (className = PRIMARY_BUTTON) =>
    createTargets.length === 0 ? null : createTargets.length === 1 ? (
      <button type="button" className={className} onClick={() => void handlers.onCreate(createTargets[0]!, newProject)}>
        <Icon name="Plus" /> New {createTargets[0]!.label.toLowerCase()}
      </button>
    ) : (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className={className}>
            <Icon name="Plus" /> New <Icon name="ChevronDown" className="-mr-1 opacity-70" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          {createTargets.map((kind) => (
            <DropdownMenuItem key={`${kind.pluginId}:${kind.id}`} onSelect={() => void handlers.onCreate(kind, newProject)}>
              <Icon name={kind.icon} className="size-4" /> {kind.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    );

  const projectItems = (current: string | null | undefined, onPick: (projectId: string | null) => void) => (
    <>
      <DropdownMenuItem onSelect={() => onPick(null)}>
        Global
        {current === null ? <Icon name="Check" className="ml-auto size-3.5" /> : null}
      </DropdownMenuItem>
      {projects.length ? <DropdownMenuSeparator /> : null}
      {projects.map((candidate) => (
        <DropdownMenuItem key={candidate.id} onSelect={() => onPick(candidate.id)}>
          <span className="truncate">{candidate.name}</span>
          {candidate.id === current ? <Icon name="Check" className="ml-auto size-3.5" /> : null}
        </DropdownMenuItem>
      ))}
    </>
  );

  const rowMenu = (item: CollectionItem, triggerClassName: string) => {
    const kind = kindOf(item);
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label="Actions" className={triggerClassName} onClick={(event) => event.stopPropagation()}>
            <Icon name="MoreHorizontal" className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56" onClick={(event) => event.stopPropagation()}>
          <DropdownMenuItem onSelect={() => handlers.onOpen(item)}>
            <Icon name="ArrowUpRight" className="size-4" /> Open
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => handlers.onNewThread([item])}>
            <Icon name="MessageSquarePlus" className="size-4" /> New thread with this
          </DropdownMenuItem>
          {kind?.actions.map((action) => (
            <DropdownMenuItem key={action.id} onSelect={() => act(kind, action, [item])}>
              <Icon name={action.icon} className="size-4" /> {action.label.replace("{count}", "1")}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Icon name="Folder" className="size-4" /> Move to project
              <Icon name="ChevronRight" className="ml-auto size-3.5 text-muted-foreground" />
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-80 w-52 overflow-auto">
              {projectItems(item.projectId, (projectId) => move([item], projectId))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          {tagging ? (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Icon name="studio/tag" className="size-4" /> Tags
                <Icon name="ChevronRight" className="ml-auto size-3.5 text-muted-foreground" />
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-80 w-56 overflow-auto">{tagMenu([item])}</DropdownMenuSubContent>
            </DropdownMenuSub>
          ) : null}
          {kind?.canArchive ? (
            <DropdownMenuItem onSelect={() => archive([item], !item.archived)}>
              <Icon name="Archive" className="size-4" /> {item.archived ? "Restore from archive" : "Archive"}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-destructive focus:bg-destructive/15 focus:text-destructive"
            onSelect={() => {
              if (!window.confirm(`Delete "${untitled(item.title)}"? This can't be undone.`)) return;
              remove([item]);
            }}
          >
            <Icon name="Trash2" className="size-4" /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  };
  const revealClass =
    "rounded-md p-1 text-muted-foreground opacity-0 group-hover/row:opacity-100 [@media(hover:none)]:opacity-100 hover:bg-state-hover hover:text-foreground focus-visible:opacity-100 data-[state=open]:opacity-100";

  const parentLine = (item: CollectionItem) => {
    const parent = item.parentId ? byKey.get(`${item.pluginId}:${item.parentId}`) : undefined;
    return parent ? `in ${parent.icon ? `${parent.icon} ` : ""}${untitled(parent.title)}` : null;
  };
  const selectionLabel = (item: CollectionItem) => {
    const verdict = selectable(item);
    return verdict === true ? undefined : verdict;
  };

  // Bulk actions: shared ones, then a kind's own when every pick is that kind.
  const chosenKinds = [...new Set(chosen.map((item) => `${item.pluginId}:${item.kind}`))];
  const chosenKind = chosenKinds.length === 1 ? kindById.get(chosenKinds[0]!) : undefined;
  const allArchivable = chosen.length > 0 && chosen.every((item) => kindOf(item)?.canArchive);

  const columns = single?.columns ?? [];
  const showKind = !single;
  const gridTemplate = { gridTemplateColumns: `28px minmax(0,1fr)${showKind ? " 110px" : ""} minmax(0,160px)${columns.map(() => " 90px").join("")} 130px` };

  const header = (label: string, key: SortKey | null, className?: string) => {
    const active = key !== null && sort.key === key;
    return (
      <span role="columnheader" aria-sort={active ? (sort.descending ? "descending" : "ascending") : undefined} className={className}>
        {key ? (
          <button
            type="button"
            className={cn("inline-flex items-center gap-1 hover:text-foreground", active && "text-foreground")}
            onClick={() => setSort(nextSort(sort, key))}
          >
            {label}
            {active ? <Icon name={sort.descending ? "ArrowDown" : "ArrowUp"} className="size-3" /> : null}
          </button>
        ) : (
          label
        )}
      </span>
    );
  };

  const emptyKinds = activeKind ? [activeKind] : kinds;
  const noItemsAtAll = items !== null && !(items ?? []).some((item) => !item.archived);
  const subtitle = (item: CollectionItem) =>
    [showKind ? kindLabel(item) : null, projectLabel(item), relativeTime(item.updatedAt)].filter(Boolean).join(" · ");
  // While searching, an item that matched on content shows the text that matched.
  const preview = (item: CollectionItem, className: string) => {
    const text = query.trim();
    const snippet = text ? contentMatches.get(itemKey(item)) : null;
    if (!snippet && !item.preview) return null;
    return (
      <div className={cn("text-xs text-muted-foreground", className)} data-snippet={snippet ? "" : undefined}>
        {snippet ? <Highlight text={snippet} query={text} /> : item.preview}
      </div>
    );
  };

  return (
    <PageColumn>
      <h1 className="text-[28px] leading-tight font-semibold tracking-tight">{title}</h1>
      <div className="mt-6 flex items-center gap-2">
        <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-background px-3 text-sm focus-within:border-foreground/30 md:max-w-sm">
          <Icon name="Search" className="size-4 shrink-0 text-muted-foreground" />
          <input
            aria-label={`Search ${title.toLowerCase()}`}
            placeholder="Search"
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query) {
                event.preventDefault();
                setQuery("");
              }
            }}
          />
          {query ? (
            <button type="button" aria-label="Clear search" className="text-muted-foreground hover:text-foreground" onClick={() => setQuery("")}>
              <Icon name="X" className="size-3.5" />
            </button>
          ) : null}
        </label>
        <div className="ml-auto flex items-center gap-2">
          <div className="flex rounded-md border border-border p-0.5 max-md:hidden" role="group" aria-label="Layout">
            {(["list", "grid"] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-label={option === "list" ? "List view" : "Grid view"}
                aria-pressed={view === option}
                className="flex size-7 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground aria-pressed:bg-state-active aria-pressed:text-foreground"
                onClick={() => setView(option)}
              >
                <Icon name={option === "list" ? "ListView" : "GridView"} className="size-4" />
              </button>
            ))}
          </div>
          {headerActions}
          {newButton()}
        </div>
      </div>

      {notice ? <div className="mt-4">{notice}</div> : null}

      <div
        role="toolbar"
        aria-label={chosen.length ? "Selected items" : "Filters"}
        className="sticky top-0 z-10 -mx-2 mt-4 flex min-h-11 flex-wrap items-center gap-1.5 bg-background px-2 py-1.5 max-md:-mx-4 max-md:flex-nowrap max-md:overflow-x-auto max-md:px-4"
      >
        {chosen.length ? (
          <>
            <span className="mr-1 shrink-0 text-sm font-medium">{chosen.length} selected</span>
            <button type="button" className={OUTLINE_BUTTON} disabled={working} onClick={() => handlers.onNewThread(chosen)}>
              <Icon name="MessageSquarePlus" /> New thread
            </button>
            {chosenKind?.actions.map((action) => (
              <button key={action.id} type="button" className={OUTLINE_BUTTON} disabled={working} onClick={() => act(chosenKind, action, chosen)}>
                <Icon name={action.icon} /> {action.label.replace("{count}", String(chosen.length))}
              </button>
            ))}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" className={OUTLINE_BUTTON} disabled={working}>
                  <Icon name="Folder" /> Move <Icon name="ChevronDown" className="-mr-1 opacity-70" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-80 w-56 overflow-auto">
                <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Move {plural(chosen.length, "item")} to</DropdownMenuLabel>
                {projectItems(undefined, (projectId) => move(chosen, projectId))}
              </DropdownMenuContent>
            </DropdownMenu>
            {tagging ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" className={OUTLINE_BUTTON} disabled={working}>
                    <Icon name="studio/tag" className="size-4" /> Tag <Icon name="ChevronDown" className="-mr-1 opacity-70" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="max-h-80 w-56 overflow-auto">
                  <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Tag {plural(chosen.length, "item")}</DropdownMenuLabel>
                  {tagMenu(chosen)}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
            {allArchivable ? (
              <button type="button" className={OUTLINE_BUTTON} disabled={working} onClick={() => archive(chosen, !archived)}>
                <Icon name="Archive" /> {archived ? "Restore" : "Archive"}
              </button>
            ) : null}
            <button
              type="button"
              className={confirmDelete ? DANGER_BUTTON : OUTLINE_BUTTON}
              disabled={working}
              onBlur={() => setConfirmDelete(false)}
              onClick={() => (confirmDelete ? remove(chosen) : setConfirmDelete(true))}
            >
              <Icon name="Trash2" /> {confirmDelete ? `Delete ${chosen.length} for good` : "Delete"}
            </button>
            <button type="button" className={cn(GHOST_BUTTON, "ml-auto")} onClick={clear}>
              Clear
            </button>
          </>
        ) : (
          <>
            {kinds.length > 1 ? (
              <>
                <button type="button" aria-pressed={kindFilter === ALL} className={PILL} onClick={() => onKindChange(ALL)}>
                  All
                </button>
                {kinds.map((kind) => (
                  <button
                    key={`${kind.pluginId}:${kind.id}`}
                    type="button"
                    aria-pressed={kindFilter === kind.id}
                    className={PILL}
                    onClick={() => onKindChange(kind.id)}
                  >
                    {kind.plural}
                  </button>
                ))}
                <span className="mx-1 h-4 w-px shrink-0 bg-border" />
              </>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="Filter by project"
                  className="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border px-3 text-sm text-muted-foreground hover:bg-state-hover hover:text-foreground data-[state=open]:bg-state-active"
                >
                  <Icon name="Folder" className="size-3.5" />
                  <span className="max-w-40 truncate">{project === ALL ? "All projects" : project === GLOBAL ? "Global" : projectName(projects, project)}</span>
                  <Icon name="ChevronDown" className="size-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-80 w-56 overflow-auto">
                <DropdownMenuItem onSelect={() => setProject(ALL)}>
                  All projects
                  {project === ALL ? <Icon name="Check" className="ml-auto size-3.5" /> : null}
                </DropdownMenuItem>
                {projectItems(project === ALL ? undefined : project === GLOBAL ? null : project, (projectId) => setProject(projectId ?? GLOBAL))}
              </DropdownMenuContent>
            </DropdownMenu>
            {tagging ? (
              <DropdownMenu onOpenChange={(open) => !open && setRenaming(false)}>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label="Filter by tag"
                    className="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border px-3 text-sm text-muted-foreground hover:bg-state-hover hover:text-foreground data-[state=open]:bg-state-active"
                  >
                    {activeTag ? <TagDot color={activeTag.color} /> : <Icon name="studio/tag" className="size-3.5" />}
                    <span className="max-w-40 truncate">{activeTag ? activeTag.name : tagFilter === UNTAGGED ? "Untagged" : "All tags"}</span>
                    <Icon name="ChevronDown" className="size-3.5" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="max-h-96 w-56 overflow-auto">
                  {renaming && activeTag ? (
                    <TagNameInput
                      placeholder="Tag name"
                      initial={activeTag.name}
                      onSubmit={(name) => {
                        setRenaming(false);
                        run(async () => handlers.onRenameTag?.(activeTag, name));
                      }}
                    />
                  ) : (
                    <>
                      <DropdownMenuItem onSelect={() => setTagFilter(ALL)}>
                        All tags
                        {tagFilter === ALL ? <Icon name="Check" className="ml-auto size-3.5" /> : null}
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => setTagFilter(UNTAGGED)}>
                        Untagged
                        {tagFilter === UNTAGGED ? <Icon name="Check" className="ml-auto size-3.5" /> : null}
                      </DropdownMenuItem>
                      {tags!.length ? <DropdownMenuSeparator /> : null}
                      {tags!.map((candidate) => (
                        <DropdownMenuItem key={candidate.id} onSelect={() => setTagFilter(candidate.id)}>
                          <TagDot color={candidate.color} />
                          <span className="truncate">{candidate.name}</span>
                          {candidate.id === tagFilter ? <Icon name="Check" className="ml-auto size-3.5" /> : null}
                        </DropdownMenuItem>
                      ))}
                      {!tags!.length ? (
                        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Select items and pick Tag to group them.</DropdownMenuLabel>
                      ) : null}
                      {activeTag ? (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onSelect={(event) => {
                              event.preventDefault();
                              setRenaming(true);
                            }}
                          >
                            <Icon name="Edit" className="size-4" /> Rename {activeTag.name}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="text-destructive focus:bg-destructive/15 focus:text-destructive"
                            onSelect={() => {
                              if (!window.confirm(`Delete the tag "${activeTag.name}"? Its items stay; they just lose the tag.`)) return;
                              run(async () => handlers.onDeleteTag?.(activeTag));
                            }}
                          >
                            <Icon name="Trash2" className="size-4" /> Delete {activeTag.name}
                          </DropdownMenuItem>
                        </>
                      ) : null}
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
            {canArchive ? (
              <button type="button" aria-pressed={archived} className={cn(PILL, "flex items-center gap-1.5")} onClick={() => setArchived(!archived)}>
                <Icon name="Archive" className="size-3.5" /> Archived
              </button>
            ) : null}
            {items !== null && shown.length ? (
              <span className="ml-auto shrink-0 pl-2 text-xs text-muted-foreground">{plural(shown.length, "item")}</span>
            ) : null}
          </>
        )}
      </div>

      <div className="mt-3">
        {error ? <p className="py-2 text-sm text-destructive">{error}</p> : null}
        {items === null && !error ? <p className="py-2 text-sm text-muted-foreground">Loading…</p> : null}
        {items !== null && noItemsAtAll && !archived ? (
          <EmptyState icon={emptyKinds.length === 1 ? emptyKinds[0]!.icon : "Layers"} title={`No ${(activeKind?.plural ?? (kinds.length === 1 ? kinds[0]!.plural : "items")).toLowerCase()} yet`} actions={newButton()} />
        ) : items !== null && !shown.length ? (
          <p className="py-16 text-center text-sm text-muted-foreground">
            {archived
              ? "Nothing archived."
              : query.trim()
                ? "Nothing matches."
                : tagging && activeTag
                  ? `Nothing tagged ${activeTag.name}${activeKind ? ` among ${activeKind.plural.toLowerCase()}` : ""}.`
                  : tagging && tagFilter === UNTAGGED
                    ? "Everything here is tagged."
                    : activeKind
                      ? `No ${activeKind.plural.toLowerCase()} here.`
                      : "Nothing here."}
          </p>
        ) : null}

        {shown.length && view === "grid" ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3 max-md:hidden">
            {shown.map((item) => {
              const kind = kindOf(item);
              const checked = selected.has(itemKey(item));
              const pickable = selectable(item) === true;
              return (
                <div
                  key={itemKey(item)}
                  role="link"
                  tabIndex={0}
                  aria-label={untitled(item.title)}
                  data-state={checked ? "selected" : undefined}
                  className="group/row relative flex cursor-pointer flex-col overflow-hidden rounded-lg border border-border hover:bg-state-hover data-[state=selected]:border-foreground/40 data-[state=selected]:bg-state-hover"
                  onClick={(event) => (chosen.length && pickable ? toggle(item, event.shiftKey) : handlers.onOpen(item))}
                  onKeyDown={(event) => event.key === "Enter" && handlers.onOpen(item)}
                >
                  {/* Every card has the same preview area, so a grid row doesn't
                      stretch around the one card with a thumbnail. */}
                  <div className={cn("flex h-32 items-center justify-center border-b border-border bg-foreground/[0.03]", item.thumbnailUrl ? "p-1" : "p-3")}>
                    {item.thumbnailUrl ? (
                      <img src={item.thumbnailUrl} alt="" loading="lazy" className={THUMBNAIL} />
                    ) : (
                      <ItemTile icon={item.icon} kindIcon={kind?.icon ?? "File"} size="xl" />
                    )}
                  </div>
                  <div className="absolute top-2 right-2 flex items-center gap-1">
                    {item.badge ? <Badge label={item.badge.label} tone={item.badge.tone} /> : null}
                    {rowMenu(item, revealClass)}
                  </div>
                  <div className="flex flex-1 flex-col p-4">
                    <div className="min-w-0">
                      <div className={cn("truncate font-medium", !item.title && "text-muted-foreground")}>{untitled(item.title)}</div>
                      {preview(item, "mt-0.5 line-clamp-2")}
                      <div className="mt-1 truncate text-xs text-muted-foreground">{subtitle(item)}</div>
                      {tagging && item.tags?.length ? (
                        <div className="mt-2 flex min-w-0 items-center gap-1 overflow-hidden">
                          <TagChips ids={item.tags} tags={tagById} max={3} onPick={pickTag} />
                        </div>
                      ) : null}
                    </div>
                  </div>
                  {pickable ? (
                    <Checkbox
                      checked={checked}
                      label={`Select ${untitled(item.title)}`}
                      onToggle={(event) => toggle(item, event.shiftKey)}
                      className={cn("absolute top-2 left-2 opacity-0 group-hover/row:opacity-100 [@media(hover:none)]:opacity-100 focus-visible:opacity-100", (checked || chosen.length > 0) && "opacity-100")}
                    />
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}

        {shown.length ? (
          <div role="grid" aria-label={title} aria-multiselectable className={cn("text-sm", view === "grid" && "md:hidden")}>
            <div role="row" className={cn("grid gap-3 border-b border-border px-2 pb-2 text-xs text-muted-foreground max-md:hidden")} style={gridTemplate}>
              <span role="columnheader" className="flex items-center">
                <Checkbox
                  checked={allChecked ? true : chosen.length ? "mixed" : false}
                  label={allChecked ? "Deselect all" : "Select all"}
                  disabled={!selectableKeys.length}
                  onToggle={() => setSelected(allChecked ? new Set() : new Set(selectableKeys))}
                />
              </span>
              {header("Name", "title")}
              {showKind ? header("Kind", "kind") : null}
              {header("Project", "project")}
              {columns.map((column) => header(column.label, `fact:${column.id}`, "text-right"))}
              {header("Last activity", "updatedAt")}
            </div>
            {shown.map((item) => {
              const kind = kindOf(item);
              const key = itemKey(item);
              const checked = selected.has(key);
              const reason = selectionLabel(item);
              const parent = parentLine(item);
              return (
                <div
                  key={key}
                  role="row"
                  tabIndex={0}
                  aria-label={untitled(item.title)}
                  aria-selected={checked}
                  data-state={checked ? "selected" : undefined}
                  className={cn(
                    "group/row grid cursor-pointer items-center gap-3 rounded-md px-2 py-2 hover:bg-state-hover data-[state=selected]:bg-state-active max-md:!grid-cols-[minmax(0,1fr)_auto] max-md:py-2.5",
                  )}
                  style={gridTemplate}
                  onClick={(event) => (chosen.length && reason === undefined ? toggle(item, event.shiftKey) : handlers.onOpen(item))}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) return;
                    if (event.key === "Enter") handlers.onOpen(item);
                    if (event.key === " ") {
                      event.preventDefault();
                      if (reason === undefined) toggle(item, event.shiftKey);
                    }
                  }}
                >
                  <div role="gridcell" className="flex items-center max-md:hidden">
                    <Checkbox
                      checked={checked}
                      label={`Select ${untitled(item.title)}`}
                      disabled={reason !== undefined}
                      title={reason}
                      onToggle={(event) => toggle(item, event.shiftKey)}
                      className={cn(!checked && !chosen.length && "opacity-0 group-hover/row:opacity-100 [@media(hover:none)]:opacity-100 focus-visible:opacity-100")}
                    />
                  </div>
                  <div role="gridcell" className="flex min-w-0 items-center gap-3">
                    {item.thumbnailUrl ? (
                      <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-background">
                        <img src={item.thumbnailUrl} alt="" loading="lazy" className={THUMBNAIL} />
                      </span>
                    ) : (
                      <ItemTile icon={item.icon} kindIcon={kind?.icon ?? "File"} />
                    )}
                    <div className="min-w-0">
                      <div className={cn("flex min-w-0 items-center gap-1.5 font-medium", !item.title && "text-muted-foreground")}>
                        <span className="truncate">{untitled(item.title)}</span>
                        {item.badge ? <Badge label={item.badge.label} tone={item.badge.tone} /> : null}
                        {tagging ? <TagChips ids={item.tags} tags={tagById} onPick={pickTag} /> : null}
                      </div>
                      {parent ? <div className="truncate text-xs text-muted-foreground">{parent}</div> : null}
                      {!parent ? preview(item, "truncate") : null}
                      <div className="truncate text-xs text-muted-foreground md:hidden">{subtitle(item)}</div>
                    </div>
                  </div>
                  {showKind ? (
                    <div role="gridcell" className="flex min-w-0 items-center gap-1.5 text-muted-foreground max-md:hidden">
                      <Icon name={kind?.icon ?? "File"} className="size-3.5 shrink-0" />
                      <span className="truncate">{kindLabel(item)}</span>
                    </div>
                  ) : null}
                  <div role="gridcell" className="truncate text-muted-foreground max-md:hidden">
                    {projectLabel(item)}
                  </div>
                  {columns.map((column) => (
                    <div key={column.id} role="gridcell" className="truncate text-right tabular-nums text-muted-foreground max-md:hidden">
                      {item.facts.find((fact) => fact.id === column.id)?.value ?? "—"}
                    </div>
                  ))}
                  <div role="gridcell" className="flex min-w-0 items-center justify-between gap-2 text-muted-foreground max-md:justify-end">
                    <span className="truncate max-md:hidden" title={new Date(item.updatedAt).toLocaleString()}>
                      {relativeTime(item.updatedAt)}
                    </span>
                    {rowMenu(item, revealClass)}
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </PageColumn>
  );
}
