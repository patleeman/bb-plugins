// bb-plugin-ds4 — unified DwarfStar settings.

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

// ---------------------------------------------------------------------------
// Unified settings
// ---------------------------------------------------------------------------

type InstalledModelEntry = {
  preset: string;
  displayName: string;
  modelId: string | null;
  isSelected: boolean;
  isInstalled: boolean;
  files: {
    kind: "model" | "vision" | "dspark";
    label: string;
    path: string | null;
    required: boolean;
    state: "present" | "missing" | "partial" | "unavailable";
    downloadTarget: string | null;
  }[];
  targets: string[];
  downloadable: boolean;
  downloading: boolean;
  currentTarget: string | null;
  completedTargets: string[];
  startedAt: number | null;
  cancelled: boolean;
  error: string | null;
  output: string;
  message: string;
};

type InstalledModelsDto = {
  ds4Dir: string | null;
  selectedPreset: string;
  models: InstalledModelEntry[];
};

type StatusDto = {
  state: "stopped" | "starting" | "running" | "stopping" | "exited" | "crashed";
  displayState: string;
  config: { ds4Dir: string | null };
};

function modelFileStateLabel(state: string): string {
  switch (state) {
    case "present": return "Ready";
    case "partial": return "Partial";
    case "missing": return "Missing";
    case "unavailable": return "Manual";
    default: return state;
  }
}

function modelFileStateClass(state: string): string {
  switch (state) {
    case "present": return "text-emerald-500";
    case "partial": return "text-amber-500";
    case "missing": return "text-destructive";
    case "unavailable": return "text-muted-foreground";
    default: return "text-muted-foreground";
  }
}

function fileName(path: string | null): string {
  if (!path) return "No path";
  return path.split(/[\\/]/).pop() || path;
}

const PER_MODEL_KEYS = [
  "visionPath",
  "ctx",
  "maxTokens",
  "backend",
  "kvDiskDir",
  "kvDiskSpaceMb",
  "power",
  "extraArgs",
  "dspark",
  "dsparkSupportPath",
  "dsparkConfidence",
] as const;

function parsePerModel(raw: unknown): Record<string, Record<string, string | boolean>> {
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const p: unknown = JSON.parse(raw);
    if (!p || typeof p !== "object" || Array.isArray(p)) return {};
    return p as Record<string, Record<string, string | boolean>>;
  } catch { return {}; }
}

function useDwarfStarChromeFix() {
  useEffect(() => {
    // Pure-CSS hide: no mount-timing issues, survives re-renders, needs no app rebuild.
    // Our card has no <form>; the host declarative panel does — so :has(form) only matches the host panel.
    const style = document.createElement("style");
    style.setAttribute("data-ds4-reorder", "true");
    style.textContent = `
      [data-testid="plugin-detail-ds4"] { display: flex !important; flex-direction: column !important; gap: 1.5rem !important; }
      [data-testid="plugin-detail-ds4"] > * { margin-top: 0 !important; }
      [data-testid="plugin-detail-ds4"] [data-testid="plugin-settings-sections"] { order: -1 !important; }
      [data-testid="plugin-detail-ds4"] > *:has(form) { display: none !important; }
    `;
    document.head.appendChild(style);

    // JS fallback for engines without :has() — hide any direct child of the detail that contains a form.
    const hideHostPanel = () => {
      const detail = document.querySelector('[data-testid="plugin-detail-ds4"]') as HTMLElement | null;
      if (!detail) return;
      for (const child of Array.from(detail.children)) {
        if (!(child instanceof HTMLElement)) continue;
        if (child.querySelector("[data-testid='plugin-settings-sections']")) continue;
        if (child.querySelector("form")) child.style.display = "none";
      }
    };
    hideHostPanel();
    const observer = new MutationObserver(hideHostPanel);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => { style.remove(); observer.disconnect(); };
  }, []);
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block min-w-0">
      <span className="block text-xs font-medium text-foreground">{label}</span>
      {hint ? <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">{hint}</span> : null}
      <span className="mt-1 block">{children}</span>
    </label>
  );
}

const inputCls = "w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-primary";

