import { useId, useState } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { Bot, ChannelApproval, Job, RoomMessage } from "./contract";
import { Button } from "./components/ui/button";
import {
  activityIconClass,
  activityMetaClass,
  activityRowClass,
} from "./components/ui/activity-row-styles";
import {
  AnimatedBody,
  PROMPT_STACK_CARD_ROW_HEIGHT,
  PromptStackCard,
} from "./components/ui/prompt-stack-card";
import { IconActionTooltip } from "./channel-controls";
import { approvalFor, revealApproval } from "./channel-approvals";
import { channelWorkActivity } from "./channel-work";
import { isForkConversation } from "./send-mode";
import { cn } from "./lib/utils";

type Queue = { head: Job; queued: Job[] };

const ROW_ACTION_CLASS =
  "size-6 shrink-0 p-0 text-muted-foreground max-md:pointer-coarse:size-9 [&_[data-icon-root]]:size-3.5";

/**
 * Bots working in the channel, as BB's background-activity card: a separate
 * card above the composer showing the first bot, with the rest behind a toggle.
 */
export function ChannelWorkCard({
  queues,
  bots,
  approvals,
  messages,
  onCancel,
}: {
  queues: Queue[];
  bots: Bot[];
  approvals: ChannelApproval[];
  messages: RoomMessage[];
  onCancel: (jobId: string) => void;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const toggleId = useId(),
    bodyId = useId();
  const rows = queues
    .map((queue) => ({
      ...queue,
      bot: bots.find((b) => b.id === queue.head.botId),
      approval: approvalFor(approvals, queue.head),
    }))
    .filter((row): row is typeof row & { bot: Bot } => !!row.bot)
    // A bot waiting on the owner leads, so the card never hides it.
    .sort((a, b) => Number(!!b.approval) - Number(!!a.approval));
  const primary = rows[0];
  if (!primary) return null;
  const others = rows.slice(1);
  const queuedCount = rows.reduce((n, row) => n + row.queued.length, 0);
  const canExpand = others.length > 0 || queuedCount > 0;

  const actions = (row: (typeof rows)[number]) => {
    const stopLabel = `${row.head.cancellationPending ? "Stopping" : "Stop"} ${row.bot.name}'s response`;
    return (
      <>
        {row.approval ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 shrink-0 px-2 text-xs"
            onClick={() => revealApproval(row.approval!.id)}
          >
            Review
          </Button>
        ) : null}
        <IconActionTooltip label={stopLabel}>
          <Button
            variant="ghost"
            size="icon"
            className={cn(ROW_ACTION_CLASS, "hover:text-destructive")}
            aria-label={stopLabel}
            disabled={!!row.head.cancellationPending}
            onClick={() => {
              if (!row.head.cancellationPending) onCancel(row.head.id);
            }}
          >
            <Icon name="Square" className="fill-current [&_*]:stroke-0" />
          </Button>
        </IconActionTooltip>
      </>
    );
  };

  const summary = (row: (typeof rows)[number], active: boolean) => {
    const activity = row.approval
      ? "Needs approval"
      : channelWorkActivity(row.head);
    return (
      <>
        <span
          aria-hidden
          className={cn(
            "flex size-3.5 shrink-0 items-center justify-center text-[13px] leading-none",
            active && !row.approval && activityIconClass("active"),
          )}
        >
          {row.bot.avatar}
        </span>
        <span className="min-w-0 max-w-[40%] shrink truncate font-medium text-foreground">
          {row.bot.name}
        </span>
        {isForkConversation(row.head.conversationKey) ? (
          <span className="channel-fork-label shrink-0">Fork</span>
        ) : null}
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-left",
            row.approval ? "text-warning-text" : "text-muted-foreground",
          )}
          title={activity}
        >
          {activity}
        </span>
      </>
    );
  };

  const meta = [
    others.length ? `+${others.length} more` : "",
    queuedCount ? `${queuedCount} queued` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <PromptStackCard
      ariaLabel="Bot work and queue"
      className="overflow-hidden"
      style={{ minHeight: PROMPT_STACK_CARD_ROW_HEIGHT }}
    >
      <div
        className={activityRowClass(
          "active",
          "flex min-h-8 w-full min-w-0 items-center gap-1 rounded-none px-0 py-0 pr-2 text-xs text-foreground",
        )}
        role="status"
        aria-label={`${primary.bot.name}: ${primary.approval ? "Needs approval" : channelWorkActivity(primary.head)}`}
      >
        {canExpand ? (
          <button
            type="button"
            id={toggleId}
            aria-expanded={isExpanded}
            aria-controls={bodyId}
            onClick={() => setIsExpanded((open) => !open)}
            className="flex min-h-8 min-w-0 flex-1 cursor-pointer items-center gap-1.5 py-1.5 pl-3 pr-1 transition-colors hover:bg-background/80"
          >
            {summary(primary, true)}
            <span className={activityMetaClass("active", "shrink-0")}>
              {meta}
            </span>
            <Icon
              name="ChevronDown"
              className={cn(
                activityIconClass("active"),
                "size-3.5 shrink-0 transition-transform duration-200",
                isExpanded && "rotate-180",
              )}
              aria-hidden
            />
          </button>
        ) : (
          <div className="flex min-h-8 min-w-0 flex-1 items-center gap-1.5 py-1.5 pl-3 pr-1">
            {summary(primary, true)}
          </div>
        )}
        {actions(primary)}
      </div>
      {canExpand ? (
        <AnimatedBody
          id={bodyId}
          labelledBy={toggleId}
          isExpanded={isExpanded}
          collapsedBorder="none"
        >
          <div className="flex max-h-[40vh] flex-col gap-0.5 overflow-y-auto py-1">
            {rows.map((row, index) => (
              <div key={row.head.id}>
                {index > 0 ? (
                  <div className="flex min-h-7 min-w-0 items-center gap-1.5 pl-3 pr-2 text-xs">
                    {summary(row, false)}
                    {actions(row)}
                  </div>
                ) : null}
                {row.queued.length > 0 ? (
                  <ol
                    className="m-0 list-none"
                    aria-label={`Queued for ${row.bot.name}`}
                  >
                    {row.queued.map((job) => {
                      const text =
                        messages.find((m) => m.id === job.triggerMessageId)
                          ?.text ||
                        job.taskTitle ||
                        "Queued request";
                      return (
                        <li
                          key={job.id}
                          className="group/row flex min-h-7 min-w-0 items-center gap-1.5 pl-3 pr-2 text-xs"
                        >
                          <Icon
                            name="CornerDownRight"
                            className="size-3.5 shrink-0 text-muted-foreground/60"
                            aria-hidden
                          />
                          <span
                            className="min-w-0 flex-1 truncate text-muted-foreground"
                            title={text}
                          >
                            {text}
                          </span>
                          <span className="shrink-0 text-subtle-foreground">
                            Queued for {row.bot.name}
                          </span>
                          <Button
                            variant="ghost"
                            size="icon"
                            className={cn(
                              ROW_ACTION_CLASS,
                              "opacity-0 transition-opacity duration-[120ms] ease-out hover:text-destructive focus-visible:opacity-100 group-hover/row:opacity-100 [@media(hover:none)]:opacity-100",
                            )}
                            aria-label={`Remove queued request for ${row.bot.name}`}
                            onClick={() => onCancel(job.id)}
                          >
                            <Icon name="Trash2" aria-hidden />
                          </Button>
                        </li>
                      );
                    })}
                  </ol>
                ) : null}
              </div>
            ))}
          </div>
        </AnimatedBody>
      ) : null}
    </PromptStackCard>
  );
}
