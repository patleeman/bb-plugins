import { useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { Bot, rpcContract } from "./contract";
import type { ChannelAutomation } from "./automation-contract";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import { ErrorMessage, message } from "./bot-ui";

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
  return (
    <form
      className="channel-context-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (pending) return;
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
      <label>
        Name
        <Input
          aria-label="Automation name"
          value={name}
          required
          maxLength={120}
          disabled={pending}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      {!initial && (
        <label>
          Bot
          <select
            aria-label="Automation bot"
            className="channel-form-select"
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
        </label>
      )}
      <label>
        Task
        <Textarea
          aria-label="Automation task"
          value={prompt}
          required
          maxLength={8000}
          disabled={pending}
          onChange={(e) => setPrompt(e.target.value)}
        />
      </label>
      <label>
        Schedule
        <select
          aria-label="Automation schedule"
          className="channel-form-select"
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
      </label>
      {kind === "once" ? (
        <label>
          Date and time ({Intl.DateTimeFormat().resolvedOptions().timeZone})
          <Input
            aria-label="Run at"
            type="datetime-local"
            required
            value={at}
            disabled={pending}
            onChange={(e) => setAt(e.target.value)}
          />
        </label>
      ) : (
        <>
          {(kind === "daily" || kind === "weekdays") && (
            <label>
              Time
              <Input
                aria-label="Schedule time"
                type="time"
                required
                value={time}
                disabled={pending}
                onChange={(e) => setTime(e.target.value)}
              />
            </label>
          )}
          {kind === "custom" && (
            <label>
              Cron expression
              <Input
                aria-label="Cron expression"
                required
                value={cron}
                disabled={pending}
                onChange={(e) => setCron(e.target.value)}
              />
            </label>
          )}
          <label>
            Timezone
            <Input
              aria-label="Schedule timezone"
              required
              value={timezone}
              disabled={pending}
              onChange={(e) => setTimezone(e.target.value)}
            />
          </label>
        </>
      )}
      {!initial && (
        <label className="channel-reference-file">
          <input
            type="checkbox"
            checked={enabled}
            disabled={pending}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          Enable schedule immediately
        </label>
      )}
      <ErrorMessage error={error} />
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={pending || !botId || !name.trim() || !prompt.trim()}
        >
          {pending
            ? "Saving…"
            : initial
              ? "Save automation"
              : "Create automation"}
        </Button>
      </div>
    </form>
  );
}
