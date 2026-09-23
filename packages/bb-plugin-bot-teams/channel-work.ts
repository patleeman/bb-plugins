import type { Job } from "./contract";
import { normalizeActivity } from "./activity";

export function channelWorkActivity(
  job: Pick<
    Job,
    | "status"
    | "cancellationPending"
    | "queueReason"
    | "queuePosition"
    | "activitySnippet"
    | "wrapUpRequestedAt"
  >,
) {
  if (job.cancellationPending) return "Stopping…";
  if (job.wrapUpRequestedAt) return "Wrap-up requested · preparing final update…";
  if (job.status === "queued")
    return job.queueReason
      ? `${job.queueReason}${job.queuePosition ? ` · Position ${job.queuePosition}` : ""}`
      : "Waiting to start…";
  if (job.status === "dispatching") return "Preparing response…";
  return normalizeActivity(job.activitySnippet) ?? "Working…";
}

export const isActiveJob = (job: Job) =>
  !!job.cancellationPending ||
  ["queued", "dispatching", "running"].includes(job.status);
// Each session runs serially; forks have their own activity and Stop control.
export function channelWork(jobs: Job[]): Job[] {
  const priority = (job: Job) =>
    job.status === "running" ? 0 : job.status === "dispatching" ? 1 : 2;
  const sorted = jobs
    .filter(isActiveJob)
    .sort((a, b) => priority(a) - priority(b) || a.createdAt - b.createdAt);
  const seen = new Set<string>();
  return sorted.filter((job) => {
    const session = `${job.botId}:${job.conversationKey}`;
    if (seen.has(session)) return false;
    seen.add(session);
    return true;
  });
}
/** Active sessions with the requests still waiting behind each one. */
export function channelQueues(jobs: Job[]): { head: Job; queued: Job[] }[] {
  return channelWork(jobs).map((head) => ({
    head,
    queued: jobs
      .filter(
        (job) =>
          job.id !== head.id &&
          job.status === "queued" &&
          !job.cancellationPending &&
          job.botId === head.botId &&
          job.conversationKey === head.conversationKey,
      )
      .sort((a, b) => a.createdAt - b.createdAt),
  }));
}
