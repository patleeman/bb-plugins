// Explore, wired into Pages: agents end answers with what they noticed along
// the way (`::explore{items="…"}`); a click writes a page explaining it.
//
//   - ExploreService (service.ts) runs each explainer's job; workers are
//     hidden forks of the thread (worker.ts); pages are written in process
//     under the project's "Explore" page and tagged in Studio (pages.ts).
//   - This file adds the RPC handlers (merged into Pages' contract), the
//     `pages_explore` tool, the instructions for `bb.agents.configure`, and
//     `bb pages explore …`.
import type { BbPluginApi, PluginCliContext, PluginCliResult } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { PagesService } from "../service";
import { explorePages } from "./pages";
import { exploreInstructions } from "./prompt";
import { ExploreService } from "./service";
import { MAX_LABEL_LENGTH, STAGES } from "./shared";
import { ExploreStore, type ExplainerRow } from "./store";
import { walk } from "./timeline";
import { exploreWorkers } from "./worker";

export const EXPLORE_TOOL = "pages_explore";

const USAGE = {
  list: "bb pages explore list [--thread <thread id>]",
  open: "bb pages explore open <explainer id>",
  regenerate: "bb pages explore regenerate <explainer id> [--wait]",
};
export const EXPLORE_USAGE = `bb pages explore <list|open|regenerate> …`;

type CliResult = PluginCliResult;

