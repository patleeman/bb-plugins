// The explainer lifecycle: find-or-start by key, run a job through its
// stages (collect context → start worker → write → save), stop, regenerate.
// BB specifics (threads, timeline) and page writes come in as deps, so this
// runs the same in tests against a real in-memory database.
import type { ExplainerView, JobView } from "./contract";
import { cleanExplainerMarkdown } from "./markdown";
import type { ExplorePages } from "./pages";
import { workerPrompt } from "./prompt";
import { STAGES, explainerHref, isActiveJob, parseExploreItem, threadHref, type ExploreItem, type JobStatus } from "./shared";
import { explainerKey, parseFollowUps, type ExplainerRow, type ExploreStore, type JobKind, type JobRow } from "./store";
import type { TurnHints } from "./timeline";

export interface CollectedContext {
  projectId: string | null;
  hints: TurnHints;
  /** Where to fork the source thread, and its environment, for the worker. */
  fork: { sourceSeqEnd: number | null; environmentId: string | null };
}

export interface WorkerProgress {
  /** 0..1, how far along the worker probably is. */
  fraction: number;
  detail: string;
}

export interface ExploreDeps {
  store: ExploreStore;
  pages: ExplorePages;
  /** Where the finding came from: the project, and what its turn touched. */
  collect(explainer: ExplainerRow, signal: AbortSignal): Promise<CollectedContext>;
  /** Forks the source thread at the message and starts the worker; returns its thread id. */
  startWorker(explainer: ExplainerRow, prompt: string, context: CollectedContext, signal: AbortSignal): Promise<string>;
  /** Resolves with the worker's final message. */
  awaitWorker(workerId: string, signal: AbortSignal, progress: (update: WorkerProgress) => void): Promise<string>;
  /** Stops and archives a worker. Best effort. */
  disposeWorker(workerId: string): Promise<void>;
  /** An explainer or its job changed. */
  changed(explainer: ExplainerRow): void;
  log?: { warn(message: string): void };
  now?: () => number;
}

interface ActiveJob {
  jobId: string;
  explainerId: string;
  controller: AbortController;
  workerId: string | null;
  done: Promise<void>;
}

export interface ExploreInput {
  threadId: string;
  messageId: string;
  turnId?: string | null;
  projectId?: string | null;
  emoji?: string;
  label: string;
  parentId?: string | null;
}

const PARENT_TITLE = "Explore";
const PARENT_ICON = "🧭";
const PARENT_MARKDOWN =
  "Explainers from **Explore**. When an agent ends an answer with things it noticed along the way, clicking one writes a page here that explains it.";

class Stopped extends Error {
  constructor() {
    super("Stopped.");
  }
}

export class ExploreService {
  private readonly active = new Map<string, ActiveJob>();
  private readonly parents = new Map<string, Promise<string>>();
  private readonly now: () => number;

  constructor(private readonly deps: ExploreDeps) {
    this.now = deps.now ?? Date.now;
  }

  get store(): ExploreStore {
    return this.deps.store;
  }

  /** Jobs from before a restart have no one running them; nor should their workers keep running. */
  recover(): string[] {
    const { explainerIds: ids, workerIds } = this.store.interruptActiveJobs();
    for (const workerId of workerIds) void this.deps.disposeWorker(workerId).catch(() => undefined);
    for (const id of ids) {
      const row = this.store.explainer(id);
      if (row) this.deps.changed(row);
    }
    return ids;
  }

  view(row: ExplainerRow): ExplainerView {
    const active = this.store.activeJob(row.id);
    const latest = active ?? this.store.latestJob(row.id);
    // Show the last job while it runs, or when it's why the explainer isn't ready.
    const job = latest && (isActiveJob(latest.status) || latest.status === "error" || latest.status === "interrupted") ? latest : null;
    return {
      id: row.id,
      parentId: row.parent_id,
      threadId: row.thread_id,
      messageId: row.message_id,
      turnId: row.turn_id,
      emoji: row.emoji,
      label: row.label,
      pageId: row.page_id,
      projectId: row.project_id,
      href: row.page_id ? explainerHref(row.page_id) : null,
      status: row.status,
      followUps: parseFollowUps(row.follow_ups),
      generatedAt: row.generated_at,
      regeneratedAt: row.regenerated_at,
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      job: job ? jobView(job) : null,
    };
  }

  isRunning(explainerId: string): boolean {
    // A stopped job may still be unwinding; it no longer blocks a new one.
    for (const job of this.active.values()) if (job.explainerId === explainerId && !job.controller.signal.aborted) return true;
    return false;
  }

