import { useId, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { Bot, rpcContract } from "./contract";
import type { ChannelAutomation } from "./automation-contract";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import {
  ActionBar,
  ErrorMessage,
  FormRow,
  message,
  Section,
} from "./bot-ui";

export function scheduleDescription(a: ChannelAutomation) {
  if (a.trigger.triggerType === "once")
    return `Once · ${new Date(a.trigger.runAt).toLocaleString()}`;
  const [minute, hour, day, month, weekday] = a.trigger.cron
    .trim()
    .split(/\s+/);
  if (
    /^\d+$/.test(minute ?? "") &&
    /^\d+$/.test(hour ?? "") &&
    day === "*" &&
    month === "*" &&
    ["*", "1-5"].includes(weekday ?? "")
  ) {
    return `${weekday === "1-5" ? "Weekdays" : "Every day"} at ${hour!.padStart(2, "0")}:${minute!.padStart(2, "0")} · ${a.trigger.timezone}`;
  }
  if (a.trigger.cron === "0 * * * *")
    return `Every hour · ${a.trigger.timezone}`;
  return `Custom schedule (${a.trigger.cron}) · ${a.trigger.timezone}`;
}
const localDate = (timestamp: number) => {
  const d = new Date(timestamp);
  return new Date(timestamp - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
};
export function AutomationEditor({
  id,
  bots,
  initial,
  onSaved,
  onCancel,
}: {
  id: string;
  bots: Bot[];
  initial?: ChannelAutomation;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [name, setName] = useState(initial?.name ?? ""),
    [prompt, setPrompt] = useState(initial?.prompt ?? ""),
    [botId, setBotId] = useState(initial?.botId ?? bots[0]?.id ?? "");
  const [kind, setKind] = useState(
      initial?.trigger.triggerType === "once"
        ? "once"
        : initial
          ? "custom"
          : "weekdays",
    ),
    [time, setTime] = useState("09:00"),
    [cron, setCron] = useState(
      initial?.trigger.triggerType === "schedule"
        ? initial.trigger.cron
        : "0 9 * * 1-5",
    ),
    [timezone, setTimezone] = useState(
      initial?.trigger.triggerType === "schedule"
        ? initial.trigger.timezone
        : Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
  const [at, setAt] = useState(
      localDate(
        initial?.trigger.triggerType === "once"
          ? initial.trigger.runAt
          : Date.now() + 3600000,
      ),
    ),
    [enabled, setEnabled] = useState(false),
    [pending, setPending] = useState(false),
    [error, setError] = useState<string | null>(null);
  const [requestId] = useState(() => crypto.randomUUID());
  const controlId = useId();
  const baseline = useRef({
    name: initial?.name ?? "",
    prompt: initial?.prompt ?? "",
    botId: initial?.botId ?? bots[0]?.id ?? "",
    kind:
      initial?.trigger.triggerType === "once"
        ? "once"
        : initial
          ? "custom"
          : "weekdays",
    time: "09:00",
    cron:
      initial?.trigger.triggerType === "schedule"
        ? initial.trigger.cron
        : "0 9 * * 1-5",
    timezone:
      initial?.trigger.triggerType === "schedule"
        ? initial.trigger.timezone
        : Intl.DateTimeFormat().resolvedOptions().timeZone,
    at: localDate(
      initial?.trigger.triggerType === "once"
        ? initial.trigger.runAt
        : Date.now() + 3600000,
    ),
    enabled: false,
  }).current;
  const dirty =
    name !== baseline.name ||
    prompt !== baseline.prompt ||
    botId !== baseline.botId ||
    kind !== baseline.kind ||
    time !== baseline.time ||
    cron !== baseline.cron ||
    timezone !== baseline.timezone ||
    at !== baseline.at ||
    enabled !== baseline.enabled;
  const invalid =
    !name.trim() ||
    !prompt.trim() ||
    (!initial && !botId) ||
    (kind === "once" && Number.isNaN(new Date(at).getTime()));
  return (
    <form
      className="channel-automation-editor"
      onSubmit={async (e) => {
        e.preventDefault();
        if (pending || !dirty || invalid) return;
        setPending(true);
        setError(null);
        try {
          const [h, m] = time.split(":").map(Number);
          const trigger =
            kind === "once"
              ? { triggerType: "once" as const, runAt: new Date(at).getTime() }
              : {
                  triggerType: "schedule" as const,
                  cron:
                    kind === "custom"
                      ? cron
                      : kind === "hourly"
                        ? "0 * * * *"
                        : `${m} ${h} * * ${kind === "weekdays" ? "1-5" : "*"}`,
                  timezone,
                };
          if (initial)
            await rpc.call("automationUpdate", {
              channelId: id,
              automationId: initial.id,
              name,
              prompt,
              trigger,
            });
          else
            await rpc.call("automationCreate", {
              channelId: id,
              botId,
              name,
              prompt,
              trigger,
              enabled,
              requestId,
            });
          onSaved();
        } catch (cause) {
          setError(message(cause));
        } finally {
          setPending(false);
        }
      }}
    >
      <Section title="Automation">
        <FormRow label="Name" htmlFor={`${controlId}-name`}>
          <Input
            id={`${controlId}-name`}
            aria-label="Automation name"
            value={name}
            required
            maxLength={120}
            disabled={pending}
            onChange={(e) => setName(e.target.value)}
          />
        </FormRow>
        {!initial && (
          <FormRow label="Bot" htmlFor={`${controlId}-bot`}>
            <select
              id={`${controlId}-bot`}
              aria-label="Automation bot"
              className="channel-form-select profile-picker-control"
              value={botId}
              disabled={pending}
              onChange={(e) => setBotId(e.target.value)}
            >
              {bots.map((b) => (
                <option value={b.id} key={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </FormRow>
        )}
        <FormRow label="Task" htmlFor={`${controlId}-task`}>
          <Textarea
            id={`${controlId}-task`}
            aria-label="Automation task"
            value={prompt}
            required
            maxLength={8000}
            disabled={pending}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </FormRow>
      </Section>
      <Section title="Schedule">
        <FormRow label="Repeat" htmlFor={`${controlId}-kind`}>
          <select
            id={`${controlId}-kind`}
            aria-label="Automation schedule"
            className="channel-form-select profile-picker-control"
            value={kind}
            disabled={pending}
            onChange={(e) => setKind(e.target.value)}
          >
            <option value="weekdays">Weekdays</option>
            <option value="daily">Every day</option>
            <option value="hourly">Every hour</option>
            <option value="once">Once</option>
            <option value="custom">Custom cron</option>
          </select>
        </FormRow>
        {kind === "once" ? (
          <FormRow label="Date and time" htmlFor={`${controlId}-at`}>
            <Input
              id={`${controlId}-at`}
              aria-label="Run at"
              type="datetime-local"
              required
              value={at}
              disabled={pending}
              onChange={(e) => setAt(e.target.value)}
            />
          </FormRow>
        ) : (
          <>
            {(kind === "daily" || kind === "weekdays") && (
              <FormRow label="Time" htmlFor={`${controlId}-time`}>
                <Input
                  id={`${controlId}-time`}
                  aria-label="Schedule time"
                  type="time"
                  required
                  value={time}
                  disabled={pending}
                  onChange={(e) => setTime(e.target.value)}
                />
              </FormRow>
            )}
            {kind === "custom" && (
              <FormRow label="Cron expression" htmlFor={`${controlId}-cron`}>
                <Input
                  id={`${controlId}-cron`}
                  aria-label="Cron expression"
                  required
                  value={cron}
                  disabled={pending}
                  onChange={(e) => setCron(e.target.value)}
                />
              </FormRow>
            )}
            <FormRow label="Timezone" htmlFor={`${controlId}-timezone`}>
              <Input
                id={`${controlId}-timezone`}
                aria-label="Schedule timezone"
                required
                value={timezone}
                disabled={pending}
                onChange={(e) => setTimezone(e.target.value)}
              />
            </FormRow>
          </>
        )}
        {!initial && (
          <FormRow label="Start" htmlFor={`${controlId}-enabled`}>
            <label className="channel-automation-enable">
              <input
                id={`${controlId}-enabled`}
                type="checkbox"
                checked={enabled}
                disabled={pending}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              Enable schedule immediately
            </label>
          </FormRow>
        )}
      </Section>
      <ErrorMessage error={error} />
      <ActionBar
        status={pending ? "Saving…" : dirty ? "Unsaved changes" : ""}
        secondary={
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={onCancel}
          >
            Cancel
          </Button>
        }
        primary={dirty || pending ? (
          <Button size="sm" disabled={pending || invalid || !dirty}>
            {pending
              ? "Saving…"
              : initial
                ? "Save automation"
                : "Create automation"}
          </Button>
        ) : undefined}
      />
    </form>
  );
}
