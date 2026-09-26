import { useEffect, useRef, useState } from "react";
import {
  ThreadChat,
  experimental_Icon as Icon,
  useBbNavigate,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { Button } from "./components/ui/button";
import { openWorkThread } from "./channel-threads";
import {
  type ApprovalDecision,
  type ChannelApproval,
  type rpcContract,
} from "./contract";

type BotRow = { id: string; name: string; avatar: string };

const decisionLabels: Record<ApprovalDecision, string> = {
  allow_once: "Approve",
  allow_for_session: "Approve for session",
  deny: "Deny",
};
const decisionResults: Record<ApprovalDecision, string> = {
  allow_once: "Approved by you",
  allow_for_session: "Approved for this session by you",
  deny: "Denied by you",
};
/** How long a handled request stays on screen as a one-line result. */
const settledMs = 8000;

type Settled = { id: string; botId: string; label: string };
type Answers = Record<string, { selected: string[]; freeText?: string }>;

function QuestionForm({
  approval,
  busy,
  archived,
  onAnswer,
}: {
  approval: ChannelApproval;
  busy: boolean;
  archived: boolean;
  onAnswer: (answers: Answers) => void;
}) {
  const [answers, setAnswers] = useState<Answers>({});
  const update = (id: string, answer: { selected: string[]; freeText?: string }) =>
    setAnswers((old) => ({ ...old, [id]: answer }));
  const ready = approval.questions.length > 0 && approval.questions.every((q) => {
    const answer = answers[q.id];
    return !!answer?.selected.length || !!answer?.freeText?.trim();
  });
  return (
    <form className="channel-approval-form" onSubmit={(event) => {
      event.preventDefault();
      if (ready) onAnswer(answers);
    }}>
      {approval.questions.map((question) => {
        const answer = answers[question.id] ?? { selected: [] };
        return (
          <fieldset key={question.id} className="channel-approval-question" disabled={busy || archived}>
            <legend>{question.prompt}</legend>
            {question.options.map((option) => (
              <label key={option.value} className="channel-approval-option">
                <input
                  type={question.multiSelect ? "checkbox" : "radio"}
                  name={`${approval.id}-${question.id}`}
                  value={option.value}
                  checked={answer.selected.includes(option.value)}
                  onChange={(event) => update(question.id, {
                    ...answer,
                    selected: question.multiSelect
                      ? event.target.checked
                        ? [...answer.selected, option.value]
                        : answer.selected.filter((value) => value !== option.value)
                      : [option.value],
                  })}
                />
                <span>{option.label}{option.description && <small>{option.description}</small>}</span>
              </label>
            ))}
            {question.allowFreeText && (
              <textarea
                aria-label={`Your answer to ${question.prompt}`}
                placeholder={question.options.length ? "Add your own answer" : "Your answer"}
                value={answer.freeText ?? ""}
                maxLength={4000}
                onChange={(event) => update(question.id, { ...answer, freeText: event.target.value })}
              />
            )}
          </fieldset>
        );
      })}
      <Button size="sm" type="submit" disabled={!ready || busy || archived}>
        {busy ? "Sending…" : "Send answer"}
      </Button>
    </form>
  );
}

export function approvalFor(
  approvals: ChannelApproval[],
  job: { threadId: string | null },
) {
  return approvals.find((a) => a.threadId === job.threadId) ?? null;
}

export function revealApproval(approvalId: string) {
  document
    .getElementById(`approval-${approvalId}`)
    ?.scrollIntoView({ block: "center", behavior: "smooth" });
}

/** Requests a bot is blocked on, answerable without leaving the channel. */
export function ChannelApprovalDeck({
  roomId,
  approvals,
  bots,
  archived,
  onFailure,
  onResolved,
}: {
  roomId: string;
  approvals: ChannelApproval[];
  bots: BotRow[];
  archived: boolean;
  onFailure: (text: string) => void;
  onResolved: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [settled, setSettled] = useState<Settled[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string[]>([]);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(
    () => () => {
      for (const timer of timers.current) clearTimeout(timer);
    },
    [],
  );
  const settle = (approval: ChannelApproval, label: string) => {
    setSettled((old) => [
      ...old.filter((s) => s.id !== approval.id),
      { id: approval.id, botId: approval.botId, label },
    ]);
    timers.current.push(
      setTimeout(
        () => setSettled((old) => old.filter((s) => s.id !== approval.id)),
        settledMs,
      ),
    );
  };
  const answer = async (
    approval: ChannelApproval,
    input:
      | { decision: ApprovalDecision }
      | { answers: Answers },
    label: string,
  ) => {
    if (pending) return;
    setPending(approval.id);
    try {
      await rpc.call("resolveApproval", {
        id: roomId,
        threadId: approval.threadId,
        interactionId: approval.id,
        ...input,
      });
      settle(approval, label);
      onResolved();
    } catch (cause) {
      onFailure(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(null);
    }
  };
  const open = (approval: ChannelApproval) =>
    openWorkThread(navigate, approval.threadId, roomId);
  const waiting = approvals.filter((a) => !settled.some((s) => s.id === a.id));
  if (!waiting.length && !settled.length) return null;
  const name = (botId: string) => bots.find((b) => b.id === botId);
  return (
    <section className="channel-approvals" aria-label="Requests waiting on you">
      {waiting.map((approval) => {
        const bot = name(approval.botId);
        const busy = pending === approval.id;
        return (
          <article
            key={approval.id}
            id={`approval-${approval.id}`}
            className="channel-approval"
          >
            <p className="channel-approval-title">
              <span className="channel-agent-avatar" aria-hidden>
                {bot?.avatar ?? "🤖"}
              </span>
              <strong>{bot?.name ?? "A bot"}</strong>
              <span>{approval.title}</span>
            </p>
            {approval.detail && (
              <p className="channel-approval-detail">{approval.detail}</p>
            )}
            <div className="channel-approval-actions">
              {approval.decisions.map((decision) => (
                <Button
                  key={decision}
                  size="sm"
                  variant={decision === "deny" ? "ghost" : "default"}
                  disabled={busy || archived}
                  onClick={() =>
                    void answer(
                      approval,
                      { decision },
                      decisionResults[decision],
                    )
                  }
                >
                  {decisionLabels[decision]}
                </Button>
              ))}
              {approval.kind !== "other" && (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-expanded={expanded.includes(approval.id)}
                  onClick={() => setExpanded((old) => old.includes(approval.id)
                    ? old.filter((id) => id !== approval.id)
                    : [...old, approval.id])}
                >
                  {expanded.includes(approval.id) ? "Hide work context" : "Review work context"}
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => open(approval)}>
                Open work thread
              </Button>
            </div>
            {approval.kind === "question" && (
              <QuestionForm
                approval={approval}
                busy={busy}
                archived={archived}
                onAnswer={(answers) => void answer(approval, { answers }, "Answered by you")}
              />
            )}
            {(approval.kind === "other" || expanded.includes(approval.id)) && (
              <div className="channel-approval-native" aria-label="Work thread request">
                <ThreadChat threadId={approval.threadId} variant="compact" layout="contained" />
              </div>
            )}
          </article>
        );
      })}
      {settled.map((s) => (
        <p key={s.id} className="channel-approval-settled" role="status">
          <Icon name="Check" />
          <span>
            {name(s.botId)?.name ?? "A bot"} · {s.label}
          </span>
        </p>
      ))}
    </section>
  );
}