  /**
   * A click on a finding: the explainer when it exists, the running job when
   * one is writing it, or a new job.
   */
  explore(input: ExploreInput): { explainer: ExplainerRow; started: boolean } {
    const parsed = parseExploreItem(`${input.emoji ?? ""} ${input.label}`);
    if (!parsed) throw new Error("Nothing to explore.");
    const key = explainerKey({ threadId: input.threadId, messageId: input.messageId, label: parsed.label, parentId: input.parentId ?? null });
    let row = this.store.byKey(key);
    if (!row) {
      if (input.parentId && !this.store.explainer(input.parentId)) throw new Error("That explainer no longer exists.");
      row = this.store.createExplainer({
        key,
        parentId: input.parentId ?? null,
        threadId: input.threadId,
        messageId: input.messageId,
        turnId: input.turnId ?? null,
        emoji: parsed.emoji,
        label: parsed.label,
        projectId: input.projectId ?? null,
      });
    }
    if (row.page_id || this.isRunning(row.id)) return { explainer: row, started: false };
    return { explainer: this.start(row, "generate"), started: true };
  }

  /** Writes it again. The page is replaced in place; Pages snapshots the old one. */
  regenerate(explainerId: string): ExplainerRow {
    const row = this.store.explainer(explainerId);
    if (!row) throw new Error("That explainer no longer exists.");
    if (this.isRunning(row.id)) return row;
    return this.start(row, row.page_id ? "regenerate" : "generate");
  }

  stop(explainerId: string): ExplainerRow | null {
    for (const job of this.active.values()) {
      if (job.explainerId !== explainerId) continue;
      job.controller.abort();
      this.store.updateJob(job.jobId, { status: "cancelled", label: STAGES.cancelled.label, detail: "Stopped.", error: null });
      if (job.workerId) void this.deps.disposeWorker(job.workerId);
    }
    const row = this.store.explainer(explainerId);
    if (!row) return null;
    if (row.status === "generating") this.store.setStatus(row.id, row.page_id ? "ready" : "pending");
    const next = this.store.explainer(explainerId)!;
    this.deps.changed(next);
    return next;
  }

