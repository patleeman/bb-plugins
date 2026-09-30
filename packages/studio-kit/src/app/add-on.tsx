// An add-on's own collection page. Built from the same `studio_*` methods
// Studio calls, so it shows exactly what Studio would for this add-on. When
// Studio is installed, the page hands over to Studio's collection instead,
// unless the add-on keeps its own page (`handOver={false}`).
import { useBbContext, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import type { z as Zod } from "zod";
import { mentionPrompt, type StudioCreateEventDetail, type StudioSchemas } from "../contract";
import { errorMessage } from "../format";
import { CollectionPage, type CollectionHandlers, type CollectionItem, type CollectionKind } from "./collection";
import { openAppPath, studioPath } from "./nav";
import { useProjects } from "./pieces";
import { useStudioPresent } from "./presence";

type Provider = StudioSchemas["provider"];

/** Calls this add-on's own `studio_*` methods, e.g. `useRpc().call`. */
export type ProviderCall = <M extends keyof Provider>(
  method: M,
  input: Zod.input<Provider[M]["input"]>,
) => Promise<Zod.output<Provider[M]["output"]>>;

export function AddOnCollection({
  pluginId,
  title,
  call,
  refreshKey,
  kind: initialKind = "all",
  handOver = true,
  headerActions,
}: {
  pluginId: string;
  title: string;
  call: ProviderCall;
  /** Change it to refetch, e.g. on the add-on's realtime events. */
  refreshKey?: unknown;
  /** The kind Studio opens filtered to when this page hands over. */
  kind?: string;
  /** Hand over to Studio's collection when Studio is installed. */
  handOver?: boolean;
  /** Extra buttons beside New. */
  headerActions?: ReactNode;
}) {
  const present = useStudioPresent();
  const studio = handOver ? present : false;
  const navigate = useBbNavigate();
  const context = useBbContext();
  const projects = useProjects();
  const [kinds, setKinds] = useState<CollectionKind[]>([]);
  const [items, setItems] = useState<CollectionItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState(initialKind);
  const latest = useRef(0);

  useEffect(() => {
    if (studio) openAppPath(studioPath(initialKind === "all" ? null : initialKind), { replace: true });
  }, [studio, initialKind]);

  const refetch = useCallback(() => {
    const request = ++latest.current;
    Promise.all([call("studio_describe", null), call("studio_list", null)]).then(
      ([info, list]) => {
        if (request !== latest.current) return;
        setKinds(info.kinds.map((each) => ({ ...each, pluginId })));
        setItems(list.items.map((item) => ({ ...item, pluginId })));
        setError(null);
      },
      (cause: unknown) => request === latest.current && setError(errorMessage(cause)),
    );
  }, [call, pluginId]);

  useEffect(() => {
    if (studio === false) refetch();
  }, [studio, refetch, refreshKey]);
  useEffect(() => {
    if (studio !== false) return;
    const onVisible = () => document.visibilityState === "visible" && refetch();
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [studio, refetch]);

  const handlers = useMemo<CollectionHandlers>(() => {
    const ids = (items: CollectionItem[]) => items.map((item) => item.id);
    const after = async <T,>(work: Promise<T>) => {
      try {
        return await work;
      } finally {
        refetch();
      }
    };
    return {
      onOpen: (item) => openAppPath(item.href),
      onCreate: async (target, projectId) => {
        if (!target.create) return;
        if (target.create.mode === "event") {
          const event = new CustomEvent<StudioCreateEventDetail>(target.create.event, { detail: { projectId }, cancelable: true });
          window.dispatchEvent(event);
          if (!event.defaultPrevented) toast.error(`${title} isn't ready yet. Reload BB and try again.`);
          return;
        }
        try {
          const { item } = await call("studio_create", { kind: target.id, projectId });
          openAppPath(item.href);
        } catch (cause) {
          toast.error(`Couldn't create a ${target.label.toLowerCase()}: ${errorMessage(cause)}`);
        }
      },
      onNewThread: (items) => navigate.toCompose({ initialPrompt: mentionPrompt(items), focusPrompt: true }),
      onMove: (items, projectId) => after(call("studio_move", { ids: ids(items), projectId })),
      onArchive: (items, archived) => after(call("studio_archive", { ids: ids(items), archived })),
      onDelete: (items) => after(call("studio_delete", { ids: ids(items) })),
      onAction: (_kind, action, items) => after(call("studio_action", { action: action.id, ids: ids(items) })),
      onSearch: async (query) => {
        const { ids, snippets = {} } = await call("studio_search", { query });
        return new Map(ids.map((id) => [`${pluginId}:${id}`, snippets[id] ?? null]));
      },
    };
  }, [call, navigate, pluginId, refetch, title]);

  // Blank while checking for Studio, so the page doesn't flash before handing over.
  if (studio !== false) return <div className="h-full bg-background" />;
  return (
    <CollectionPage
      title={title}
      kinds={kinds}
      items={items}
      error={error}
      projects={projects}
      defaultProjectId={context.projectId ?? null}
      storageKey={`${pluginId}:collection`}
      kind={kind}
      onKindChange={setKind}
      headerActions={headerActions}
      handlers={handlers}
    />
  );
}
