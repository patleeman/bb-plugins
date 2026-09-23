import { useEffect, useId, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./contract";
import { defaultLimits } from "./workspace-contract";
import { Button } from "./components/ui/button";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { IconActionTooltip } from "./channel-controls";
import { Input } from "./components/ui/input";
import {
  ActionBar,
  EmptyState,
  ErrorMessage,
  FormRow,
  message,
  Section,
} from "./bot-ui";

export type WorkbenchPanel =
  | "automations"
  | "activity"
  | "usage";
export const workbenchLabels: Record<WorkbenchPanel, string> = {
  automations: "Automations",
  activity: "Activity",
  usage: "Usage",
};
export function UsagePanel({
  id,
  kind,
}: {
  id: string;
  kind: "bot" | "channel";
}) {
  const rpc = useRpc<typeof rpcContract>();
  const controlId = useId();
  const [usage, setUsage] = useState<Awaited<
    ReturnType<typeof rpc.call<"usage">>
  > | null>(null);
  const [limits, setLimits] = useState(defaultLimits),
    [baselineLimits, setBaselineLimits] = useState(defaultLimits),
    [error, setError] = useState<string | null>(null),
    [pending, setPending] = useState(false),
    [notice, setNotice] = useState("");
  const dirty = JSON.stringify(limits) !== JSON.stringify(baselineLimits);
  useEffect(() => {
    void rpc.call("usage", { id, kind }).then(
      (data) => {
        setUsage(data);
        setLimits(data.limits);
        setBaselineLimits(data.limits);
      },
      (cause) => setError(message(cause)),
    );
  }, [id, kind, rpc]);
  const limitsValid = Object.entries({
    turnsPerHour: [1, 1000],
    turnsPerDay: [1, 10000],
    minutesPerTurn: [1, 180],
    concurrentForks: [1, 16],
  }).every(([field, [minimum, maximum]]) => {
    const value = limits[field as keyof typeof limits];
    return Number.isInteger(value) && value >= minimum! && value <= maximum!;
  });
  const save = async () => {
    if (pending || !usage || !dirty || !limitsValid) return;
    setPending(true);
    setError(null);
    setNotice("");
    try {
      const data = await rpc.call("saveLimits", { id, kind, limits });
      setUsage(data);
      setLimits(data.limits);
      setBaselineLimits(data.limits);
      setNotice("Limits saved.");
    } catch (cause) {
      setError(message(cause));
    } finally {
      setPending(false);
    }
  };
  const values = usage
    ? [
        ["Tasks", usage.turns],
        ["Forks", usage.forks],
        ["Unfinished", usage.active],
        ["Failed", usage.errors],
        ...(kind === "channel"
          ? [
              ["Classifier calls", usage.routingCalls],
              [
                "Classifier time",
                `${Math.round(usage.routingMilliseconds / 1000)}s`,
              ],
            ]
          : []),
      ]
    : [];
  return (
    <div className="channel-workbench-panel channel-context-form">
      <Section title="Last 24 hours">
        <div className="channel-usage-heading">
          <IconActionTooltip
            label="Task counts and limits count started turns. Unfinished includes queued work. Classifier calls are shown separately. Provider billing and token usage remain in View work."
          >
            <Button
              size="icon"
              variant="ghost"
              aria-label="How usage is counted"
            >
              <Icon name="Info" />
            </Button>
          </IconActionTooltip>
        </div>
        {usage ? (
          <dl className="channel-usage-stats">
            {values.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p role="status" className="bot-empty-state">Loading usage…</p>
        )}
      </Section>
      <Section title="Limits">
        <FormRow label="Work limits">
          <div className="channel-usage-limit-row">
            <label htmlFor={`${controlId}-hour`}>
              <Input
                id={`${controlId}-hour`}
                type="number"
                min={1}
                max={1000}
                aria-label="Turns per hour"
                disabled={pending}
                value={limits.turnsPerHour}
                onChange={(e) => setLimits({ ...limits, turnsPerHour: Number(e.target.value) })}
              />
              turns per hour
            </label>
            <label htmlFor={`${controlId}-day`}>
              <Input
                id={`${controlId}-day`}
                type="number"
                min={1}
                max={10000}
                aria-label="Turns per day"
                disabled={pending}
                value={limits.turnsPerDay}
                onChange={(e) => setLimits({ ...limits, turnsPerDay: Number(e.target.value) })}
              />
              turns per day
            </label>
            {kind === "bot" && (
              <>
                <label htmlFor={`${controlId}-minutes`}>
                  <Input
                    id={`${controlId}-minutes`}
                    type="number"
                    min={1}
                    max={180}
                    aria-label="Minutes per turn"
                    disabled={pending}
                    value={limits.minutesPerTurn}
                    onChange={(e) => setLimits({ ...limits, minutesPerTurn: Number(e.target.value) })}
                  />
                  minutes per turn
                </label>
                <label htmlFor={`${controlId}-forks`}>
                  <Input
                    id={`${controlId}-forks`}
                    type="number"
                    min={1}
                    max={16}
                    aria-label="Concurrent forks"
                    disabled={pending}
                    value={limits.concurrentForks}
                    onChange={(e) => setLimits({ ...limits, concurrentForks: Number(e.target.value) })}
                  />
                  concurrent forks
                </label>
              </>
            )}
          </div>
        </FormRow>
      </Section>
      <ErrorMessage
        error={error || (dirty && !limitsValid ? "Use whole numbers within the allowed ranges." : null)}
      />
      <ActionBar
        status={notice || (dirty ? "Unsaved changes" : "")}
        primary={dirty || pending ? (
          <Button size="sm" disabled={pending || !usage || !dirty || !limitsValid} onClick={() => void save()}>
            {pending ? "Saving…" : "Save limits"}
          </Button>
        ) : undefined}
      />
    </div>
  );
}