function AdvancedSettings({ values, selectedPreset, isServerRunning }: {
  values: Record<string, string | boolean> | undefined;
  selectedPreset: string;
  isServerRunning: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const perModel = parsePerModel(values?.perModelConfig);
  const overrides = perModel[selectedPreset] ?? {};
  const str = (v: unknown, fallback = "") => typeof v === "string" ? v : fallback;
  const eff = (key: string, globalFallback = "") => {
    const o = (overrides as Record<string, unknown>)[key];
    if (typeof o === "string" || typeof o === "boolean") return o as string & boolean;
    const g = values?.[key];
    return (typeof g === "string" || typeof g === "boolean" ? g : globalFallback) as string & boolean;
  };
  const [drafts, setDrafts] = useState<Record<string, string | boolean>>({});
  useEffect(() => { setDrafts({}); }, [selectedPreset, values?.perModelConfig]);
  const get = (key: string, fallback = ""): string => {
    const d = drafts[key];
    if (typeof d === "string" || typeof d === "boolean") return String(d);
    const e = eff(key, fallback);
    return String(e ?? fallback);
  };
  const getBool = (key: string): boolean => {
    const d = drafts[key];
    if (typeof d === "boolean") return d;
    if (typeof d === "string") return d === "true";
    const e = eff(key);
    return e === true || e === "true";
  };
  const set = (key: string, v: string | boolean) => setDrafts((p) => ({ ...p, [key]: v }));
  const globalStr = (key: string, fallback = "") => {
    const d = drafts[`__global_${key}`];
    if (typeof d === "string" || typeof d === "boolean") return String(d);
    return str(values?.[key], fallback);
  };
  const setGlobal = (key: string, v: string | boolean) => setDrafts((p) => ({ ...p, [`__global_${key}`]: v }));
  const globalBool = (key: string, fallback = false) => {
    const d = drafts[`__global_${key}`];
    if (typeof d === "boolean") return d;
    const v = values?.[key];
    return typeof v === "boolean" ? v : fallback;
  };
  const hasChanges = Object.keys(drafts).length > 0;
  const isAuto = selectedPreset === "auto";
  const save = async () => {
    setSaving(true); setSaveError(null);
    try {
      const payload: Record<string, unknown> = {};
      const globalKeys = ["ds4Dir", "idleTimeoutSeconds", "host", "port", "modelPath"];
      for (const k of globalKeys) {
        const draftKey = `__global_${k}`;
        if (draftKey in drafts) payload[k] = drafts[draftKey];
      }
      if ("__global_restartOnCrash" in drafts) payload["restartOnCrash"] = drafts["__global_restartOnCrash"];
      const finalGlobal: Record<string, unknown> = { ...(values ?? {}) };
      for (const [k, v] of Object.entries(payload)) finalGlobal[k] = v;
      const nextOverrides: Record<string, unknown> = { ...(overrides as Record<string, unknown>) };
      for (const k of PER_MODEL_KEYS) {
        if (k in drafts) {
          const draftVal = drafts[k];
          const globalVal = finalGlobal[k];
          if (String(draftVal ?? "") === String(globalVal ?? "") || (draftVal === "" && (globalVal === "" || globalVal === undefined))) {
            delete nextOverrides[k];
          } else {
            nextOverrides[k] = draftVal;
          }
        }
      }
      const nextPerModel = { ...perModel };
      if (Object.keys(nextOverrides).length === 0) delete nextPerModel[selectedPreset];
      else nextPerModel[selectedPreset] = nextOverrides as Record<string, string | boolean>;
      if (JSON.stringify(nextPerModel) !== JSON.stringify(perModel)) {
        payload["perModelConfig"] = JSON.stringify(nextPerModel);
      }
      if (Object.keys(payload).length === 0) return;
      const res = await fetch(`/api/v1/plugins/ds4/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ values: payload }),
      });
      const body = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
      if (!res.ok || body?.ok === false) throw new Error(body?.error ?? `Save failed (HTTP ${res.status})`);
      setDrafts({});
      toast.success("DwarfStar settings saved", {
        description: isServerRunning ? "Applies on the next server start (restart to apply now)." : "Applies on the next start.",
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSaveError(msg);
      toast.error("Could not save settings", { description: msg });
    } finally { setSaving(false); }
  };
  const resetModel = async () => {
    if (!perModel[selectedPreset]) return;
    setSaving(true); setSaveError(null);
    try {
      const next = { ...perModel };
      delete next[selectedPreset];
      const res = await fetch(`/api/v1/plugins/ds4/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ values: { perModelConfig: JSON.stringify(next) } }),
      });
      const body = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
      if (!res.ok || body?.ok === false) throw new Error(body?.error ?? `Reset failed (HTTP ${res.status})`);
      setDrafts({});
      toast.success(`Cleared overrides for ${selectedPreset}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSaveError(msg);
    } finally { setSaving(false); }
  };
  const hasOverrides = Boolean(perModel[selectedPreset] && Object.keys(perModel[selectedPreset]).length);
  if (!expanded) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-lg border border-dashed border-border/60 bg-muted/10 px-3 py-2.5">
        <div className="min-w-0">
          <p className="text-sm font-medium">Advanced</p>
          <p className="text-xs text-muted-foreground">
            Context, backend, KV cache, DSpark for <span className="font-medium text-foreground">{selectedPreset === "auto" ? "Auto" : selectedPreset}</span>
            {hasOverrides ? " (customized)" : ""} · plus host & lifecycle for all models.
          </p>
        </div>
        <button type="button" onClick={() => setExpanded(true)} className="shrink-0 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted">Show</button>
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-lg border border-border/60">
      <div className="flex items-center justify-between gap-3 border-b border-border/60 bg-muted/20 px-3 py-2.5">
        <div className="min-w-0">
          <p className="text-sm font-medium">Advanced</p>
          <p className="text-xs text-muted-foreground">Top group is per-model · bottom group is global. {isServerRunning ? "Server restarts to apply." : "Applies on next start."}</p>
        </div>
        <button type="button" onClick={() => setExpanded(false)} className="shrink-0 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted">Hide</button>
      </div>
      <div className="space-y-5 p-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">This model — {selectedPreset === "auto" ? "Auto" : selectedPreset}{hasOverrides ? " · customized" : ""}</p>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <Field label="Context tokens (-c)" hint="Server -c and agent contextWindow."><input className={inputCls} value={get("ctx", "250000")} onChange={(e) => set("ctx", e.target.value)} inputMode="numeric" /></Field>
            <Field label="Max output tokens (-n)"><input className={inputCls} value={get("maxTokens", "384000")} onChange={(e) => set("maxTokens", e.target.value)} inputMode="numeric" /></Field>
            <Field label="Vision encoder" hint="auto detects sidecar · empty disables."><input className={inputCls} value={get("visionPath", "auto")} onChange={(e) => set("visionPath", e.target.value)} /></Field>
            <Field label="Backend" hint="auto lets ds4-server pick.">
              <select className={inputCls} value={get("backend", "auto")} onChange={(e) => set("backend", e.target.value)}>
                {["auto","metal","cuda","rocm","cpu"].map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            </Field>
            <Field label="KV disk cache dir" hint="Empty disables disk KV caching."><input className={inputCls} value={get("kvDiskDir", "/tmp/ds4-kv")} onChange={(e) => set("kvDiskDir", e.target.value)} /></Field>
            <Field label="KV disk budget (MB)"><input className={inputCls} value={get("kvDiskSpaceMb", "8192")} onChange={(e) => set("kvDiskSpaceMb", e.target.value)} inputMode="numeric" /></Field>
            <Field label="GPU duty cycle (--power, 1-100)" hint="Empty = 100."><input className={inputCls} value={get("power", "")} onChange={(e) => set("power", e.target.value)} placeholder="100" /></Field>
            <Field label="Extra ds4-server args" hint="Free-form flags."><input className={inputCls} value={get("extraArgs", "")} onChange={(e) => set("extraArgs", e.target.value)} placeholder="--flag value" /></Field>
          </div>
          <div className="mt-3 space-y-3 rounded-md border border-border/50 bg-background/40 p-3">
            <label className="flex items-center justify-between gap-3 text-xs font-medium">
              <span>Enable DSpark speculative decoding <span className="font-normal text-muted-foreground">— Flash-only opt-in</span></span>
              <input type="checkbox" checked={getBool("dspark")} onChange={(e) => set("dspark", e.target.checked)} className="size-4 accent-current" />
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="DSpark support GGUF" hint="Empty auto-detects 0731 file."><input className={inputCls} value={get("dsparkSupportPath", "")} onChange={(e) => set("dsparkSupportPath", e.target.value)} /></Field>
              <Field label="DSpark confidence (0–1)" hint="Empty = backend default."><input className={inputCls} value={get("dsparkConfidence", "")} onChange={(e) => set("dsparkConfidence", e.target.value)} placeholder="auto" /></Field>
            </div>
          </div>
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Host & lifecycle — all models</p>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <Field label="DS4 checkout directory" hint="Empty = auto-detect."><input className={inputCls} value={globalStr("ds4Dir", "")} onChange={(e) => setGlobal("ds4Dir", e.target.value)} placeholder="auto-detect" /></Field>
            <Field label="Stop after idle (seconds)" hint="0 = never stop automatically."><input className={inputCls} value={globalStr("idleTimeoutSeconds", "300")} onChange={(e) => setGlobal("idleTimeoutSeconds", e.target.value)} inputMode="numeric" /></Field>
            <Field label="Bind host"><input className={inputCls} value={globalStr("host", "127.0.0.1")} onChange={(e) => setGlobal("host", e.target.value)} /></Field>
            <Field label="Port"><input className={inputCls} value={globalStr("port", "8000")} onChange={(e) => setGlobal("port", e.target.value)} inputMode="numeric" /></Field>
            <Field label="Model GGUF path (Auto only)" hint="Empty = ds4flash.gguf."><input className={inputCls} value={globalStr("modelPath", "")} onChange={(e) => setGlobal("modelPath", e.target.value)} placeholder="ds4flash.gguf" /></Field>
            <div className="flex items-end justify-between gap-3 rounded-md border border-border/50 px-3 py-2.5">
              <span className="text-xs font-medium">Restart after crash</span>
              <input type="checkbox" checked={globalBool("restartOnCrash", true)} onChange={(e) => setGlobal("restartOnCrash", e.target.checked)} className="size-4 accent-current" />
            </div>
          </div>
        </div>
        {saveError ? <p className="text-xs text-destructive" role="alert">{saveError}</p> : null}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3">
          <button type="button" onClick={() => void resetModel()} disabled={saving || !hasOverrides} className="rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40">Reset this model to defaults</button>
          <div className="flex gap-2">
            <button type="button" onClick={() => setDrafts({})} disabled={saving || !hasChanges} className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-40">Discard</button>
            <button type="button" onClick={() => void save()} disabled={saving || !hasChanges} className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">{saving ? "Saving…" : "Save"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function UnifiedDwarfStarSettings() {
  useDwarfStarChromeFix();
  const { values, isLoading: settingsLoading } = useSettings();
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();

  const [installed, setInstalled] = useState<InstalledModelsDto | null>(null);
  const [detailed, setDetailed] = useState<StatusDto | null>(null);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [updatingPreset, setUpdatingPreset] = useState<string | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<string | null>(null);

  const settingsKey = JSON.stringify(values ?? null);

  // Poll status for restart warning
  useEffect(() => {
    if (connection !== "connected") return;
    let cancelled = false;
    let timer: number | null = null;
    const poll = async () => {
      try {
        const s = (await rpc.call("status", null)) as unknown as StatusDto;
        if (!cancelled) setDetailed(s);
      } catch { /* ignore */ }
      if (!cancelled) timer = window.setTimeout(poll, 4_000);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [connection, rpc, settingsKey]);

  // Live download updates from the server (start / per-target / finish / fail).
  // Downloads run detached on the server, so this also catches up after navigating back.
  useRealtime("model-downloads", (payload: unknown) => {
    if (!isRecord(payload) || !Array.isArray((payload as { models?: unknown }).models)) return;
    setInstalled(payload as unknown as InstalledModelsDto);
    setActionError(null);
  });

  // Poll installed models
  useEffect(() => {
    if (connection !== "connected" || settingsLoading) return;
    let cancelled = false;
    let timer: number | null = null;
    const poll = async () => {
      try {
        const data = (await (rpc.call as unknown as (m: string, v:unknown)=>Promise<unknown>)("installedModels", null)) as unknown as InstalledModelsDto;
        if (cancelled) return;
        setInstalled(data);
        setActionError(null);
        const anyDownloading = data.models.some((m) => m.downloading);
        timer = window.setTimeout(poll, anyDownloading ? 1_500 : 4_000);
      } catch (e) {
        if (cancelled) return;
        setActionError(e instanceof Error ? e.message : String(e));
        timer = window.setTimeout(poll, 3_000);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [connection, rpc, settingsKey, settingsLoading]);

  const selectedPreset = installed?.selectedPreset ?? (typeof values?.modelPreset === "string" ? values.modelPreset : "auto");
  const isServerRunning = detailed?.state === "running" || detailed?.state === "starting";
  const selectedEntry = installed?.models.find((m) => m.preset === selectedPreset) ?? installed?.models.find((m) => m.isSelected) ?? null;

  // Auto-reveal the log when the selected model's download fails so the error is visible.
  const selectedError = selectedEntry?.error ?? null;
  useEffect(() => {
    if (selectedError) setShowLog(true);
  }, [selectedError]);

  const updatePreset = useCallback(async (preset: string) => {
    setUpdatingPreset(preset);
    setActionError(null);
    try {
      const res = await fetch(`/api/v1/plugins/ds4/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ values: { modelPreset: preset } }),
      });
      const body = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
      if (!res.ok || body?.ok === false) {
        throw new Error(body?.error ?? `Failed to update model (HTTP ${res.status})`);
      }
      toast.success(`Active model: ${preset === "auto" ? "Auto" : preset}`, {
        description: isServerRunning ? "DwarfStar will restart with the new model." : "Will be used on the next turn.",
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setActionError(msg);
      toast.error("Could not change model", { description: msg });
    } finally {
      setUpdatingPreset(null);
      setPendingConfirm(null);
    }
  }, [isServerRunning]);

  const handleSelect = (preset: string) => {
    if (preset === selectedPreset) return;
    if (isServerRunning) {
      setPendingConfirm(preset);
    } else {
      void updatePreset(preset);
    }
  };

  type DownloadResponse = {
    downloading: boolean;
    currentTarget: string | null;
    downloadable: boolean;
    complete: boolean;
    message: string;
  };
  const rpcCall = rpc.call as unknown as (method: string, input: null) => Promise<unknown>;

  const handleDownload = useCallback(async () => {
    setDownloadBusy(true);
    setActionError(null);
    try {
      const next = (await rpcCall("downloadModels", null)) as unknown as DownloadResponse;
      if (next.downloading) {
        toast.success("Download started", {
          description: next.currentTarget
            ? `Downloading ${next.currentTarget}. It keeps running if you leave this page.`
            : "Model files are downloading. It keeps running if you leave this page.",
        });
      } else if (!next.complete) {
        // Server refused to start (already running, no script, nothing missing…) — surface why.
        setActionError(next.message);
        toast.error("Download did not start", { description: next.message });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setActionError(msg);
      toast.error("Download failed", { description: msg });
    } finally {
      setDownloadBusy(false);
    }
  }, [rpcCall]);

  const handleCancel = useCallback(async () => {
    setCancelling(true);
    try {
      await rpcCall("cancelDownload", null);
      toast.info("Download cancelled");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setActionError(msg);
      toast.error("Could not cancel download", { description: msg });
    } finally {
      setCancelling(false);
    }
  }, [rpcCall]);

  const ds4DirLabel = installed?.ds4Dir ?? (typeof values?.ds4Dir === "string" && values.ds4Dir ? values.ds4Dir : null);
  const hasCheckout = Boolean(ds4DirLabel);

  return (
    <div className="space-y-4">
      {/* Single unified card */}
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        {/* Header inside card */}
        <div className="border-b border-border/60 bg-muted/30 px-4 py-3">
          <h3 className="text-sm font-semibold">Active model</h3>
          <p className="mt-1 text-xs leading-snug text-muted-foreground">
            Pick which model DwarfStar runs on this host. The server starts on demand and stops after the idle grace period.
            {isServerRunning ? " Changing the model now will restart the running server." : ""}
          </p>
        </div>

        <div className="space-y-4 p-4">
          {!hasCheckout ? (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              DS4 checkout not found. Set the checkout directory in settings so models can be detected and downloaded.
            </div>
          ) : null}

          {/* Model grid */}
          <div className="grid gap-2 sm:grid-cols-2">
            {installed ? installed.models.filter((m) => m.preset !== "auto").map((model) => {
              const isSelected = model.preset === selectedPreset;
              const busy = updatingPreset === model.preset;
              return (
                <button
                  key={model.preset}
                  type="button"
                  disabled={busy}
                  onClick={() => handleSelect(model.preset)}
                  className={[
                    "group relative flex flex-col rounded-lg border px-3 py-3 text-left transition-colors",
                    isSelected
                      ? "border-primary bg-primary/5 ring-1 ring-primary"
                      : "border-border bg-background hover:bg-muted/40 hover:border-border/80",
                    busy ? "opacity-60" : "",
                  ].join(" ")}
                >
                  {isSelected ? (
                    <span className="absolute right-2 top-2 rounded-full bg-primary px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary-foreground">
                      Active
                    </span>
                  ) : null}
                  <span className="pr-12 text-sm font-medium leading-tight">{model.displayName}</span>
                  <span className={["mt-1.5 inline-flex items-center gap-1.5 text-xs", model.isInstalled ? "text-emerald-600 dark:text-emerald-400" : model.downloading ? "text-amber-600" : "text-muted-foreground"].join(" ")}>
                    <span className={["size-1.5 rounded-full", model.isInstalled ? "bg-emerald-500" : model.downloading ? "bg-amber-500 animate-pulse" : "bg-muted-foreground/60"].join(" ")} aria-hidden />
                    {model.downloading ? "Downloading…" : model.isInstalled ? "Installed" : "Not installed"}
                    {busy ? " — switching…" : ""}
                  </span>
                  <span className="mt-1 line-clamp-1 text-[11px] text-muted-foreground" title={model.message}>
                    {model.message}
                    {model.isInstalled ? "" : model.targets.length ? ` — ${model.targets.join(", ")}` : ""}
                  </span>
                </button>
              );
            }) : (
              <div className="col-span-2 rounded-md border border-border/60 px-3 py-6 text-center text-xs text-muted-foreground">
                {settingsLoading || connection !== "connected" ? "Loading installed models…" : "No model status yet."}
              </div>
            )}
            {/* Auto card */}
            {installed ? (() => {
              const auto = installed.models.find((m) => m.preset === "auto");
              if (!auto) return null;
              const isSelected = auto.preset === selectedPreset;
              const busy = updatingPreset === auto.preset;
              return (
                <button
                  key="auto"
                  type="button"
                  disabled={busy}
                  onClick={() => handleSelect(auto.preset)}
                  className={[
                    "flex flex-col rounded-lg border px-3 py-3 text-left transition-colors sm:col-span-2",
                    isSelected ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-dashed border-border bg-muted/20 hover:bg-muted/30",
                    busy ? "opacity-60" : "",
                  ].join(" ")}
                >
                  <span className="text-sm font-medium">Auto <span className="font-normal text-muted-foreground">(custom GGUF path)</span></span>
                  <span className="mt-1 text-xs text-muted-foreground">
                    Uses <code className="font-mono text-[11px]">Model GGUF path</code> above. Best for custom or legacy checkouts. Not auto-downloadable.
                  </span>
                  {isSelected ? <span className="mt-1 text-xs font-medium text-primary">Active</span> : null}
                </button>
              );
            })() : null}
          </div>

          {isServerRunning ? (
            <p className="flex items-center gap-1.5 rounded-md bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-700 dark:text-amber-300">
              <span aria-hidden className="size-1.5 shrink-0 animate-pulse rounded-full bg-amber-500" />
              DwarfStar is currently running — switching the active model will restart the server.
            </p>
          ) : null}

          {/* Selected model file details */}
          <div className="rounded-lg border border-border/60 bg-muted/20">
            <div className="flex items-center justify-between gap-3 border-b border-border/60 px-3 py-2.5">
              <div className="min-w-0">
                <p className="text-sm font-medium">Model files</p>
                <p className="text-xs text-muted-foreground">
                  {selectedEntry ? `${selectedEntry.displayName} — ${selectedEntry.message}` : "Select a model to see its files."}
                </p>
              </div>
              {selectedEntry ? (
                <span className={["shrink-0 rounded-full px-2 py-1 text-[11px] font-medium", selectedEntry.isInstalled ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : selectedEntry.downloading ? "bg-amber-500/15 text-amber-700 dark:text-amber-300" : "bg-destructive/10 text-destructive"].join(" ")}>
                  {selectedEntry.downloading ? "Downloading" : selectedEntry.isInstalled ? "Ready" : selectedEntry.error ? "Failed" : "Needs download"}
                </span>
              ) : null}
            </div>

            <div className="space-y-1.5 p-3">
              {selectedEntry?.files.map((file) => (
                <div
                  key={`${file.kind}:${file.path ?? file.label}`}
                  className="flex min-w-0 items-center justify-between gap-3 rounded-md border border-border/50 bg-background/60 px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="text-xs font-medium">{file.label}</p>
                    <code className="block truncate font-mono text-[11px] text-muted-foreground" title={file.path ?? undefined}>
                      {fileName(file.path)}
                    </code>
                  </div>
                  <span className={["shrink-0 text-xs font-medium", modelFileStateClass(file.state)].join(" ")}>
                    {modelFileStateLabel(file.state)}
                  </span>
                </div>
              )) ?? (
                <p className="rounded-md border border-border/50 bg-background/60 px-3 py-3 text-center text-xs text-muted-foreground">
                  No file status available.
                </p>
              )}
            </div>

            <div className="space-y-2 border-t border-border/60 px-3 py-2.5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className={["min-w-0 flex-1 text-xs", actionError || selectedEntry?.error ? "text-destructive" : "text-muted-foreground"].join(" ")} role="status">
                  {actionError ?? selectedEntry?.message ?? "Check that the DS4 checkout is set, then download the selected model's GGUF files."}
                </p>
                <div className="flex shrink-0 gap-2">
                  {selectedEntry?.downloading ? (
                    <button
                      type="button"
                      onClick={() => void handleCancel()}
                      disabled={cancelling}
                      className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
                    >
                      {cancelling ? "Cancelling…" : "Cancel"}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => void handleDownload()}
                    disabled={
                      downloadBusy ||
                      selectedEntry?.downloading === true ||
                      selectedEntry?.downloadable !== true
                    }
                    className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {downloadBusy || selectedEntry?.downloading ? "Downloading…" : selectedEntry?.error ? "Retry download" : "Download model files"}
                  </button>
                </div>
              </div>
              {selectedEntry?.error ? (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2" role="alert">
                  <p className="text-xs font-medium text-destructive">Download failed</p>
                  <p className="mt-0.5 break-words text-xs text-destructive/90">{selectedEntry.error}</p>
                  <p className="mt-1 text-[11px] text-muted-foreground">Partial files are kept and resume on retry. Open the log below for the full script output, or run <code className="font-mono">bb ds4 download-log</code>.</p>
                </div>
              ) : null}
              {selectedEntry?.cancelled && !selectedEntry?.error ? (
                <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-300">
                  Download cancelled. Partial files are kept and resume on retry.
                </p>
              ) : null}
              {(selectedEntry?.output || selectedEntry?.downloading || selectedEntry?.error) ? (
                <div className="overflow-hidden rounded-md border border-border/50">
                  <button
                    type="button"
                    onClick={() => setShowLog((v) => !v)}
                    className="flex w-full items-center justify-between bg-background/60 px-3 py-1.5 text-xs font-medium hover:bg-muted/40"
                    aria-expanded={showLog}
                  >
                    <span>Download log{selectedEntry?.downloading ? " (live)" : ""}</span>
                    <span className="font-normal text-muted-foreground">{showLog ? "Hide" : "Show"}</span>
                  </button>
                  {showLog ? (
                    <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words bg-background/40 px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
                      {selectedEntry?.output || "No output yet — waiting for the downloader to print."}
                    </pre>
                  ) : null}
                </div>
              ) : null}
            </div>
            <p className="border-t border-border/60 px-3 py-2 text-[11px] leading-snug text-muted-foreground">
              Downloads run on the server in the DS4 checkout and keep going if you leave this page — this card catches up when you come back. Partial files resume on retry. Custom paths (<code className="font-mono">Auto</code>) must be downloaded manually.
            </p>
          </div>

          <AdvancedSettings values={values} selectedPreset={selectedPreset} isServerRunning={isServerRunning} />
        </div>
      </div>

      {/* Confirm restart dialog */}
      {pendingConfirm ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-label="Restart DwarfStar?">
          <div className="w-full max-w-md rounded-lg border border-border bg-card p-5 shadow-lg">
            <h4 className="text-sm font-semibold">Restart DwarfStar?</h4>
            <p className="mt-2 text-sm leading-snug text-muted-foreground">
              DwarfStar is currently running. Switching to <span className="font-medium text-foreground">{pendingConfirm === "auto" ? "Auto" : pendingConfirm}</span> will restart the server. Any active turn using the current model will be interrupted.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
                onClick={() => setPendingConfirm(null)}
                disabled={updatingPreset !== null}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                onClick={() => void updatePreset(pendingConfirm)}
                disabled={updatingPreset !== null}
              >
                {updatingPreset ? "Switching…" : "Restart and switch"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "dwarfstar",
    title: "DwarfStar",
    description: "Choose the active local model and manage its files. DwarfStar starts on demand and stops after idle.",
    component: UnifiedDwarfStarSettings,
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