export function registerExplore(bb: BbPluginApi, pages: PagesService) {
  const store = new ExploreStore(bb.storage.database());
  const workers = exploreWorkers(bb);
  const service = new ExploreService({
    store,
    pages: explorePages(pages, bb.sdk.plugins),
    collect: workers.collect,
    startWorker: (explainer, prompt, context) => workers.startWorker(explainer, prompt, context),
    awaitWorker: workers.awaitWorker,
    disposeWorker: workers.disposeWorker,
    changed(explainer) {
      pages.publish({
        type: "explainer",
        explainerId: explainer.id,
        threadId: explainer.thread_id,
        messageId: explainer.message_id,
        parentId: explainer.parent_id,
      });
    },
    log: bb.log,
  });
  const interrupted = service.recover();
  if (interrupted.length) bb.log.info(`Marked ${interrupted.length} Explore job(s) interrupted by the restart.`);

  const view = (row: ExplainerRow | null | undefined) => (row ? service.view(row) : null);
  const mustGet = (id: string): ExplainerRow => {
    const row = store.explainer(id);
    if (!row) throw new Error(`Explainer ${id} not found.`);
    return row;
  };

  // RPC (merged into Pages' `bb.rpc.register`) ---------------------------------

  const rpc = {
    explore: ({ threadId, messageId, turnId, emoji, label, parentId }: { threadId: string; messageId: string; turnId?: string | null; emoji?: string; label: string; parentId?: string | null }) => {
      const result = service.explore({ threadId, messageId, turnId, emoji, label, parentId });
      return { explainer: service.view(result.explainer), started: result.started };
    },
    exploreRegenerate: ({ explainerId }: { explainerId: string }) => ({ explainer: service.view(service.regenerate(explainerId)) }),
    exploreStop: ({ explainerId }: { explainerId: string }) => ({ explainer: view(service.stop(explainerId)) }),
    explainer: ({ explainerId }: { explainerId: string }) => ({ explainer: view(store.explainer(explainerId)) }),
    explainersForMessage: ({ threadId, messageId, parentId }: { threadId: string; messageId: string; parentId?: string | null }) => ({
      explainers: store.forMessage(threadId, messageId, parentId ?? null).map((row) => service.view(row)),
    }),
    explainers: ({ threadId, limit }: { threadId?: string; limit?: number }) => ({
      explainers: store.list({ threadId, limit }).map((row) => service.view(row)),
    }),
  };

  // Agents ---------------------------------------------------------------------

  /** The newest assistant message in a thread, for a tool call without one. */
  async function latestAssistantMessage(threadId: string, signal: AbortSignal): Promise<{ id: string; turnId: string | null } | null> {
    const timeline = await bb.sdk.threads.timeline({ threadId, includeNestedRows: "true", segmentLimit: "20", signal });
    let found: { id: string; turnId: string | null } | null = null;
    for (const { row, turnId } of walk(timeline.rows)) {
      if (row.kind === "conversation" && row.role === "assistant" && typeof row.id === "string") found = { id: row.id, turnId };
    }
    return found;
  }

  function describe(row: ExplainerRow): string {
    const explainer = service.view(row);
    const title = `${explainer.emoji} ${explainer.label}`;
    if (explainer.job && service.isRunning(explainer.id)) {
      return `${title}: ${explainer.job.label} (${Math.round(explainer.job.progress)}%). Explainer id ${explainer.id}; it will be saved in Pages under Explore.`;
    }
    if (explainer.href) {
      const followUps = explainer.followUps.length ? `\nIt suggests exploring next: ${explainer.followUps.map((item) => `${item.emoji} ${item.label}`).join(" | ")}` : "";
      return `Explainer ready: [${explainer.label}](${explainer.href}) (id ${explainer.id}, page ${explainer.pageId}).${followUps}`;
    }
    return `${title}: ${explainer.error ?? "not written yet"} (id ${explainer.id}).`;
  }

  bb.agents.registerTool({
    name: EXPLORE_TOOL,
    description:
      'Write (or find) an Explore explainer: a Studio Page that investigates one finding in the repository, like "How the job queue works". ' +
      "Returns the page link. Use it when the user asks you to explore or explain something you noticed. Waits for the page unless wait is false.",
    presentation: { label: { pending: "Exploring", completed: "Explored" } },
    parameters: z.object({
      label: z.string().trim().min(1).max(MAX_LABEL_LENGTH * 2).describe('An emoji and a specific label, e.g. "🏗️ How the job queue works".'),
      messageId: z.string().min(1).max(200).optional().describe("The assistant message the finding came from. Defaults to the newest one in this thread."),
      wait: z.boolean().optional(),
    }),
    async execute({ label, messageId, wait }, context) {
      const anchor = messageId ? { id: messageId, turnId: null } : await latestAssistantMessage(context.threadId, context.signal);
      if (!anchor) return { content: [{ type: "text", text: "There's no answer in this thread to explore from yet." }], isError: true };
      const { explainer } = service.explore({ threadId: context.threadId, messageId: anchor.id, turnId: anchor.turnId, projectId: context.projectId, label });
      const settled = wait === false ? explainer : ((await service.settled(explainer.id, context.signal)) ?? explainer);
      const failed = !settled.page_id && settled.status === "error";
      return failed ? { content: [{ type: "text", text: describe(settled) }], isError: true } : describe(settled);
    },
  });

  const instructions = exploreInstructions();

  // CLI: `bb pages explore …` ----------------------------------------------------

  const line = (row: ExplainerRow) => {
    const explainer = service.view(row);
    const state = service.isRunning(row.id) ? `${STAGES[explainer.job?.status ?? "queued"].label} ${Math.round(explainer.job?.progress ?? 0)}%` : explainer.status;
    return [explainer.id, state, `${explainer.emoji} ${explainer.label}`, explainer.href ?? "", explainer.threadId].join("\t");
  };

  async function cli(argv: string[], ctx: PluginCliContext): Promise<CliResult> {
    const [command, ...rest] = argv;
    const positional = rest.filter((arg) => !arg.startsWith("--"));
    const flag = (name: string) => rest.indexOf(`--${name}`);
    const fail = (message: string): CliResult => ({ exitCode: 1, stderr: `${message}\n` });
    switch (command) {
      case "list": {
        const at = flag("thread");
        const threadId = at >= 0 ? rest[at + 1] : undefined;
        if (at >= 0 && (!threadId || threadId.startsWith("--"))) return fail(`usage: ${USAGE.list}`);
        const rows = store.list({ threadId, limit: 200 });
        return { exitCode: 0, stdout: rows.length ? `${rows.map(line).join("\n")}\n` : "No explainers.\n" };
      }
      case "open": {
        const row = store.explainer(positional[0] ?? "");
        if (!row) return fail(`usage: ${USAGE.open}`);
        return { exitCode: 0, stdout: `${describe(row)}\n` };
      }
      case "regenerate": {
        const id = positional[0] ?? "";
        if (!store.explainer(id)) return fail(`usage: ${USAGE.regenerate}`);
        service.regenerate(id);
        if (flag("wait") < 0) return { exitCode: 0, stdout: `${line(mustGet(id))}\n` };
        const settled = (await service.settled(id, ctx.signal)) ?? mustGet(id);
        return { exitCode: settled.status === "error" || !settled.page_id ? 1 : 0, stdout: `${describe(settled)}\n` };
      }
      default:
        return fail(`usage: ${EXPLORE_USAGE}\n  ${USAGE.list}\n  ${USAGE.open}\n  ${USAGE.regenerate}`);
    }
  }

  bb.onDispose(() => {
    service.dispose();
    workers.dispose();
  });

  return {
    service,
    rpc,
    cli,
    /** Explore's part of `bb.agents.configure`: the tool, and the instructions when the setting is on. */
    configure: (enabled: boolean) => ({ tools: [EXPLORE_TOOL], instructions: enabled ? instructions : null }),
    /** Pages were deleted: their explainers write a new page next time. */
    pagesDeleted(pageIds: readonly string[]) {
      for (const id of store.forgetPages(pageIds)) {
        const row = store.explainer(id);
        if (row) pages.publish({ type: "explainer", explainerId: row.id, threadId: row.thread_id, messageId: row.message_id, parentId: row.parent_id });
      }
    },
  };
}
