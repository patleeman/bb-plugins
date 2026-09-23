import { useState } from "react";
import { Markdown, useBbNavigate, type PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import { attentionQuestionPayload } from "./attention-question-contract";
import { Button } from "./components/ui/button";
import { message } from "./bot-ui";

export function AttentionQuestion({ interaction, submit, cancel }: PluginPendingInteractionProps) {
  const parsed = attentionQuestionPayload.safeParse(interaction.payload);
  const navigate = useBbNavigate();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (work: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await work(); } catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  };
  if (!parsed.success) return <div role="alert">This channel question could not be displayed.
    <Button disabled={busy} onClick={() => act(cancel)}>Dismiss</Button></div>;
  const data = parsed.data;
  return <form className="attention-question" onSubmit={event => {
    event.preventDefault();
    if (text.trim()) void act(() => submit({ action: "reply", text: text.trim() }));
  }}>
    <div className="attention-meta"><strong>{data.speaker} in #{data.channelName}</strong>
      <Button type="button" variant="ghost" size="sm" onClick={() => navigate.toPluginPanel("channels", { subPath: `${data.roomId}/message/${encodeURIComponent(data.attentionId)}` })}>Open channel</Button>
    </div>
    <div className="attention-question-text"><Markdown content={data.text} /></div>
    <label htmlFor={`answer-${interaction.id}`}>Your answer</label>
    <textarea id={`answer-${interaction.id}`} rows={3} maxLength={4000} value={text} disabled={busy} onChange={e => setText(e.target.value)} placeholder="Reply to the channel…" />
    {error && <p role="alert">{error}</p>}
    <div className="attention-actions">
      <Button type="submit" disabled={busy || !text.trim()}>Send reply</Button>
      <Button type="button" variant="outline" disabled={busy} onClick={() => act(() => submit({ action: "acknowledge" }))}>Acknowledge</Button>
      <Button type="button" variant="ghost" disabled={busy} onClick={() => act(() => submit({ action: "snooze" }))}>Snooze 1 hour</Button>
    </div>
  </form>;
}
