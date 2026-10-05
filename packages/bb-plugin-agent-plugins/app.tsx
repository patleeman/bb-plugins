// bb-plugin-agent-plugins — frontend
// Visual thesis: quiet system setting, not a dashboard. One install bar + one list. No nested cards.
import { useCallback, useEffect, useRef, useState } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { serversNeedingAttention } from "./src/attention";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

type Snapshot = {
  plugins: {
    id: string;
    name: string;
    version: string | null;
    specVersion: string;
    sourceType: string;
    sourceIntent: string;
    sourceResolved: string | null;
    status: string;
    approval: string;
    lastError: string | null;
  }[];
  skills: { pluginId: string; skillName: string; status: string; lastError: string | null; enabled: boolean }[];
  mcpServers: { pluginId: string; serverId: string; type: string; status: string; authStatus?: string; lastError: string | null; approved: number; enabled: boolean; configJson: string }[];
  updates?: PluginUpdate[];
  dataDir: string | null;
};

type PluginUpdate = {
  id: string;
  currentVersion: string | null;
  latestVersion: string | null;
  available: boolean;
  checkedAt: number;
  error: string | null;
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function notifyError(message: string, id: string): void {
  toast.error(message, { id, duration: 8000 });
}

function Dot({ status }: { status: string }) {
  const c =
    status === "active" || status === "ready"
      ? "bg-success"
      : status === "needs-approval" || status === "needs-auth" || status === "pending"
        ? "bg-warning"
        : status === "error" || status === "conflicted"
          ? "bg-destructive"
          : "bg-muted-foreground";
  return <span className={`h-1.5 w-1.5 rounded-full ${c}`} aria-hidden="true" />;
}

function Toggle({
  checked,
  disabled,
  label,
  onCheckedChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 ${checked ? "bg-primary" : "bg-muted"}`}
    >
      <span
        aria-hidden="true"
        className={`pointer-events-none block h-4 w-4 rounded-full shadow-sm transition-transform ${checked ? "translate-x-4 bg-primary-foreground" : "translate-x-0.5 bg-muted-foreground"}`}
      />
    </button>
  );
}

function navigateAuthorizationWindow(authWindow: Window | null, url: string | null): void {
  if (!url) {
    authWindow?.close();
    return;
  }
  if (authWindow) {
    try {
      authWindow.opener = null;
      authWindow.location.href = url;
      return;
    } catch {
      // Fall through to a normal new-tab attempt if the pre-opened window is
      // unavailable (for example, a test or embedded browser surface).
    }
  }
  const opened = window.open(url, "_blank", "noopener,noreferrer");
  if (!opened) {
    throw new Error("BB could not open the authorization window. Allow pop-ups and try again.");
  }
}

type AuthMethod = "authenticate" | "reconnect" | "reauthorize";

async function startAuthFlow(
  rpc: ReturnType<typeof useRpc<typeof rpcContract>>,
  method: AuthMethod,
  p: string,
  s: string,
): Promise<void> {
  const key = `mcp-auth:${p}:${s}`;
  // Open synchronously inside the click so pop-up blockers allow it.
  const authWindow = window.open("about:blank", "_blank");
  try {
    const result = await rpc.call(method, { id: p, serverId: s });
    navigateAuthorizationWindow(authWindow, result.url);
    if (result.url) {
      toast.info("Authorization window opened", {
        description: "Finish the consent flow, then return to BB.",
        id: `${key}:started`,
        duration: 7000,
      });
    } else {
      toast.success(`${s} connected`, { id: `${key}:connected`, duration: 4000 });
    }
  } catch (e) {
    authWindow?.close();
    throw e;
  }
}

function useSnapshot() {
  const rpc = useRpc<typeof rpcContract>();
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const requestRef = useRef(0);
  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    try {
      const s = (await rpc.call("snapshot", null)) as unknown as Snapshot;
      if (requestId !== requestRef.current) return;
      setSnap(s);
      setErr(null);
    } catch (e) {
      if (requestId !== requestRef.current) return;
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [rpc]);
  useEffect(() => { void load(); }, [load]);
  useRealtime("agent-plugins-changed", () => { void load(); });
  return { snap, err, load, rpc };
}

function InstallBar({ onDone }: { onDone: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [value, setValue] = useState("");
  const [state, setState] = useState<"idle" | "installing" | "success" | "error">("idle");
  const [msg, setMsg] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const timerRef = useRef<number | null>(null);

  const handleBrowse = async () => {
    try {
      setPicking(true);
      const res = await rpc.call("pickFolder", null);
      if (res.path) setValue(res.path);
    } catch (e) {
      const message = errorText(e);
      setState("error");
      setMsg(message);
      notifyError(message, "agent-plugins:pick-folder:error");
    } finally {
      setPicking(false);
    }
  };

  const submit = async () => {
    const v = value.trim();
    if (!v) {
      const message = "Enter a path, git URL, or npm spec.";
      setState("error");
      setMsg(message);
      notifyError(message, "agent-plugins:install:error");
      return;
    }
    try {
      setState("installing"); setMsg(null);
      const res = await rpc.call("install", { source: v });
      setState("success");
      setMsg(`Installed ${res.name ?? v} — skills will appear next session.`);
      toast.success("Plugin installed", {
        description: `${res.name ?? v} is ready for the next session.`,
        duration: 5000,
      });
      setValue("");
      onDone();
      if (timerRef.current) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => { setState("idle"); setMsg(null); }, 3000) as unknown as number;
    } catch (e) {
      const message = errorText(e);
      setState("error");
      setMsg(message);
      notifyError(message, "agent-plugins:install:error");
    }
  };

  useEffect(() => () => { if (timerRef.current) window.clearTimeout(timerRef.current); }, []);

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && state !== "installing") void submit(); }}
          placeholder="path:/Users/you/my-plugin  •  https://github.com/acme/my-plugin  •  npm:my-plugin@^1.0"
          className="h-9 flex-1 font-mono text-xs"
          aria-label="Plugin location"
          disabled={state === "installing"}
        />
        <Button
          variant="outline"
          size="sm"
          className="h-9 shrink-0"
          onClick={() => void handleBrowse()}
          disabled={state === "installing" || picking}
          aria-label="Browse for folder"
        >
          {picking ? "…" : "Browse…"}
        </Button>
        <Button
          size="sm"
          className="h-9 min-w-[84px] shrink-0"
          onClick={() => void submit()}
          disabled={state === "installing" || !value.trim()}
        >
          {state === "installing" ? (
            <span className="inline-flex items-center gap-1.5">
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />
              Installing
            </span>
          ) : (
            "Install"
          )}
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-[11px] leading-none">
        <span className="text-muted-foreground">Local path, Git, or npm — updates keep your data.</span>
        <span className="hidden sm:inline text-muted-foreground">·</span>
        <span className="font-mono text-muted-foreground">/abs/path</span>
        <span className="font-mono text-muted-foreground">npm:…</span>
      </div>

      {state !== "idle" && msg && (
        <div
          className={`rounded-md border px-3 py-2 text-xs leading-snug ${
            state === "success"
              ? "border-success/30 bg-success/10 text-success"
              : state === "error"
                ? "border-destructive/30 bg-destructive/10 text-destructive"
                : "border-border bg-muted/40 text-muted-foreground"
          }`}
          role={state === "error" ? "alert" : "status"}
          aria-live="polite"
        >
          {msg}
        </div>
      )}
    </div>
  );
}

function CallbackPasteForm({
  pluginId, serverId, busy, onFinish,
}: {
  pluginId: string;
  serverId: string;
  busy: boolean;
  onFinish: (url: string) => Promise<boolean>;
}) {
  const [callbackUrl, setCallbackUrl] = useState("");
  return (
    <form className="mt-3 space-y-2" onSubmit={(event) => {
      event.preventDefault();
      if (!callbackUrl.trim()) return;
      void onFinish(callbackUrl.trim()).then((completed) => { if (completed) setCallbackUrl(""); });
    }}>
      <label className="block text-[11px] leading-snug text-muted-foreground" htmlFor={`mcp-callback-${pluginId}-${serverId}`}>
        If your browser cannot open localhost after sign-in, copy its full address and paste it here. The URL contains a one-use code; do not paste it into chat.
      </label>
      <div className="flex flex-wrap gap-2">
        <Input id={`mcp-callback-${pluginId}-${serverId}`} aria-label={`Callback URL for ${serverId}`} type="url" className="min-w-0 flex-1 text-xs" value={callbackUrl} onChange={(event) => setCallbackUrl(event.target.value)} autoComplete="off" spellCheck={false} disabled={busy} />
        <Button type="submit" size="sm" variant="outline" disabled={busy || !callbackUrl.trim()}>{busy ? "Finishing…" : "Finish sign-in"}</Button>
      </div>
    </form>
  );
}

function PluginRow({
  plugin,
  update,
  skills,
  servers,
  onRemove,
  onApprove,
  onAuthenticate,
  onReconnect,
  onReauthorize,
  onDisconnect,
  onFinishAuthentication,
  onSkillEnabledChange,
  onMcpEnabledChange,
  onUpdate,
  pendingAction,
}: {
  plugin: Snapshot["plugins"][number];
  update?: PluginUpdate;
  skills: Snapshot["skills"];
  servers: Snapshot["mcpServers"];
  onRemove: (id: string) => void;
  onApprove: (p: string, s: string) => void;
  onAuthenticate: (p: string, s: string) => void;
  onReconnect: (p: string, s: string) => void;
  onReauthorize: (p: string, s: string) => void;
  onDisconnect: (p: string, s: string) => void;
  onFinishAuthentication: (p: string, s: string, url: string) => Promise<boolean>;
  onSkillEnabledChange: (pluginId: string, skillName: string, enabled: boolean) => void;
  onMcpEnabledChange: (pluginId: string, serverId: string, enabled: boolean) => void;
  onUpdate: (pluginId: string) => void;
  pendingAction: string | null;
}) {
  const [open, setOpen] = useState(false);
  const updateKey = `update:${plugin.id}`;
  const hasIssues = skills.some((s) => s.enabled && (s.status === "error" || s.status === "conflicted")) || servers.some((s) => s.enabled && (s.status === "error" || s.status === "needs-auth"));
  const issueMessage = skills.find((s) => s.enabled && s.lastError)?.lastError ?? servers.find((s) => s.enabled && s.lastError)?.lastError ?? "One or more capabilities need attention.";
  const enabledSkillCount = skills.filter((s) => s.enabled).length;
  const enabledServerCount = servers.filter((s) => s.enabled).length;

  return (
    <div className="group">
      <div className="flex w-full items-center gap-3 px-4 py-3 hover:bg-muted/30">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-3 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          aria-expanded={open}
        >
          <Dot status={plugin.status} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="truncate text-sm font-medium leading-none">{plugin.name}</span>
              {plugin.version && <span className="text-xs text-muted-foreground">v{plugin.version}</span>}
              <span className="text-xs text-muted-foreground">· {plugin.sourceType}</span>
              <span className={`text-xs ${plugin.status === "active" ? "text-muted-foreground" : plugin.status === "needs-approval" ? "text-warning" : "text-destructive"}`}>
                {plugin.status}
              </span>
              {update?.available && (
                <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                  Update available{update.latestVersion ? ` · v${update.latestVersion}` : ""}
                </span>
              )}
              {update?.error && (
                <span className="text-[10px] text-warning" title={update.error}>
                  Update check failed
                </span>
              )}
            </div>
            <div className="mt-0.5 truncate font-mono text-[11px] leading-none text-muted-foreground">{plugin.sourceIntent}</div>
          </div>

          <div className="hidden shrink-0 items-center gap-3 sm:flex">
            <span className="text-xs tabular-nums text-muted-foreground">
              {skills.length} skill{skills.length === 1 ? "" : "s"}
              {servers.length ? ` · ${servers.length} MCP` : ""}
            </span>
            <span className="text-xs text-muted-foreground">{open ? "▴" : "▾"}</span>
          </div>

          <span className="shrink-0 text-xs text-muted-foreground sm:hidden">{open ? "▴" : "▾"}</span>
        </button>

        {update?.available && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 shrink-0 px-2 text-xs"
            disabled={pendingAction === updateKey}
            onClick={() => onUpdate(plugin.id)}
            aria-label={`Update ${plugin.name}${update.latestVersion ? ` to version ${update.latestVersion}` : ""}`}
          >
            {pendingAction === updateKey ? "Updating…" : "Update"}
          </Button>
        )}
      </div>

      {open && (
        <div className="border-t border-border bg-muted/[0.03] px-4 py-3">
          {skills.length > 0 && (
            <section aria-label="Skills">
              <div className="mb-2 flex items-baseline justify-between gap-3">
                <h3 className="text-xs font-medium">Skills</h3>
                <span className="text-[11px] tabular-nums text-muted-foreground">
                  {enabledSkillCount}/{skills.length} enabled
                </span>
              </div>
              <div className="overflow-hidden rounded-md border border-border bg-background">
                <div className="divide-y divide-border">
                  {skills.map((s) => {
                    const toggleKey = `skill:${plugin.id}:${s.skillName}`;
                    const displayStatus = s.enabled ? s.status : "disabled";
                    return (
                      <div key={s.skillName} className="flex items-start gap-3 px-3 py-3">
                        <Dot status={displayStatus} />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-xs">/{s.skillName}</span>
                            <span className="text-[11px] text-muted-foreground">{displayStatus}</span>
                          </div>
                          <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
                            {s.enabled ? "Available to agents in the next session." : "Disabled; it will not be materialized for agents."}
                          </p>
                          {s.lastError && (
                            <p className="mt-1 text-[11px] leading-snug text-destructive" role="alert">{s.lastError}</p>
                          )}
                        </div>
                        <Toggle
                          checked={s.enabled}
                          disabled={pendingAction === toggleKey}
                          label={`${s.enabled ? "Disable" : "Enable"} skill ${s.skillName}`}
                          onCheckedChange={(enabled) => onSkillEnabledChange(plugin.id, s.skillName, enabled)}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            </section>
          )}

          {hasIssues && (
            <p className="mt-3 text-xs leading-snug text-destructive" role="alert">{issueMessage}</p>
          )}

          {servers.length > 0 && (
            <section className="mt-4" aria-label="MCP servers">
              <div className="mb-2 flex items-baseline justify-between gap-3">
                <h3 className="text-xs font-medium">MCP servers</h3>
                <span className="text-[11px] tabular-nums text-muted-foreground">
                  {enabledServerCount}/{servers.length} enabled
                </span>
              </div>
              <p className="mb-2 text-[11px] leading-snug text-muted-foreground">
                Servers stay off until enabled and approved. Configuration values are redacted where sensitive.
              </p>
              <div className="overflow-hidden rounded-md border border-border bg-background">
                <div className="divide-y divide-border">
                  {servers.map((srv) => {
                    let cfg: Record<string, unknown> | null = null;
                    try { cfg = JSON.parse(srv.configJson) as Record<string, unknown>; } catch {}
                    const isStdio = srv.type === "stdio";
                    const toggleKey = `mcp:${plugin.id}:${srv.serverId}`;
                    const authKey = `mcp-auth:${plugin.id}:${srv.serverId}`;
                    const displayStatus = srv.enabled ? srv.status : "disabled";
                    const authStatus = srv.authStatus ?? "unknown";
                    const canManageAuth = !isStdio && srv.approved === 1;
                    const isAuthBusy = pendingAction === authKey;
                    return (
                      <div key={srv.serverId} className="px-3 py-3">
                        <div className="flex items-start gap-3">
                          <Dot status={displayStatus} />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-xs font-medium">MCP: <span className="font-mono">{srv.serverId}</span></span>
                              <span className="text-[11px] text-muted-foreground">{displayStatus}</span>
                              <span className={srv.approved ? "text-[11px] text-success" : "text-[11px] text-warning"}>
                                {srv.approved ? "approved" : "needs approval"}
                              </span>
                              {!isStdio && <span className="text-[11px] text-muted-foreground">auth: {authStatus}</span>}
                            </div>
                            <div className="mt-1.5 space-y-1 font-mono text-[11px] leading-snug text-muted-foreground">
                              {isStdio ? (
                                <>
                                  <div>Command: {(cfg?.command as string) ?? "—"}</div>
                                  {cfg?.args !== undefined && <div>Args: {JSON.stringify(cfg.args)}</div>}
                                  {cfg?.cwd !== undefined && <div>Cwd: {String(cfg.cwd)}</div>}
                                  {cfg?.env !== undefined && <div>Env keys: {Object.keys(cfg.env as Record<string, unknown>).join(", ") || "—"} (values redacted)</div>}
                                </>
                              ) : (
                                <>
                                  <div>URL: {(cfg?.url as string) ?? "—"}</div>
                                  {cfg?.headers !== undefined && <div>Headers: {Object.keys(cfg.headers as Record<string, unknown>).join(", ") || "—"} (values redacted)</div>}
                                </>
                              )}
                            </div>
                            {srv.lastError && <p className="mt-1.5 text-[11px] leading-snug text-destructive" role="alert">{srv.lastError}</p>}
                            {canManageAuth && srv.enabled && srv.status !== "ready" && authStatus !== "authenticated" && (
                              <Button size="sm" variant="outline" className="mt-2 h-7 text-xs" disabled={isAuthBusy} onClick={() => onAuthenticate(plugin.id, srv.serverId)}>
                                {authStatus === "authorizing" ? "Continue authentication" : "Authenticate"} {srv.serverId}
                              </Button>
                            )}
                            {canManageAuth && srv.enabled && authStatus === "authorizing" && (
                              <CallbackPasteForm pluginId={plugin.id} serverId={srv.serverId} busy={isAuthBusy} onFinish={(url) => onFinishAuthentication(plugin.id, srv.serverId, url)} />
                            )}
                            {canManageAuth && srv.enabled && (srv.status === "ready" || srv.status === "error" || (srv.status === "idle" && authStatus === "authenticated")) && (
                              <Button size="sm" variant="outline" className="mt-2 h-7 text-xs" disabled={isAuthBusy} onClick={() => onReconnect(plugin.id, srv.serverId)}>
                                Reconnect {srv.serverId}
                              </Button>
                            )}
                            {canManageAuth && (authStatus === "authenticated" || authStatus === "authorizing") && (
                              <div className="mt-2 flex flex-wrap gap-2">
                                {srv.enabled && (
                                  <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={isAuthBusy} onClick={() => onReauthorize(plugin.id, srv.serverId)}>
                                    Reauthorize
                                  </Button>
                                )}
                                <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive" disabled={isAuthBusy} onClick={() => onDisconnect(plugin.id, srv.serverId)}>
                                  Disconnect
                                </Button>
                              </div>
                            )}
                            {srv.enabled && srv.approved !== 1 && srv.status !== "error" && (
                              <Button size="sm" variant="outline" className="mt-2 h-7 text-xs" onClick={() => onApprove(plugin.id, srv.serverId)}>
                                Approve &amp; start {srv.serverId}
                              </Button>
                            )}
                            {srv.enabled && srv.approved === 1 && srv.status === "error" && (
                              <Button size="sm" variant="outline" className="mt-2 h-7 text-xs" onClick={() => onApprove(plugin.id, srv.serverId)}>
                                Retry {srv.serverId}
                              </Button>
                            )}
                            {!srv.enabled && srv.approved !== 1 && (
                              <p className="mt-1.5 text-[11px] text-muted-foreground">Enable this server before approving it.</p>
                            )}
                          </div>
                          <Toggle
                            checked={srv.enabled}
                            disabled={pendingAction === toggleKey}
                            label={`${srv.enabled ? "Disable" : "Enable"} MCP server ${srv.serverId}`}
                            onCheckedChange={(enabled) => onMcpEnabledChange(plugin.id, srv.serverId, enabled)}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </section>
          )}

          <div className="mt-3 flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
              onClick={() => onRemove(plugin.id)}
            >
              Remove
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function AgentPluginsView() {
  const { snap, err, load } = useSnapshot();
  const rpc = useRpc<typeof rpcContract>();
  const [localErr, setLocalErr] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [updates, setUpdates] = useState<Record<string, PluginUpdate>>({});
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const checkedUpdatesRef = useRef(false);
  const previousPluginsRef = useRef<Map<string, { status: string; lastError: string | null }> | null>(null);
  const previousSkillsRef = useRef<Map<string, { status: string; lastError: string | null }> | null>(null);
  const previousServersRef = useRef<Map<string, { status: string; authStatus?: string; lastError: string | null }> | null>(null);
  const previousLoadErrorRef = useRef<string | null>(null);

  const checkUpdates = useCallback(async (id?: string, refresh = false) => {
    setCheckingUpdates(true);
    try {
      const result = await rpc.call("checkUpdates", {
        ...(id ? { id } : {}),
        ...(refresh ? { refresh: true } : {}),
      });
      setUpdates((current) => {
        const next = { ...current };
        for (const update of result.updates as unknown as PluginUpdate[]) next[update.id] = update;
        return next;
      });
    } catch (e) {
      const message = errorText(e);
      setLocalErr(message);
      notifyError(message, "agent-plugins:updates:error");
    } finally {
      setCheckingUpdates(false);
    }
  }, [rpc]);

  useEffect(() => {
    if (!snap || checkedUpdatesRef.current) return;
    checkedUpdatesRef.current = true;
    void checkUpdates();
  }, [snap, checkUpdates]);

  useEffect(() => {
    if (!snap) return;
    const installedIds = new Set(snap.plugins.map((plugin) => plugin.id));
    setUpdates((current) => {
      const next = snap.updates
        ? Object.fromEntries(snap.updates.map((update) => [update.id, update]))
        : Object.fromEntries(Object.entries(current).filter(([id]) => installedIds.has(id)));
      return Object.fromEntries(Object.entries(next).filter(([id]) => installedIds.has(id)));
    });
  }, [snap]);

  useEffect(() => {
    if (err && err !== previousLoadErrorRef.current) {
      notifyError(err, "agent-plugins:snapshot:error");
    }
    previousLoadErrorRef.current = err;
  }, [err]);

  useEffect(() => {
    if (!snap) return;
    const previous = previousServersRef.current;
    if (previous) {
      for (const server of snap.mcpServers) {
        const key = `mcp:${server.pluginId}:${server.serverId}`;
        const before = previous.get(key);
        if (!before) continue;
        if (server.lastError && server.lastError !== before.lastError) {
          notifyError(`${server.serverId}: ${server.lastError}`, `${key}:error`);
        } else if (before.authStatus === "authorizing" && server.authStatus === "unauthenticated") {
          notifyError(
            `${server.serverId} authentication failed`,
            `${key}:error`,
          );
        } else if (before.authStatus === "authorizing" && server.authStatus === "authenticated") {
          toast.success(`${server.serverId} connected`, { id: `${key}:connected`, duration: 4000 });
        } else if (before.status !== "ready" && server.status === "ready") {
          toast.success(`${server.serverId} connected`, { id: `${key}:connected`, duration: 4000 });
        }
      }
    }
    const previousPlugins = previousPluginsRef.current;
    if (previousPlugins) {
      for (const plugin of snap.plugins) {
        const key = `plugin:${plugin.id}`;
        const before = previousPlugins.get(key);
        if (!before) continue;
        if (plugin.lastError && plugin.lastError !== before.lastError) {
          notifyError(`${plugin.name}: ${plugin.lastError}`, `${key}:error`);
        } else if (before.status !== "error" && plugin.status === "error") {
          notifyError(`${plugin.name} failed to load`, `${key}:error`);
        }
      }
    }
    const previousSkills = previousSkillsRef.current;
    if (previousSkills) {
      for (const skill of snap.skills) {
        const key = `skill:${skill.pluginId}:${skill.skillName}`;
        const before = previousSkills.get(key);
        if (!before || !skill.enabled) continue;
        if (skill.lastError && skill.lastError !== before.lastError) {
          notifyError(`/${skill.skillName}: ${skill.lastError}`, `${key}:error`);
        } else if (before.status !== "error" && skill.status === "error") {
          notifyError(`/${skill.skillName} failed`, `${key}:error`);
        }
      }
    }
    previousPluginsRef.current = new Map(
      snap.plugins.map((plugin) => [`plugin:${plugin.id}`, { status: plugin.status, lastError: plugin.lastError }]),
    );
    previousSkillsRef.current = new Map(
      snap.skills.map((skill) => [
        `skill:${skill.pluginId}:${skill.skillName}`,
        { status: skill.status, lastError: skill.lastError },
      ]),
    );
    previousServersRef.current = new Map(
      snap.mcpServers.map((server) => [
        `mcp:${server.pluginId}:${server.serverId}`,
        { status: server.status, authStatus: server.authStatus, lastError: server.lastError },
      ]),
    );
  }, [snap]);

  const runAction = async (key: string, action: () => Promise<unknown>, successMessage?: string) => {
    setPendingAction(key);
    setLocalErr(null);
    try {
      await action();
      if (successMessage) toast.success(successMessage, { duration: 4000 });
    } catch (e) {
      const message = errorText(e);
      setLocalErr(message);
      notifyError(message, `agent-plugins:${key}:error`);
    } finally {
      setPendingAction(null);
      await load();
    }
  };

  const refresh = async () => {
    await load();
    await checkUpdates(undefined, true);
  };

  const updatePlugin = async (id: string) => {
    const plugin = snap?.plugins.find((candidate) => candidate.id === id);
    const key = `update:${id}`;
    setPendingAction(key);
    setLocalErr(null);
    try {
      const result = await rpc.call("update", { id });
      toast.success(`${plugin?.name ?? result.name ?? "Plugin"} updated`, {
        description: result.version ? `Now running v${result.version}.` : "The latest tracked source is installed.",
        duration: 5000,
      });
      await load();
      await checkUpdates(id);
    } catch (e) {
      const message = errorText(e);
      setLocalErr(message);
      notifyError(message, `agent-plugins:update:${id}:error`);
    } finally {
      setPendingAction(null);
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm("Remove this plugin? Skills will be removed. Data is kept unless you purge.")) return;
    const purge = window.confirm("Also delete its stored data? OK = delete, Cancel = keep.");
    try {
      await rpc.call("remove", { id, purgeData: purge });
      toast.success("Plugin removed", { duration: 4000 });
      await load();
    } catch (e) {
      const message = errorText(e);
      setLocalErr(message);
      notifyError(message, `agent-plugins:remove:${id}:error`);
    }
  };

  const approve = async (p: string, s: string) => {
    try {
      await rpc.call("approve", { id: p, serverId: s });
      toast.success(`${s} approved`, { duration: 4000 });
      await load();
    } catch (e) {
      const message = errorText(e);
      setLocalErr(message);
      notifyError(message, `agent-plugins:approve:${p}:${s}:error`);
    }
  };

  const runAuthAction = async (method: AuthMethod, p: string, s: string) => {
    const key = `mcp-auth:${p}:${s}`;
    setPendingAction(key);
    setLocalErr(null);
    try {
      await startAuthFlow(rpc, method, p, s);
    } catch (e) {
      const message = errorText(e);
      setLocalErr(message);
      notifyError(message, `agent-plugins:${key}:error`);
    } finally {
      setPendingAction(null);
      await load();
    }
  };

  const finishAuthentication = async (p: string, s: string, callbackUrl: string): Promise<boolean> => {
    const key = `mcp-auth:${p}:${s}`;
    setPendingAction(key);
    setLocalErr(null);
    try {
      await rpc.call("finishAuthentication", { id: p, serverId: s, callbackUrl });
      toast.success(`${s} connected`, { duration: 4000 });
      return true;
    } catch {
      const message = "Could not finish sign-in. Check that you pasted the full, most recent localhost URL and try again.";
      setLocalErr(message);
      notifyError(message, `agent-plugins:${key}:error`);
      return false;
    } finally {
      setPendingAction(null);
      await load();
    }
  };

  const authenticate = (p: string, s: string) => { void runAuthAction("authenticate", p, s); };
  const reconnect = (p: string, s: string) => { void runAuthAction("reconnect", p, s); };
  const reauthorize = (p: string, s: string) => { void runAuthAction("reauthorize", p, s); };
  const disconnect = (p: string, s: string) => {
    void runAction(
      `mcp-auth:${p}:${s}`,
      () => rpc.call("clearAuthentication", { id: p, serverId: s }),
      `${s} disconnected`,
    );
  };

  const setSkillEnabled = (pluginId: string, skillName: string, enabled: boolean) => {
    void runAction(`skill:${pluginId}:${skillName}`, () =>
      rpc.call("setSkillEnabled", { id: pluginId, skillName, enabled }),
    );
  };

  const setMcpEnabled = (pluginId: string, serverId: string, enabled: boolean) => {
    void runAction(`mcp:${pluginId}:${serverId}`, () =>
      rpc.call("setMcpEnabled", { id: pluginId, serverId, enabled }),
    );
  };

  return (
    <main aria-label="Agent Plugins" className="mx-auto h-full min-h-0 w-full max-w-3xl overflow-y-auto">
      <div className="space-y-4 p-4 md:p-6">
        <div className="space-y-1">
          <h1 className="text-base font-semibold tracking-tight">Agent Plugins</h1>
          <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
            Install once from a path, Git, or npm. Skills become <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">/skill</code> and MCP capabilities flow to Codex and other BB providers.
          </p>
        </div>

        <div className="rounded-lg border border-border bg-card p-4">
          <InstallBar onDone={() => void refresh()} />
          {(err || localErr) && (
            <p className="mt-3 text-xs leading-snug text-destructive" role="alert">
              {localErr ?? err}
            </p>
          )}
        </div>

        <div className="rounded-lg border border-border bg-card">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <h2 className="text-sm font-medium">Installed</h2>
            <div className="flex items-center gap-2">
              {snap && Object.values(updates).some((update) => update.available) && (
                <span className="text-xs text-primary">Update available</span>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => void checkUpdates(undefined, true)}
                disabled={checkingUpdates || !snap}
              >
                {checkingUpdates ? "Checking…" : "Check for updates"}
              </Button>
              <span className="text-xs tabular-nums text-muted-foreground">
                {snap ? `${snap.plugins.length} plugin${snap.plugins.length === 1 ? "" : "s"}` : "…"}
              </span>
            </div>
          </div>

          {!snap ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">Loading…</p>
          ) : snap.plugins.length === 0 ? (
            <div className="px-4 py-10 text-center">
              <p className="text-sm font-medium">No plugins yet</p>
              <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                Paste a location above. A folder needs <code className="font-mono text-xs">plugin.json</code> and may include <code className="font-mono text-xs">skills/</code> and/or <code className="font-mono text-xs">mcp.json</code>. Git and npm are validated before they go live.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {snap.plugins.map((p) => (
                <PluginRow
                  key={p.id}
                  plugin={p}
                  update={updates[p.id]}
                  skills={snap.skills.filter((s) => s.pluginId === p.id)}
                  servers={snap.mcpServers.filter((s) => s.pluginId === p.id)}
                  onRemove={remove}
                  onApprove={approve}
                  onAuthenticate={authenticate}
                  onReconnect={reconnect}
                  onReauthorize={reauthorize}
                  onDisconnect={disconnect}
                  onFinishAuthentication={finishAuthentication}
                  onSkillEnabledChange={setSkillEnabled}
                  onMcpEnabledChange={setMcpEnabled}
                  onUpdate={updatePlugin}
                  pendingAction={pendingAction}
                />
              ))}
            </div>
          )}
        </div>

        <p className="px-1 text-center text-[11px] leading-relaxed text-muted-foreground">
          BB spec-plugin bridge · Skills appear next session · Updates check the tracked path, Git ref, or npm package and keep your data.
        </p>
      </div>
    </main>
  );
}

const ATTENTION_POLL_MS = 60_000;

// App-wide panel pinned above the sidebar footer. Renders nothing unless an
// MCP server needs to sign in again or failed to connect.
function McpAttentionOverlay() {
  const { snap, load, rpc } = useSnapshot();
  const [pending, setPending] = useState<string | null>(null);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    const timer = setInterval(() => void load(), ATTENTION_POLL_MS);
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  const attention = snap ? serversNeedingAttention(snap) : [];
  // Closing hides the panel until the set of broken servers changes.
  const attentionKey = attention.map((server) => `${server.pluginId}:${server.serverId}:${server.status}`).join("|");
  if (attention.length === 0 || attentionKey === dismissedKey) return null;

  const run = async (method: AuthMethod, p: string, s: string) => {
    const key = `mcp-auth:${p}:${s}`;
    setPending(key);
    try {
      await startAuthFlow(rpc, method, p, s);
    } catch (e) {
      notifyError(errorText(e), `agent-plugins:${key}:error`);
    } finally {
      setPending(null);
      await load();
    }
  };

  return (
    <section
      aria-label="MCP connections"
      className="fixed bottom-12 left-2 z-50 w-[min(15rem,calc(100vw-1rem))] space-y-2 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xs font-medium">MCP connections</h2>
        <button
          type="button"
          className="text-[11px] text-muted-foreground hover:text-foreground"
          onClick={() => setDismissedKey(attentionKey)}
        >
          Close
        </button>
      </div>
      <ul className="space-y-2">
        {attention.map((server) => {
          const key = `mcp-auth:${server.pluginId}:${server.serverId}`;
          const method: AuthMethod = server.authStatus === "authenticated" ? "reconnect" : "authenticate";
          return (
            <li key={key} className="flex items-start gap-2">
              <span className="mt-1.5"><Dot status={server.status} /></span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium">
                  <span className="font-mono">{server.serverId}</span>
                  <span className="font-normal text-muted-foreground"> · {server.pluginName}</span>
                </div>
                <p className="truncate text-[11px] text-muted-foreground" title={server.lastError ?? undefined}>
                  {server.lastError ?? (server.status === "needs-auth" ? "Authentication required" : server.status)}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="h-7 shrink-0 text-xs"
                disabled={pending === key}
                onClick={() => void run(method, server.pluginId, server.serverId)}
              >
                {method === "reconnect" ? "Reconnect" : "Sign in"}
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "mcp-attention", component: McpAttentionOverlay });
  app.slots.settingsSection({
    id: "agent-plugins-status",
    title: "Agent Plugins",
    description: "Install once, use everywhere.",
    component: AgentPluginsView,
  });
  app.slots.navPanel({
    id: "agent-plugins",
    title: "Agent Plugins",
    icon: "Puzzle",
    path: "agent-plugins",
    component: AgentPluginsView,
  });
});
