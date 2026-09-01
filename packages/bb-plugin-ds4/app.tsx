// bb-plugin-ds4 — setup guidance for the demand-driven DwarfStar server.

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  definePluginApp,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  useSettings,
  type PluginThreadHeaderActionProps,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import {
  ds4LifecycleNotice,
  ds4LifecyclePhase,
  type Ds4LifecyclePhase,
} from "./src/lifecycle-notifications";

const DS4_STATUS_CHANNEL = "state";
const DS4_LIFECYCLE_TOAST_ID = "ds4-lifecycle";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function modelPresetLabel(value: unknown): string {
  switch (value) {
    case "deepseek-v4-flash":
    case "DeepSeek V4 Flash":
      return "DeepSeek V4 Flash";
    case "deepseek-v4-flash-vision-exp":
    case "DeepSeek V4 Flash Vision Experimental":
      return "DeepSeek V4 Flash Vision Experimental";
    case "glm-5.3-flash":
    case "GLM 5.3 Flash":
      return "GLM 5.3 Flash";
    default:
      return "Auto (model path)";
  }
}

function parseStatus(value: unknown): {
  phase: Ds4LifecyclePhase;
  error: string | null;
} | null {
  if (!isRecord(value)) return null;
  if (typeof value.state !== "string") return null;
  const health = isRecord(value.health) ? value.health : null;
  const phase = ds4LifecyclePhase({
    state: value.state,
    healthOk: health?.ok === true && value.displayState === "ready",
    hasError: typeof value.lastError === "string" && value.lastError.length > 0,
  });
  if (!phase) return null;
  return {
    phase,
    error: typeof value.lastError === "string" ? value.lastError : null,
  };
}

type DwarfStarStatus = {
  phase: Ds4LifecyclePhase;
  error: string | null;
};

