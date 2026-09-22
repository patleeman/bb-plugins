import type { Job } from "./contract";

/** A registered response may already execute while its dispatch RPC returns. */
export const isExecuting = (job: Pick<Job, "status">) =>
  job.status === "dispatching" || job.status === "running";

export const isUnfinished = (
  job: Pick<Job, "status" | "cancellationPending">,
) => job.status === "queued" || isExecuting(job) || !!job.cancellationPending;
