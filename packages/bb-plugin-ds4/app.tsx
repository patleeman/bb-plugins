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
  const modelSelector =
    typeof values?.modelSelector === "string" ? values.modelSelector : "ds4/";
  const providerId =
    typeof values?.providerId === "string" && values.providerId
      ? values.providerId
      : "any provider";
  const idleTimeout =
    typeof values?.idleTimeoutSeconds === "string"
      ? values.idleTimeoutSeconds
      : "300";

  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-4 text-sm">
      <div>
        <p className="font-medium">Automatic local model lifecycle</p>
        <p className="mt-1 text-muted-foreground">
          Configure the DS4 checkout and model above, then choose the matching
          model in BB&apos;s model picker. DwarfStar starts when a turn uses that
          model and stops after the last matching turn has been idle.
        </p>
      </div>
      <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
        <div>
          <span className="block uppercase tracking-wide">Model selector</span>
          <code className="font-mono text-foreground">
            {isLoading ? "…" : modelSelector}
          </code>
        </div>
        <div>
          <span className="block uppercase tracking-wide">Provider filter</span>
          <code className="font-mono text-foreground">
            {isLoading ? "…" : providerId}
          </code>
        </div>
        <div>
          <span className="block uppercase tracking-wide">Idle grace</span>
          <code className="font-mono text-foreground">
            {isLoading ? "…" : `${idleTimeout}s`}
          </code>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        The selector defaults to <code className="font-mono">ds4/</code>, which
        matches DwarfStar&apos;s DeepSeek V4 and GLM 5.2 model ids. Leave the
        provider filter empty unless the same model id is used by more than
        one provider.
      </p>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "setup",
    title: "Automatic startup",
    description:
      "DwarfStar is managed on demand by the model selected in BB.",
    component: SetupSection,
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
