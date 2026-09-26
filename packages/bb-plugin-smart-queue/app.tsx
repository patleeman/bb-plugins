import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  definePluginApp,
  experimental_ProviderModelPicker as ProviderModelPicker,
  useRpc,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Fallback, rpcContract } from "./contract";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Matches the host-rendered settings rows above: copy on the left, control on the right. */
function Row({ label, description, children }: { label: string; description: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 py-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 sm:max-w-[60%]">
        <div className="text-sm font-medium text-foreground">{label}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">{description}</div>
      </div>
      <div className="flex shrink-0 flex-col items-start gap-2 sm:items-end">{children}</div>
    </div>
  );
}

function JevConnection() {
  const rpc = useRpc<typeof rpcContract>();
  const { values } = useSettings();
  const [status, setStatus] = useState<{ provider: string; routes: { name: string; model: string }[]; problems: string[] } | null>(null);
  const [check, setCheck] = useState<{ state: "idle" | "running" } | { state: "done"; text: string; ok: boolean }>({
    state: "idle",
  });

  // Secret keys are not in `values`, so also refresh after a check and on focus.
  const refresh = useCallback(() => {
    rpc.call("jev.status", null).then(setStatus, () => setStatus(null));
  }, [rpc]);
  useEffect(refresh, [refresh, JSON.stringify(values)]);
  useEffect(() => {
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);

  const test = async () => {
    setCheck({ state: "running" });
    try {
      const result = await rpc.call("jev.check", null);
      setCheck(
        result.ok
          ? { state: "done", ok: true, text: `Jev answered through ${result.via} in ${result.ms} ms.` }
          : { state: "done", ok: false, text: result.error },
      );
    } catch (error) {
      setCheck({ state: "done", ok: false, text: errorText(error) });
    }
    refresh();
  };

  const routes = status?.routes ?? [];
  return (
    <div className="divide-y divide-border rounded-lg border border-border bg-card px-4">
      <Row
        label={status?.provider === "auto" || !status ? "Providers auto will try" : "Provider"}
        description="Only providers with a key, or a complete custom endpoint, are used. Keys stay on the server."
      >
        {routes.length ? (
          <ol className="flex flex-col items-start gap-1 text-sm sm:items-end" aria-label="Jev providers in order">
            {routes.map((route, index) => (
              <li key={route.name} className="text-foreground">
                <span className="text-muted-foreground">{index + 1}.</span> {route.name}{" "}
                <span className="text-muted-foreground">· {route.model}</span>
              </li>
            ))}
          </ol>
        ) : (
          <span className="text-sm text-muted-foreground">{status ? "None configured" : "Loading…"}</span>
        )}
        {status?.problems.map((problem) => (
          <p key={problem} className="text-xs text-destructive">
            {problem}
          </p>
        ))}
      </Row>
      <Row label="Test connection" description="Sends a fixed sample message to Jev. It never reads a thread.">
        <Button size="sm" variant="outline" disabled={!routes.length || check.state === "running"} onClick={test}>
          {check.state === "running" ? "Testing…" : "Test"}
        </Button>
        {check.state === "done" && (
          <p role="status" className={check.ok ? "text-xs text-muted-foreground" : "text-xs text-destructive"}>
            {check.text}
          </p>
        )}
      </Row>
    </div>
  );
}

const modeLabels = {
  thread: "The thread's provider",
  model: "A specific model",
  off: "Off",
} as const;

function FallbackModel() {
  const rpc = useRpc<typeof rpcContract>();
  const [value, setValue] = useState<Fallback | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    rpc.call("fallback.get", null).then(setValue, (cause) => setError(errorText(cause)));
  }, [rpc]);

  const save = async (next: Fallback) => {
    const previous = value;
    setValue(next);
    setError(null);
    try {
      setValue(await rpc.call("fallback.set", next));
    } catch (cause) {
      setValue(previous);
      setError(errorText(cause));
    }
  };

  const chooseMode = async (mode: Fallback["mode"]) => {
    if (mode !== "model") return save({ mode });
    // Start from a real catalog entry so the picker never shows an empty model.
    const suggestion = await rpc.call("fallback.suggest", null).catch(() => null);
    if (!suggestion) return setError("No available provider has a model to choose.");
    await save(suggestion);
  };

  if (!value) return <p className="text-sm text-muted-foreground">{error ?? "Loading…"}</p>;
  return (
    <div className="divide-y divide-border rounded-lg border border-border bg-card px-4">
      <Row
        label="Use"
        description="Decides when no Jev provider answers, in a hidden thread that is deleted afterwards. Off sends every undecided message as a follow-up."
      >
        <Select value={value.mode} onValueChange={(mode) => void chooseMode(mode as Fallback["mode"])}>
          <SelectTrigger className="w-56" aria-label="Fallback model source">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(modeLabels) as Fallback["mode"][]).map((mode) => (
              <SelectItem key={mode} value={mode}>
                {modeLabels[mode]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
      {value.mode === "thread" && (
        <Row label="Model" description="The busy thread's provider with its default model and lowest reasoning level.">
          <span className="text-sm text-muted-foreground">Matches each thread</span>
        </Row>
      )}
      {value.mode === "model" && (
        <Row label="Model" description="Pick a fast, inexpensive model. A classifier needs little reasoning.">
          <ProviderModelPicker
            align="end"
            value={{
              providerId: value.providerId,
              model: value.model,
              reasoningLevel: value.reasoningLevel ?? "low",
            }}
            onChange={(next) =>
              void save({
                mode: "model",
                providerId: next.providerId,
                model: next.model,
                reasoningLevel: next.reasoningLevel,
              })
            }
          />
        </Row>
      )}
      {error && <p className="py-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "jev-connection",
    title: "Jev connection",
    description: "Which Jev providers Smart Queue will call, in order.",
    component: JevConnection,
  });
  app.slots.settingsSection({
    id: "fallback-model",
    title: "Fallback model",
    description: "The model that decides when no Jev provider answers.",
    component: FallbackModel,
  });
});