  /** Resolves when the explainer's current job (if any) settles. */
  async settled(explainerId: string, signal?: AbortSignal): Promise<ExplainerRow | null> {
    for (const job of [...this.active.values()]) {
      if (job.explainerId !== explainerId) continue;
      await new Promise<void>((resolve) => {
        void job.done.then(resolve);
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    }
    return this.store.explainer(explainerId) ?? null;
  }

  dispose(): void {
    for (const job of this.active.values()) {
      job.controller.abort();
      if (job.workerId) void this.deps.disposeWorker(job.workerId);
    }
    this.active.clear();
  }

  // ---------------------------------------------------------------------

  private start(row: ExplainerRow, kind: JobKind): ExplainerRow {
    // A job the database says is running but no one is (a crash mid-write) is dead.
    const stale = this.store.activeJob(row.id);
    if (stale) this.store.updateJob(stale.id, { status: "interrupted", label: STAGES.interrupted.label, detail: "Superseded.", error: "Interrupted." });
    const job = this.store.createJob(row.id, kind);
    this.store.setStatus(row.id, "generating");
    const active: ActiveJob = { jobId: job.id, explainerId: row.id, controller: new AbortController(), workerId: null, done: Promise.resolve() };
    this.active.set(job.id, active);
    active.done = this.run(active, kind).finally(() => this.active.delete(job.id));
    const next = this.store.explainer(row.id)!;
    this.deps.changed(next);
    return next;
  }

  private stage(active: ActiveJob, status: JobStatus, detail: string, progress = STAGES[status].progress) {
    if (active.controller.signal.aborted) throw new Stopped();
    this.store.updateJob(active.jobId, { status, label: STAGES[status].label, detail, progress });
    const row = this.store.explainer(active.explainerId);
    if (row) this.deps.changed(row);
  }

  private async run(active: ActiveJob, kind: JobKind): Promise<void> {
    const { signal } = active.controller;
    try {
      // Let the caller get its answer before the first stage publishes.
      await Promise.resolve();
      const explainer = this.store.explainer(active.explainerId);
      if (!explainer) throw new Error("That explainer no longer exists.");

      this.stage(active, "collecting", "Reading what that answer looked at.");
      const context = await this.deps.collect(explainer, signal);
      const parent = explainer.parent_id ? this.store.explainer(explainer.parent_id) : undefined;
      let parentMarkdown: string | null = null;
      if (parent?.page_id) parentMarkdown = await this.deps.pages.markdown(parent.page_id).catch(() => null);
      const prompt = workerPrompt({
        item: { emoji: explainer.emoji, label: explainer.label },
        hints: context.hints,
        parent: parent ? { label: parent.label, markdown: parentMarkdown } : null,
        regenerating: kind === "regenerate",
      });

      this.stage(active, "starting", "Forking the thread at that answer.");
      const workerId = await this.deps.startWorker(explainer, prompt, context, signal);
      active.workerId = workerId;
      this.store.updateJob(active.jobId, { worker_thread_id: workerId });
      if (signal.aborted) throw new Stopped();

      this.stage(active, "writing", "Investigating.");
      const writing = STAGES.writing.progress;
      const span = STAGES.saving.progress - writing - 2;
      const output = await this.deps.awaitWorker(workerId, signal, ({ fraction, detail }) => {
        if (signal.aborted) return;
        this.store.updateJob(active.jobId, { detail, progress: writing + Math.max(0, Math.min(1, fraction)) * span });
        const row = this.store.explainer(active.explainerId);
        if (row) this.deps.changed(row);
      });
      const cleaned = cleanExplainerMarkdown(output);

      this.stage(active, "saving", "Saving the page.");
      const current = this.store.explainer(active.explainerId)!;
      const markdown = `${cleaned.markdown}\n\n---\n\n*Explored from [this thread](${threadHref(current.thread_id)}) by Explore.*`;
      const projectId = context.projectId ?? current.project_id;
      const pageId = await this.save(current, projectId, markdown, kind === "regenerate");
      if (signal.aborted) throw new Stopped();
      const saved = this.store.saved(current.id, {
        pageId,
        projectId,
        followUps: cleaned.followUps,
        regenerated: kind === "regenerate" && current.page_id === pageId,
      });
      this.store.updateJob(active.jobId, { status: "ready", label: STAGES.ready.label, detail: "Saved.", progress: 100 });
      this.deps.changed(saved);
    } catch (error) {
      if (error instanceof Stopped || signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      this.deps.log?.warn(`explainer ${active.explainerId} failed: ${message}`);
      this.store.updateJob(active.jobId, { status: "error", label: STAGES.error.label, detail: message, error: message });
      const row = this.store.explainer(active.explainerId);
      if (row) {
        this.store.setStatus(row.id, row.page_id ? "ready" : "error", message);
        this.deps.changed(this.store.explainer(row.id)!);
      }
    } finally {
      if (active.workerId) await this.deps.disposeWorker(active.workerId).catch(() => undefined);
    }
  }

  private async save(explainer: ExplainerRow, projectId: string | null, markdown: string, regenerate: boolean): Promise<string> {
    if (regenerate && explainer.page_id) {
      if (await this.deps.pages.get(explainer.page_id)) {
        const stamp = new Date(this.now()).toISOString().replace(/\.\d{3}Z$/, "Z");
        await this.deps.pages.replaceMarkdown(explainer.page_id, markdown, `Before regenerate ${stamp}`);
        return explainer.page_id;
      }
      // Deleted in Pages: write a new one.
      this.store.forgetPage(explainer.id);
    }
    const parentId = await this.parentPage(projectId);
    const page = await this.deps.pages.create({ projectId, parentId, title: explainer.label, icon: explainer.emoji, markdown });
    if (!(await this.deps.pages.tag(page.id))) this.deps.log?.warn(`couldn't tag page ${page.id} in Studio`);
    return page.id;
  }

  /** The project's "Explore" page that explainers live under, made the first time. */
  private parentPage(projectId: string | null): Promise<string> {
    const key = projectId ?? "";
    const pending = this.parents.get(key);
    if (pending) return pending;
    const made = (async () => {
      const known = this.store.parentPage(projectId);
      if (known) {
        const page = await this.deps.pages.get(known).catch(() => null);
        if (page && !page.archived) return known;
      }
      const page = await this.deps.pages.create({ projectId, parentId: null, title: PARENT_TITLE, icon: PARENT_ICON, markdown: PARENT_MARKDOWN });
      this.store.setParentPage(projectId, page.id);
      return page.id;
    })();
    this.parents.set(key, made);
    // Look it up again next time: it may be deleted or archived later.
    void made.then(
      () => this.parents.delete(key),
      () => this.parents.delete(key),
    );
    return made;
  }
}

export function jobView(job: JobRow): JobView {
  return {
    id: job.id,
    explainerId: job.explainer_id,
    kind: job.kind,
    status: job.status,
    label: job.label,
    detail: job.detail,
    progress: job.progress,
    error: job.error,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
  };
}

export type { ExploreItem };
