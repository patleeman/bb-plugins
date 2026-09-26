import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { Bot, ChannelApproval, Job, RoomMessage } from "./contract";
import { Button } from "./components/ui/button";
import { IconActionTooltip } from "./channel-controls";
import { approvalFor, revealApproval } from "./channel-approvals";
import { channelWorkActivity } from "./channel-work";
import { PROSE_COLUMN_INSET_CLASS } from "./channel-timeline";
import { isForkConversation } from "./send-mode";
import { cn } from "./lib/utils";

type Queue = { head: Job; queued: Job[] };

const ROW_ACTION_CLASS =
  "size-6 shrink-0 p-0 text-muted-foreground max-md:pointer-coarse:size-9 [&_[data-icon-root]]:size-3.5";

/** A stable signature for the live rows, for the transcript's follow-the-tail scroll. */
export function channelWorkSignature(queues: Queue[]): string {
  return queues
    .map(
      (queue) =>
        `${queue.head.id}:${channelWorkActivity(queue.head)}:${queue.queued.length}`,
    )
    .join("|");
}

/**
 * Bots working, at the end of the transcript where their answers will land:
 * each session reads like a message being written, with its latest safe
 * one-line activity, a Stop control, and anything still queued behind it.
 */
export function ChannelWorkTrail({
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
  const rows = queues
    .map((queue) => ({
      ...queue,
      bot: bots.find((b) => b.id === queue.head.botId),
      approval: approvalFor(approvals, queue.head),
    }))
    .filter((row): row is typeof row & { bot: Bot } => !!row.bot)
    // A bot waiting on the owner leads, so its request is never the last thing read.
    .sort((a, b) => Number(!!b.approval) - Number(!!a.approval));
  if (!rows.length) return null;

  return (
    <>
      {rows.map((row) => {
        const activity = row.approval
          ? "Needs approval"
          : channelWorkActivity(row.head);
        const stopLabel = `${row.head.cancellationPending ? "Stopping" : "Stop"} ${row.bot.name}'s response`;
        return (
          <div
            key={row.head.id}
            className="bot-room-message is-message-start is-bot-message"
            data-channel-work={row.head.id}
            role="status"
            aria-label={`${row.bot.name}: ${activity}`}
          >
            <div
              className={cn(
                "w-full text-sm font-normal leading-relaxed text-foreground",
                PROSE_COLUMN_INSET_CLASS,
              )}
              data-message-column=""
            >
              <header className="mb-0.5 flex min-w-0 items-center gap-1.5 leading-5">
                <span
                  className={cn(
                    "flex size-5 shrink-0 items-center justify-center text-base leading-none",
                    !row.approval && "animate-shine-icon",
                  )}
                  aria-hidden
                >
                  {row.bot.avatar}
                </span>
                <strong className="min-w-0 truncate font-medium text-foreground">
                  {row.bot.name}
                </strong>
                {isForkConversation(row.head.conversationKey) && (
                  <span className="channel-fork-label">Fork</span>
                )}
              </header>
              <div className="flex min-w-0 items-center gap-1.5">
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate text-sm",
                    row.approval
                      ? "text-warning-text"
                      : "animate-shine text-muted-foreground",
                  )}
                  title={activity}
                >
                  {activity}
                </span>
                {row.approval && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 shrink-0 px-2 text-xs"
                    onClick={() => revealApproval(row.approval!.id)}
                  >
                    Review
                  </Button>
                )}
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
              </div>
              {row.queued.length > 0 && (
                <ol
                  className="m-0 mt-0.5 list-none"
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
                        className="group/row flex min-h-7 min-w-0 items-center gap-1.5 text-xs"
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
                          Queued
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
              )}
            </div>
          </div>
        );
      })}
    </>
  );
}
