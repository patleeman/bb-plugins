// The full Excalidraw editor: loads a drawing, autosaves (debounced,
// ordered), follows other writers live, and offers the drawing's actions in
// Studio's item header. In a thread's panel, "Attach" renders the scene to a
// PNG and attaches it to that conversation.
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Excalidraw,
  exportToBlob,
} from "@excalidraw/excalidraw";
import type {
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";
import "../assets/excalidraw/excalidraw.css";
// Re-maps Excalidraw's palette to bb's live theme tokens; must load after
// the vendored css so the overrides win at equal specificity.
import "../assets/excalidraw-theme.css";
import {
  DANGER_BUTTON,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  FLOATING,
  FLOATING_BUTTON,
  GHOST_BUTTON,
  ICON_BUTTON,
  Icon,
  ItemHeader,
  cn,
} from "@bb-studio/kit/app";
import { mentionPrompt } from "@bb-studio/kit/contract";
import { errorMessage } from "@bb-studio/kit/format";
import {
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import {
  blobToBase64,
  parseScene,
  resolveThemeColor,
  sanitizeAppStateForStorage,
  serializeSceneWithTombstones,
  useIsDark,
} from "../lib/scene";
import { useDrawingSync } from "../lib/sync";
import { DRAWING_UPDATE_TYPE, REALTIME_CHANNEL, drawingHref } from "../src/shared";

const SPIN = "animate-spin motion-reduce:animate-none";

export function DrawingEditor({
  drawingId,
  threadId,
  backLabel,
  onBack,
}: {
  drawingId: string;
  /** Set in a thread's panel, where the drawing can be attached. */
  threadId?: string | null;
  backLabel: string;
  /** `replace` when leaving because the drawing is gone. */
  onBack: (replace?: boolean) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const isDark = useIsDark();
  const [name, setName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const [initialData, setInitialData] = useState<ExcalidrawInitialDataState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [attaching, setAttaching] = useState(false);

  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  // Until the user touches the canvas, keep the scene centred as the canvas
  // resizes (the sidebar or a side panel opening or closing).
  const touchedRef = useRef(false);
  const loadedRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const pendingRef = useRef<string | null>(null);
  // The scene as last saved or loaded, serialized. Excalidraw calls onChange
  // for pointer moves, selection and scrolling too; comparing against this
  // saves only real changes, so the editor doesn't keep rewriting the scene
  // (and hearing its own write back as a remote update).
  const savedSceneRef = useRef<string | null>(null);
  // Set while a remote scene is being applied, so the onChange it causes is
  // recorded as saved rather than written back.
  const applyingRemoteRef = useRef(false);
  // Server revision the editor loaded (the sync poll's starting point).
  const serverRevSetterRef = useRef<(rev: number) => void>(() => {});
  const [syncedAt, setSyncedAt] = useState<number | null>(null);
  const realtimeState = useRealtimeConnectionState();

  // Load the drawing scene once (component is keyed by drawingId).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void rpc
      .call("getDrawing", { id: drawingId })
      .then(({ drawing }) => {
        if (cancelled) return;
        if (!drawing) {
          toast.error("Drawing not found");
          onBack(true);
          return;
        }
        setName(drawing.name);
        const scene = parseScene(drawing.data);
        if (scene) {
          // Scenes stored before the appState fix carry the full runtime
          // AppState (JSON'd Maps like `collaborators: {}`), which crashes
          // Excalidraw on load ("collaborators.forEach is not a function").
          // Strip it to the export-safe keys Excalidraw itself persists.
          scene.appState = sanitizeAppStateForStorage(scene.appState);
          // Brand-new drawings (empty scene, stock white canvas) start on
          // the active bb theme's canvas color. Drawings with content keep
          // their saved background so exports stay scene-faithful.
          if (
            scene.elements.length === 0 &&
            (scene.appState.viewBackgroundColor === undefined ||
              scene.appState.viewBackgroundColor === "#ffffff")
          ) {
            scene.appState = {
              ...scene.appState,
              viewBackgroundColor: resolveThemeColor("--canvas", "#ffffff"),
            };
          }
        }
        setInitialData(
          scene
            ? ({ ...scene, scrollToContent: true } as unknown as ExcalidrawInitialDataState)
            : null,
        );
        loadedRef.current = true;
        serverRevSetterRef.current(drawing.updatedAt);
        setLoading(false);
      })
      .catch((error) => {
        if (cancelled) return;
        toast.error(error instanceof Error ? error.message : "Failed to load");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawingId]);

  // Live sync with other writers (agent edits via excalidraw_update_drawing,
  // the CLI, or another open editor): apply remote scenes into this editor
  // and notify when one lands. Local in-progress edits win via
  // reconcileElements inside the hook.
  const sync = useDrawingSync(
    drawingId,
    rpc as never,
    () => {
      const api = apiRef.current;
      return api
        ? {
            getSceneElementsIncludingDeleted: () =>
              api.getSceneElementsIncludingDeleted(),
            getAppState: () => api.getAppState(),
            getFiles: () => api.getFiles(),
            addFiles: (files: unknown[]) => api.addFiles(files as never),
            updateScene: (opts: { elements: unknown }) =>
              api.updateScene({ elements: opts.elements as never }),
          }
        : null;
    },
    (updatedAt) => {
      // The server already has the scene we just applied, so the change it
      // causes isn't saved back (that would ping-pong between writers).
      const api = apiRef.current;
      if (api) {
        savedSceneRef.current = serializeSceneWithTombstones(
          [...api.getSceneElementsIncludingDeleted()],
          api.getAppState(),
          api.getFiles(),
        );
      }
      setSyncedAt(updatedAt);
    },
    (applying) => {
      applyingRemoteRef.current = applying;
    },
  );
  serverRevSetterRef.current = sync.setServerRev;

  // Briefly show "Synced" after a remote update lands.
  useEffect(() => {
    if (syncedAt === null) return;
    const t = setTimeout(() => setSyncedAt(null), 3000);
    return () => clearTimeout(t);
  }, [syncedAt]);

  useEffect(() => {
    const element = canvasRef.current;
    if (!element || loading) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (touchedRef.current) return;
      cancelAnimationFrame(frame);
      // After Excalidraw has taken the new size.
      frame = requestAnimationFrame(() => {
        const api = apiRef.current;
        if (api && api.getSceneElements().length > 0) api.scrollToContent();
      });
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [loading]);

  const flushSave = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = null;
    setSaving(true);
    const payload = { id: drawingId, data: pending };
    saveChainRef.current = saveChainRef.current
      .then(() => rpc.call("saveDrawing", payload))
      // The server's merged revision is left for the sync hook to fetch: it
      // can hold an agent's elements that landed while this save was in
      // flight, and those must still reach the canvas.
      .then(() => setSaving(false))
      .catch((error) => {
        setSaving(false);
        toast.error(
          error instanceof Error ? `Save failed: ${error.message}` : "Save failed",
        );
      });
  }, [drawingId, rpc]);

  const scheduleSave = useCallback(
    (data: string) => {
      pendingRef.current = data;
      setSaving(true);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => flushSave(), 1200);
    },
    [flushSave],
  );

  // Save any pending changes when leaving the editor.
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      const pending = pendingRef.current;
      if (pending) {
        saveChainRef.current = saveChainRef.current.then(() =>
          rpc
            .call("saveDrawing", { id: drawingId, data: pending })
            .then(() => undefined),
        );
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawingId]);

  const handleChange = useCallback(
    (elements: readonly unknown[], appState: unknown, files: unknown) => {
      if (!loadedRef.current) return;
      try {
        // Serialize WITH tombstones (deleted elements) so deletions propagate
        // through the server-side merge instead of silently resurrecting.
        const api = apiRef.current;
        const allElements = api
          ? [...api.getSceneElementsIncludingDeleted()]
          : [...elements];
        const serialized = serializeSceneWithTombstones(
          allElements,
          appState,
          files,
        );
        // The first change after mount is Excalidraw normalizing the loaded
        // scene, and a remote scene being applied is already on the server;
        // record either as the saved scene without writing it back.
        if (savedSceneRef.current === null || applyingRemoteRef.current) {
          savedSceneRef.current = serialized;
          return;
        }
        if (serialized === savedSceneRef.current) return;
        savedSceneRef.current = serialized;
        scheduleSave(serialized);
      } catch (error) {
        console.error("serialize failed", error);
      }
    },
    [scheduleSave],
  );

  async function renderPng(): Promise<Blob> {
    const api = apiRef.current;
    if (!api) throw new Error("Editor not ready");
    const elements = api
      .getSceneElements()
      .filter((el) => !el.isDeleted);
    const appState = api.getAppState();
    const files = api.getFiles();
    return exportToBlob({
      elements,
      appState,
      files,
      mimeType: "image/png",
      exportBackground: true,
    });
  }

  async function downloadPng() {
    try {
      const blob = await renderPng();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(name.trim() || "drawing").replace(/[\\/:*?"<>|]+/g, "-")}.png`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  async function copyImage() {
    try {
      const blob = await renderPng();
      if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
        throw new Error("Clipboard image writing is not supported here");
      }
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob }),
      ]);
      toast.success("Image copied to clipboard");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  // Deleted elsewhere (Studio, the CLI, another window) while open.
  useRealtime(REALTIME_CHANNEL, (payload) => {
    const event = payload as { type?: string; drawingId?: string } | null;
    if (event?.type !== DRAWING_UPDATE_TYPE || event.drawingId !== drawingId) return;
    void rpc.call("getDrawingUpdatedAt", { id: drawingId }).then(({ updatedAt }) => {
      if (updatedAt !== 0) return;
      pendingRef.current = null;
      toast.info("This drawing was deleted.");
      onBack(true);
    });
  });

  function rename(next: string) {
    const trimmed = next.trim();
    if (trimmed === name.trim()) return;
    setName(trimmed);
    void rpc.call("renameDrawing", { id: drawingId, name: trimmed }).catch((error) => toast.error(errorMessage(error)));
  }

  function newThread() {
    navigate.toCompose({
      initialPrompt: mentionPrompt([{ title: name.trim() || "Untitled drawing", href: drawingHref(drawingId) }]),
      focusPrompt: true,
    });
  }

  async function attachAsImage() {
    if (!threadId) return;
    setAttaching(true);
    try {
      const blob = await renderPng();
      const pngBase64 = await blobToBase64(blob);
      await rpc.call("attachDrawingImage", {
        threadId,
        drawingId,
        pngBase64,
      });
      toast.success("Drawing attached");
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setAttaching(false);
    }
  }

  async function deleteDrawing() {
    try {
      pendingRef.current = null;
      await rpc.call("deleteDrawing", { id: drawingId });
      toast.success("Drawing deleted");
      onBack(true);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  const status = (
    <span
      role="status"
      aria-live="polite"
      title={
        realtimeState === "connected"
          ? "Live — agent edits appear here automatically"
          : "Reconnecting to live sync…"
      }
      className="flex h-8 shrink-0 items-center gap-1.5 px-1 text-xs text-muted-foreground max-sm:hidden"
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 rounded-full",
          realtimeState === "connected" ? "bg-success" : "animate-pulse bg-warning motion-reduce:animate-none",
        )}
      />
      {saving ? "Saving…" : syncedAt ? "Synced" : "Saved"}
    </span>
  );

  const trailing = confirmDelete ? (
    <div className={cn(FLOATING, "flex items-center gap-1.5 rounded-md py-1 pr-1 pl-3 text-sm")}>
      <span className="max-sm:hidden">Delete this drawing?</span>
      <button type="button" className={DANGER_BUTTON} onClick={() => void deleteDrawing()}>
        Delete
      </button>
      <button type="button" className={GHOST_BUTTON} onClick={() => setConfirmDelete(false)}>
        Cancel
      </button>
    </div>
  ) : (
    <>
      {threadId ? (
        <button type="button" className={FLOATING_BUTTON} disabled={attaching} onClick={() => void attachAsImage()}>
          <Icon name={attaching ? "Loading" : "Paperclip"} className={attaching ? SPIN : undefined} /> Attach
        </button>
      ) : (
        <button type="button" className={cn(FLOATING_BUTTON, "max-md:hidden")} onClick={newThread}>
          <Icon name="MessageSquarePlus" /> New thread
        </button>
      )}
      <button type="button" aria-label="Copy image" title="Copy image" className={ICON_BUTTON} onClick={() => void copyImage()}>
        <Icon name="Copy" className="size-4" />
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label="More" className={ICON_BUTTON}>
            <Icon name="MoreHorizontal" className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          {threadId ? null : (
            <DropdownMenuItem className="md:hidden" onSelect={newThread}>
              <Icon name="MessageSquarePlus" className="size-4" /> New thread
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => void downloadPng()}>
            <Icon name="Download" className="size-4" /> Download PNG
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => setConfirmDelete(true)}>
            <Icon name="Trash2" className="size-4" /> Delete…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );

  return (
    <div className="studio-root flex h-full min-h-0 flex-col bg-background text-foreground">
      <ItemHeader
        className="relative shrink-0 items-center border-b border-border/70"
        backLabel={backLabel}
        onBack={() => onBack()}
        leading={
          <>
            <input
              aria-label="Drawing name"
              key={`${drawingId}:${name}`}
              defaultValue={name}
              placeholder="Untitled drawing"
              maxLength={200}
              disabled={loading}
              className="h-8 w-56 min-w-0 rounded-md bg-transparent px-2 text-sm font-medium outline-none placeholder:text-muted-foreground hover:bg-state-hover focus:bg-state-hover max-md:w-32"
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") {
                  event.currentTarget.value = name;
                  event.currentTarget.blur();
                }
              }}
              onBlur={(event) => rename(event.currentTarget.value)}
            />
            {loading ? null : status}
          </>
        }
        trailing={trailing}
      />
      <div
        ref={canvasRef}
        className="relative min-h-0 flex-1 overflow-hidden bg-background"
        onPointerDownCapture={() => (touchedRef.current = true)}
        onWheelCapture={() => (touchedRef.current = true)}
        onKeyDownCapture={() => (touchedRef.current = true)}
      >
        {loading ? (
          <div role="status" className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
            <Icon name="Loading" className={cn("size-4", SPIN)} /> Loading drawing…
          </div>
        ) : (
          <Excalidraw
            key={drawingId}
            initialData={initialData}
            onChange={handleChange}
            excalidrawAPI={(api) => {
              apiRef.current = api;
            }}
            theme={isDark ? "dark" : "light"}
            UIOptions={{
              canvasActions: {
                toggleTheme: true,
                export: false,
                saveToActiveFile: false,
                loadScene: false,
              },
            }}
          />
        )}
      </div>
    </div>
  );
}
