import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  askJev,
  askModel,
  classifierTitlePrefix,
  classify,
  discardSession,
  type ClassifierSettings,
  type Situation,
} from "./classifier";
import { SmartQueue, describeVerdict, rowText, type DecisionRecord, type ThreadInfo } from "./queue";

const recentKey = "recent-decisions";
const recentLimit = 30;
const watchIntervalMs = 1000;

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    enabled: {
      type: "boolean",
      label: "Classify messages sent to busy threads",
      default: true,
      description:
        "Hold an owner message sent while a thread is working, then steer the current turn or queue it as a follow-up.",
    },
    zenApiKey: {
      type: "string",
      label: "OpenCode Zen API key",
      secret: true,
      description:
        "Used for Jev. Falls back to the server's OPENCODE_API_KEY environment variable. Without a key, Smart Queue uses the fallback model.",
    },
    jevModel: { type: "string", label: "Jev model", default: "jev-1.13" },
    jevTimeoutMs: {
      type: "number",
      label: "Jev timeout (milliseconds)",
      default: 5000,
      experimental_schema: z.number().int().min(250).max(15000),
      description: "Direct request deadline, from 250 to 15000 milliseconds.",
    },
    steerConfidence: {
      type: "number",
      label: "Minimum Jev confidence to steer",
      default: 0.7,
      experimental_schema: z.number().min(0).max(1),
      description: "A value from 0 to 1. An uncertain steer becomes a follow-up.",
    },
    fallbackProvider: {
      type: "string",
      label: "Fallback provider",
      default: "pi",
      description: "Used when Jev is unavailable or fails. Leave empty to fall back straight to follow-up.",
    },
    fallbackModel: {
      type: "string",
      label: "Fallback model",
      default: "opencode-go/qwen3.8-flash",
      description: "A fast model from your BB provider catalog. It runs in a hidden, temporary thread.",
    },
  });
  const config = async (): Promise<ClassifierSettings & { enabled: boolean }> => settings.get();
  const sessions = new Set<string>();

  async function situation(threadId: string, message: string, thread: ThreadInfo): Promise<Situation> {
    const [history, output] = await Promise.all([
      bb.sdk.threads.promptHistory({ threadId, limit: "3" }).catch(() => []),
      bb.sdk.threads.output({ threadId }).catch(() => ({ output: null })),
    ]);
    return {
      title: thread.title ?? thread.titleFallback,
      requests: [...history]
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((prompt) => rowText({ content: prompt.input }))
        .filter(Boolean),
      latestOutput: output.output,
      message,
    };
  }

  /** Classifier sessions run on the thread's machine, in BB's Personal project, away from the user's projects. */
  async function modelTarget(thread: ThreadInfo, queuedMessageId: string) {
    if (!thread.environmentId) throw new Error("The thread has no environment to run the fallback model on.");
    const [environment, projects] = await Promise.all([
      bb.sdk.environments.get({ environmentId: thread.environmentId }),
      bb.sdk.projects.list({ includePersonal: true }),
    ]);
    const personal = projects.find((project) => project.kind === "personal");
    if (!personal) throw new Error("BB's Personal project is unavailable.");
    return { projectId: personal.id, hostId: environment.hostId, queuedMessageId };
  }

  async function record(entry: DecisionRecord) {
    const recent = (await bb.storage.kv.get<DecisionRecord[]>(recentKey)) ?? [];
    await bb.storage.kv.set(recentKey, [entry, ...recent].slice(0, recentLimit));
    bb.log.info(
      `Smart Queue chose ${entry.verdict.action} for ${entry.queuedMessageId} in ${entry.threadId} (${describeVerdict(entry.verdict)}).`,
    );
  }

  const queue = new SmartQueue({
    pluginId: bb.pluginId,
    enabled: async () => (await config()).enabled,
    thread: (threadId) => bb.sdk.threads.get({ threadId }),
    classify: async (row, thread, signal) => {
      const settingsNow = await config();
      const state = await situation(row.threadId, rowText(row), thread);
      return classify(
        {
          jev: (s) => askJev(settingsNow, state, s),
          model: async (s) =>
            askModel(
              bb,
              settingsNow,
              await modelTarget(thread, row.id),
              state,
              s,
              sessions,
            ),
          warn: (message) => bb.log.warn(message),
        },
        signal,
      );
    },
    steer: async (row) => {
      await bb.sdk.threads.queuedMessages.send({ threadId: row.threadId, queuedMessageId: row.id, mode: "steer" });
    },
    recheck: () => bb.experimental_hooks.recheck("message.dispatch"),
    record,
    warn: (message) => bb.log.warn(message),
  });

  bb.experimental_hooks.on("message.dispatch", (context) => queue.dispatch(context));
  bb.events.on("message.queued", ({ entry }) => queue.queued(entry));
  bb.events.on("message.dispatched", ({ entry }) => queue.gone(entry));
  bb.events.on("message.cancelled", ({ entry }) => queue.gone(entry));
  bb.events.on("thread.idle", ({ thread }) => queue.settled(thread.id));
  bb.events.on("thread.failed", ({ thread }) => queue.settled(thread.id));
  bb.events.on("thread.archived", ({ thread }) => queue.forget(thread.id));
  bb.events.on("thread.deleted", ({ thread }) => queue.forget(thread.id));
  bb.onDispose(() => queue.dispose());

  bb.background.service("queue-watch", {
    async start(signal) {
      while (!signal.aborted) {
        const listedAt = Date.now();
        try {
          if ((await config()).enabled) queue.sync(await bb.sdk.threads.queue.list({ signal }), listedAt);
        } catch (error) {
          if (!signal.aborted) bb.log.warn(`Smart Queue could not read queued messages: ${String(error)}`);
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, watchIntervalMs);
          signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
        });
      }
    },
  });

  bb.background.service("recovery", {
    async start() {
      // Remove classifier sessions a previous load left behind.
      for (let offset = 0; ; offset += 100) {
        const threads = await bb.sdk.threads.list({
          originPluginId: bb.pluginId,
          includeHidden: true,
          limit: 100,
          offset,
        });
        for (const thread of threads)
          if (thread.title?.startsWith(classifierTitlePrefix) && !sessions.has(thread.id))
            await discardSession(bb, thread.id, new Set());
        if (threads.length < 100) break;
      }
      // Rows this plugin held before a reload lost their decisions: release or re-hold them.
      await bb.experimental_hooks.recheck("message.dispatch");
    },
  });

  const usage = [
    "Usage:",
    "  bb smart-queue status [--json]",
    "  bb smart-queue recent [--limit <n>] [--json]",
    "  bb smart-queue classify <thread-id> <message> [--json]",
  ].join("\n");
  bb.cli.register({
    name: "smart-queue",
    summary: "Inspect how Smart Queue steers or queues messages sent to busy threads",
    commands: [
      { name: "status", summary: "Show which classifiers are configured", usage: "bb smart-queue status [--json]" },
      {
        name: "recent",
        summary: "List recent steer and follow-up decisions",
        usage: "bb smart-queue recent [--limit <n>] [--json]",
      },
      {
        name: "classify",
        summary: "Dry-run the classifier for a message to a thread without sending it",
        usage: "bb smart-queue classify <thread-id> <message> [--json]",
      },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const args = argv.filter((arg) => arg !== "--json");
      const [command, ...rest] = args;
      const reply = (value: unknown, text: string) => ({
        exitCode: 0,
        stdout: json ? JSON.stringify(value) : text,
      });
      switch (command) {
        case undefined:
        case "help":
        case "--help":
          return { exitCode: 0, stdout: usage };
        case "status": {
          const current = await config();
          const jevKey = Boolean(current.zenApiKey?.trim() || process.env.OPENCODE_API_KEY?.trim());
          const fallback =
            current.fallbackProvider && current.fallbackModel
              ? `${current.fallbackProvider}/${current.fallbackModel}`
              : null;
          const status = {
            enabled: current.enabled,
            jev: jevKey ? current.jevModel : null,
            fallback,
            holding: [...queue.entries.values()].filter((entry) => entry.state === "pending").length,
          };
          return reply(
            status,
            [
              `Smart Queue: ${status.enabled ? "on" : "off"}`,
              `Jev: ${status.jev ?? "unavailable (no OpenCode Zen API key)"}`,
              `Fallback model: ${status.fallback ?? "none (follow-up)"}`,
              `Deciding now: ${status.holding}`,
            ].join("\n"),
          );
        }
        case "recent": {
          const limitIndex = rest.indexOf("--limit");
          const limit = z.coerce
            .number()
            .int()
            .min(1)
            .max(recentLimit)
            .catch(10)
            .parse(limitIndex >= 0 ? rest[limitIndex + 1] : 10);
          const recent = ((await bb.storage.kv.get<DecisionRecord[]>(recentKey)) ?? []).slice(0, limit);
          return reply(
            recent,
            recent.length
              ? recent
                  .map(
                    (entry) =>
                      `${new Date(entry.at).toISOString()}  ${entry.verdict.action.padEnd(8)}  ${describeVerdict(entry.verdict)}  ${entry.threadId}  ${entry.preview}`,
                  )
                  .join("\n")
              : "No decisions yet.",
          );
        }
        case "classify": {
          const [threadId, ...words] = rest;
          const message = words.join(" ").trim();
          if (!threadId || !message) break;
          const thread = await bb.sdk.threads.get({ threadId });
          const settingsNow = await config();
          const state = await situation(threadId, message.slice(0, 16000), thread);
          const verdict = await classify(
            {
              jev: (s) => askJev(settingsNow, state, s),
              model: async (s) =>
                askModel(
                  bb,
                  settingsNow,
                  await modelTarget(thread, "dry-run"),
                  state,
                  s,
                  sessions,
                ),
              warn: (text) => bb.log.warn(text),
            },
            AbortSignal.timeout(60_000),
          );
          return reply(
            verdict,
            [`${verdict.action} (${describeVerdict(verdict)})`, verdict.note].filter(Boolean).join("\n"),
          );
        }
      }
      return { exitCode: 1, stderr: usage };
    },
  });
}
