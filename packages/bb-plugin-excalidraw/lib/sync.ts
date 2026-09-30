// Live drawing sync for the editor: the open editor picks up changes made by
// other writers (an agent's excalidraw_update_drawing tool, the CLI, or
// another open editor tab) so the human and the agent work on the same
// canvas together.
//
// Two channels:
//   - realtime: the server publishes `{ type: "drawing:updated", drawingId,
//     updatedAt }` on the "excalidraw" channel after every successful write.
//   - polling fallback (every 5s, cheap updatedAt check) in case a signal is
//     missed while the tab is backgrounded or the socket reconnects.
//
// Remote scenes are reconciled with the live local scene using Excalidraw's
// own `reconcileElements`, so in-progress local edits (and any local element
// with a newer `version`) win over the remote copy — exactly like Excalidraw
// multiplayer. Every signal fetches and reconciles; nothing is dropped by
// revision, because the editor's own save can land a newer revision that
// already contains an agent's elements the editor hasn't shown yet. Remote
// elements go through `restoreElements` (fills defaults missing from partial
// agent elements) and new image files are loaded with `addFiles`. The
// reconciled scene is applied with updateScene; the editor does NOT autosave
// it (the server already has it) which avoids save ping-pong between writers.
import { useCallback, useEffect, useRef } from "react";
import { reconcileElements, restoreElements } from "@excalidraw/excalidraw";
import { useRealtime } from "@get-bb/plugin-sdk/app";
import { elementsChanged, missingFiles, type SceneElement } from "./merge";
import { parseScene } from "./scene";

type SyncRpc = {
  call: (
    method: "getDrawing" | "getDrawingUpdatedAt",
    input: { id: string },
  ) => Promise<{
    drawing?: { updatedAt: number; data: string } | null;
    updatedAt?: number;
  }>;
};

type SyncApi = {
  getSceneElementsIncludingDeleted(): unknown;
  getAppState(): unknown;
  getFiles(): unknown;
  addFiles(files: unknown[]): void;
  updateScene(opts: { elements: unknown }): void;
};

export function useDrawingSync(
  drawingId: string,
  rpc: SyncRpc,
  getApi: () => SyncApi | null,
  onRemoteApplied?: (updatedAt: number) => void,
  /** Called with true before a remote scene is applied and false after, even if it fails. */
  onApplying?: (applying: boolean) => void,
) {
  // Latest revision this editor has fetched and reconciled (poll gate only).
  const serverRevRef = useRef(0);
  const busyRef = useRef(false);
  // A signal arrived mid-apply; run again so it isn't lost.
  const rerunRef = useRef(false);
  const onRemoteAppliedRef = useRef(onRemoteApplied);
  onRemoteAppliedRef.current = onRemoteApplied;
  const onApplyingRef = useRef(onApplying);
  onApplyingRef.current = onApplying;

  const applyOnce = useCallback(async () => {
    const api = getApi();
    if (!api) return;
    const res = await rpc.call("getDrawing", { id: drawingId });
    const drawing = res?.drawing;
    if (!drawing) return;
    const scene = parseScene(drawing.data);
    if (!scene) return;
    serverRevRef.current = Math.max(serverRevRef.current, drawing.updatedAt);
    const localElements = api.getSceneElementsIncludingDeleted() as SceneElement[];
    // No local elements passed: restoreElements would otherwise bump remote
    // versions above local ones and defeat the reconcile below.
    const remoteElements = restoreElements(scene.elements as never, null);
    const reconciled = reconcileElements(
      localElements as never,
      remoteElements as never,
      api.getAppState() as never,
    );
    const files = missingFiles(
      (api.getFiles() ?? {}) as Record<string, unknown>,
      scene.files,
    );
    const changed = elementsChanged(
      localElements,
      reconciled as unknown as SceneElement[],
    );
    if (!changed && files.length === 0) return;
    onApplyingRef.current?.(true);
    try {
      if (files.length > 0) api.addFiles(files);
      if (changed) api.updateScene({ elements: reconciled as never });
      onRemoteAppliedRef.current?.(drawing.updatedAt);
    } finally {
      onApplyingRef.current?.(false);
    }
  }, [drawingId, rpc, getApi]);

  const applyRemote = useCallback(async () => {
    if (busyRef.current) {
      rerunRef.current = true;
      return;
    }
    busyRef.current = true;
    try {
      do {
        rerunRef.current = false;
        try {
          await applyOnce();
        } catch {
          // transient failure — the poll / next signal retries
        }
      } while (rerunRef.current);
    } finally {
      busyRef.current = false;
    }
  }, [applyOnce]);

  // Realtime push: the server publishes after every successful write.
  useRealtime("excalidraw", (payload) => {
    const p = payload as { type?: string; drawingId?: string };
    if (p.type === "drawing:updated" && p.drawingId === drawingId) {
      void applyRemote();
    }
  });

  // Polling fallback (cheap updatedAt check; full scene only on change).
  useEffect(() => {
    let cancelled = false;
    const timer = setInterval(async () => {
      if (cancelled || busyRef.current) return;
      try {
        const res = await rpc.call("getDrawingUpdatedAt", { id: drawingId });
        const updatedAt = res?.updatedAt ?? 0;
        if (updatedAt > serverRevRef.current) void applyRemote();
      } catch {
        // ignore — next tick retries
      }
    }, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [drawingId, rpc, applyRemote]);

  return {
    /**
     * Track the server revision after a load. Not for local saves: the merged
     * revision a save returns can hold other writers' elements this editor
     * hasn't applied, so the poll must still fetch it.
     */
    setServerRev(rev: number) {
      serverRevRef.current = rev;
    },
    /** Current known server revision (for status display). */
    getServerRev() {
      return serverRevRef.current;
    },
  };
}