function useDwarfStarStatus(): DwarfStarStatus | null {
  const rpc = useRpc<typeof rpcContract>();
  const realtimeConnection = useRealtimeConnectionState();
  const [status, setStatus] = useState<DwarfStarStatus | null>(null);
  const statusRevision = useRef(0);

  const applyStatus = useCallback((value: unknown) => {
    const parsed = parseStatus(value);
    if (!parsed) return;
    statusRevision.current += 1;
    setStatus(parsed);
  }, []);

  useRealtime(DS4_STATUS_CHANNEL, applyStatus);

  useEffect(() => {
    if (realtimeConnection !== "connected") return;
    let cancelled = false;
    let retryTimer: number | null = null;
    const revisionAtRequest = statusRevision.current;

    const reconcile = () => {
      void rpc
        .call("status", null)
        .then((value) => {
          if (!cancelled && statusRevision.current === revisionAtRequest) {
            applyStatus(value);
          }
        })
        .catch(() => {
          if (!cancelled) retryTimer = window.setTimeout(reconcile, 1_500);
        });
    };
    reconcile();

    return () => {
      cancelled = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, [applyStatus, realtimeConnection, rpc]);

  return status;
}

function showLifecycleNotice(notice: ReturnType<typeof ds4LifecycleNotice>): void {
  if (!notice) return;
  const options = {
    id: DS4_LIFECYCLE_TOAST_ID,
    description: notice.description,
    duration: notice.kind === "loading" ? Infinity : notice.kind === "error" ? 8_000 : 4_000,
  } as const;
  switch (notice.kind) {
    case "loading":
      toast.loading(notice.title, options);
      break;
    case "success":
      toast.success(notice.title, options);
      break;
    case "info":
      toast.info(notice.title, options);
      break;
    case "error":
      toast.error(notice.title, options);
      break;
  }
}

/**
 * The backend lifecycle starts outside React, so a thread-header slot is used
 * as a small per-thread bridge for realtime signals. It intentionally renders
 * no control; the visible surface is the host toaster.
 */
function DwarfStarLifecycleBridge({
  threadId: _threadId,
}: PluginThreadHeaderActionProps) {
  const status = useDwarfStarStatus();
  const phaseRef = useRef<Ds4LifecyclePhase | null>(null);

  useEffect(() => {
    if (!status) return;
    const notice = ds4LifecycleNotice(status.phase, phaseRef.current, {
      initial: phaseRef.current === null,
      error: status.error,
    });
    phaseRef.current = status.phase;
    showLifecycleNotice(notice);
  }, [status]);

  return null;
}

function DwarfStarLifecycleBanner() {
  const status = useDwarfStarStatus();
  const phaseRef = useRef<Ds4LifecyclePhase | null>(null);
  const [visiblePhase, setVisiblePhase] =
    useState<Ds4LifecyclePhase | null>(null);

  useEffect(() => {
    if (!status || status.phase === phaseRef.current) return;
    const notice = ds4LifecycleNotice(status.phase, phaseRef.current, {
      initial: phaseRef.current === null,
      error: status.error,
    });
    phaseRef.current = status.phase;
    if (!notice) return;

    setVisiblePhase(status.phase);
    if (status.phase !== "ready" && status.phase !== "stopped") return;
    const timeout = window.setTimeout(() => setVisiblePhase(null), 4_000);
    return () => window.clearTimeout(timeout);
  }, [status]);

  if (visiblePhase === null) return null;
  const notice = ds4LifecycleNotice(visiblePhase, null, {
    error: status?.error,
  });
  if (!notice) return null;

  const isLoading = notice.kind === "loading";
  return (
    <div
      className="flex items-start gap-2 text-xs"
      role="status"
      aria-live={notice.kind === "error" ? "assertive" : "polite"}
    >
      <span
        aria-hidden="true"
        className={
          isLoading
            ? "mt-0.5 size-3 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent"
            : "mt-0.5 shrink-0 text-sm leading-3"
        }
      >
        {isLoading ? null : notice.kind === "error" ? "!" : "✓"}
      </span>
      <span className="min-w-0">
        <span className="font-medium">{notice.title}</span>
        <span className="ml-1 text-muted-foreground">{notice.description}</span>
      </span>
    </div>
  );
}

function SetupSection() {
  const { values, isLoading } = useSettings();
  const ds4Dir =
    typeof values?.ds4Dir === "string" && values.ds4Dir
      ? values.ds4Dir
      : "Auto-detected DS4 checkout";
  const rawModelPreset =
    typeof values?.modelPreset === "string" ? values.modelPreset : "auto";
  const rawModelPath =
    typeof values?.modelPath === "string" ? values.modelPath : "";
  const modelPath =
    rawModelPreset !== "auto"
      ? rawModelPath
        ? `${rawModelPath} (ignored while Model is selected)`
        : "standard GGUF for selected model"
      : rawModelPath || "ds4flash.gguf (default)";
  const modelPreset = modelPresetLabel(rawModelPreset);
  const contextWindow =
    typeof values?.ctx === "string" ? values.ctx : "250000";
  const idleTimeout =
    typeof values?.idleTimeoutSeconds === "string"
      ? values.idleTimeoutSeconds
      : "300";
  const visionPath =
    typeof values?.visionPath === "string" ? values.visionPath : "auto";

  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-4 text-sm">
      <div>
        <p className="font-medium">Automatic local model lifecycle</p>
        <p className="mt-1 text-muted-foreground">
          Configure the DS4 checkout and model above. The DwarfStar provider
          exposes that one model, starts it when a turn begins, and stops it
          after the idle grace period.
        </p>
      </div>
      <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2 lg:grid-cols-6">
        <div className="min-w-0">
          <span className="block uppercase tracking-wide">DS4 checkout</span>
          <code className="block truncate font-mono text-foreground" title={ds4Dir}>
            {isLoading ? "…" : ds4Dir}
          </code>
        </div>
        <div>
          <span className="block uppercase tracking-wide">Selected model</span>
          <code className="block truncate font-mono text-foreground" title={modelPreset}>
            {isLoading ? "…" : modelPreset}
          </code>
        </div>
        <div className="min-w-0">
          <span className="block uppercase tracking-wide">Model path</span>
          <code className="block truncate font-mono text-foreground" title={modelPath}>
            {isLoading ? "…" : modelPath}
          </code>
        </div>
        <div>
          <span className="block uppercase tracking-wide">Context window</span>
          <code className="font-mono text-foreground">
            {isLoading ? "…" : `${contextWindow} tokens`}
          </code>
        </div>
        <div>
          <span className="block uppercase tracking-wide">Idle grace</span>
          <code className="font-mono text-foreground">
            {isLoading ? "…" : `${idleTimeout}s`}
          </code>
        </div>
        <div className="min-w-0">
          <span className="block uppercase tracking-wide">Vision encoder</span>
          <code className="block truncate font-mono text-foreground" title={visionPath}>
            {isLoading ? "…" : visionPath || "off"}
          </code>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Choose the model in the <code className="font-mono">Model</code> setting.
        <code className="font-mono">Auto</code> uses the advanced model path;
        named selections find their standard GGUF in the DS4 checkout. The
        vision encoder defaults to <code className="font-mono">auto</code> and
        is picked up when the selected vision model's sidecar is present.
        Leave it empty to disable vision. Advanced runtime controls remain below.
      </p>
    </div>
  );
}

type ModelFileState = "present" | "missing" | "partial" | "unavailable";

type ModelFileStatus = {
  kind: "model" | "vision" | "dspark";
  label: string;
  path: string | null;
  required: boolean;
  state: ModelFileState;
  downloadTarget: string | null;
};

type ModelFilesStatus = {
  modelDisplayName: string;
  files: ModelFileStatus[];
  complete: boolean;
  downloadable: boolean;
  downloading: boolean;
  currentTarget: string | null;
  error: string | null;
  message: string;
};

function modelFileStateLabel(state: ModelFileState): string {
  switch (state) {
    case "present":
      return "Ready";
    case "partial":
      return "Partial download";
    case "missing":
      return "Missing";
    case "unavailable":
      return "Manual path";
  }
}

function modelFileStateClass(state: ModelFileState): string {
  switch (state) {
    case "present":
      return "text-emerald-500";
    case "partial":
      return "text-amber-500";
    case "missing":
      return "text-destructive";
    case "unavailable":
      return "text-muted-foreground";
  }
}

function modelFileName(path: string | null): string {
  if (!path) return "No path configured";
  return path.split(/[\\/]/).pop() || path;
}

function ModelFilesSection() {
  const rpc = useRpc<typeof rpcContract>();
  const realtimeConnection = useRealtimeConnectionState();
  const { values, isLoading: settingsLoading } = useSettings();
  const [status, setStatus] = useState<ModelFilesStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const settingsKey = JSON.stringify({
    ds4Dir: values?.ds4Dir,
    modelPreset: values?.modelPreset,
    modelPath: values?.modelPath,
    visionPath: values?.visionPath,
    dspark: values?.dspark,
    dsparkSupportPath: values?.dsparkSupportPath,
  });

  useEffect(() => {
    if (realtimeConnection !== "connected" || settingsLoading) return;
    let cancelled = false;
    let retryTimer: number | null = null;

    const poll = async () => {
      try {
        const next = await rpc.call("modelFiles", null);
        if (cancelled) return;
        setStatus(next);
        setActionError(null);
        setStatusLoading(false);
        if (next.downloading) {
          retryTimer = window.setTimeout(poll, 1_500);
        }
      } catch (error) {
        if (cancelled) return;
        setStatusLoading(false);
        setActionError(error instanceof Error ? error.message : String(error));
        retryTimer = window.setTimeout(poll, 3_000);
      }
    };

    setStatusLoading(true);
    void poll();
    return () => {
      cancelled = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, [realtimeConnection, rpc, settingsKey, settingsLoading, status?.downloading]);

  const download = useCallback(async () => {
    setActionBusy(true);
    setActionError(null);
    try {
      const next = await rpc.call("downloadModels", null);
      setStatus(next);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setActionBusy(false);
    }
  }, [rpc]);

  const message = actionError
    ? actionError
    : status?.message ??
      (settingsLoading
        ? "Loading model settings…"
        : realtimeConnection === "connected"
          ? "Checking selected model files…"
          : "Waiting for the BB server connection…");

  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-4 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-medium">Selected model files</p>
          <p className="mt-1 text-muted-foreground">
            Check the configured model, vision encoder, and optional DSpark file.
            Downloads run in the DS4 checkout and do not start automatically.
          </p>
        </div>
        {status ? (
          <span className="shrink-0 text-xs text-muted-foreground">
            {status.modelDisplayName}
          </span>
        ) : null}
      </div>

      <div className="space-y-2">
        {status?.files.map((file) => (
          <div
            key={`${file.kind}:${file.path ?? file.label}`}
            className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border/70 bg-background/30 px-3 py-2 text-xs"
          >
            <span className="w-32 shrink-0 font-medium">{file.label}</span>
            <code
              className="min-w-0 flex-1 truncate font-mono text-muted-foreground"
              title={file.path ?? undefined}
            >
              {modelFileName(file.path)}
            </code>
            <span className={`shrink-0 ${modelFileStateClass(file.state)}`}>
              {modelFileStateLabel(file.state)}
            </span>
          </div>
        )) ?? (
          <div className="rounded-md border border-border/70 px-3 py-2 text-xs text-muted-foreground">
            {statusLoading ? "Checking selected model files…" : "No model status available."}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p
          className={`min-w-0 flex-1 text-xs ${actionError ? "text-destructive" : "text-muted-foreground"}`}
          role="status"
          aria-live={actionError ? "assertive" : "polite"}
        >
          {message}
        </p>
        <button
          type="button"
          className="shrink-0 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-state-hover disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => void download()}
          disabled={
            actionBusy ||
            status?.downloading === true ||
            status?.downloadable !== true
          }
        >
          {actionBusy || status?.downloading
            ? `Downloading${status?.currentTarget ? ` ${status.currentTarget}` : ""}…`
            : "Download selected model files"}
        </button>
      </div>

      <p className="text-xs text-muted-foreground">
        Automatic downloads are available for named model selections. Custom
        paths and <code className="font-mono">Auto</code> require a manual
        download; partial files are safe to resume through the upstream script.
      </p>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "setup",
    title: "Automatic startup",
    description:
      "DwarfStar is managed on demand by the configured model.",
    component: SetupSection,
  });
  app.slots.settingsSection({
    id: "model-files",
    title: "Model files",
    description:
      "Check selected GGUF files and download missing standard files from DS4.",
    component: ModelFilesSection,
  });
  app.slots.experimental_threadHeaderAction({
    id: "lifecycle-bridge",
    title: "DwarfStar lifecycle",
    component: DwarfStarLifecycleBridge,
  });
  app.composer.customize({
    id: "lifecycle-status",
    scopes: ["thread", "new-thread"],
    banners: [
      {
        id: "dwarfstar-lifecycle",
        chrome: "card",
        component: DwarfStarLifecycleBanner,
      },
    ],
  });
});
