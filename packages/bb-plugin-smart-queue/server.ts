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
import { jevProviderChoices, jevRoutes } from "./jev-providers";
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
    jevProvider: {
      type: "select",
      label: "Jev provider",
      options: [...jevProviderChoices],
      default: "auto",
      description:
        "Where Smart Queue calls Jev. Auto tries TypeSafe, Vercel AI Gateway, OpenRouter, OpenCode Zen, then Custom, using each one that has a key, and moves on when one fails.",
    },
    typesafeApiKey: {
      type: "string",
      label: "TypeSafe API key",
      secret: true,
      description:
        "TypeSafe serves Jev directly. Create a key at https://console.typesafe.ai/keys. Falls back to the server's TYPESAFE_API_KEY environment variable.",
    },
    typesafeModel: {
      type: "string",
      label: "TypeSafe model",
      default: "jev-latest",
      description: "jev-latest follows each stable release, jev-preview tries previews, and a versioned ID such as jev-1.13.0 pins one.",
    },
    vercelApiKey: {
      type: "string",
      label: "Vercel AI Gateway API key",
      secret: true,
      description: "Calls Jev through Vercel AI Gateway. Falls back to AI_GATEWAY_API_KEY.",
    },
    openRouterApiKey: {
      type: "string",
      label: "OpenRouter API key",
      secret: true,
      description: "Calls Jev through OpenRouter. Falls back to OPENROUTER_API_KEY.",
    },
    zenApiKey: {
      type: "string",
      label: "OpenCode Zen API key",
      secret: true,
      description: "Calls Jev through OpenCode Zen. Falls back to OPENCODE_API_KEY.",
    },
    customJevEndpoint: {
      type: "string",
      label: "Custom Jev endpoint",
      description:
        "Bring your own provider: the full URL of any endpoint that speaks TypeSafe's System One API, such as https://gateway.example.com/v1/systemone. HTTPS is required except on localhost.",
    },
    customJevApiKey: {
      type: "string",
      label: "Custom Jev API key",
      secret: true,
      description: "Sent as a bearer token to the custom endpoint. Leave empty if it needs none.",
    },
    customJevModel: {
      type: "string",
      label: "Custom Jev model",
      description: "The model name the custom endpoint expects, such as jev-latest.",
    },
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
      default: "",
      description:
        "Used when no Jev provider answers. Empty uses the thread's own provider. Enter none to skip straight to follow-up.",
    },
    fallbackModel: {
      type: "string",
      label: "Fallback model",
      default: "",
      description:
        "A fast, cheap model from that provider's catalog. Empty uses the provider's default model. It runs in a hidden, temporary thread.",
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
    return { projectId: personal.id, hostId: environment.hostId, queuedMessageId, threadProviderId: thread.providerId };
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
          const { routes, problems } = jevRoutes(current);
          const fallbackProvider = current.fallbackProvider?.trim() ?? "";
          const fallbackModel = current.fallbackModel?.trim() ?? "";
          const status = {
            enabled: current.enabled,
            jevProvider: current.jevProvider ?? "auto",
            // Names, endpoints, and models only; keys never leave the server.
            jev: routes.map(({ name, endpoint, model }) => ({ name, endpoint, model })),
            problems,
            fallback:
              fallbackProvider.toLowerCase() === "none"
                ? null
                : `${fallbackProvider || "the thread's provider"}${fallbackModel ? `/${fallbackModel}` : " (default model)"}`,
            holding: [...queue.entries.values()].filter((entry) => entry.state === "pending").length,
          };
          return reply(
            status,
            [
              `Smart Queue: ${status.enabled ? "on" : "off"}`,
              `Jev provider: ${status.jevProvider}`,
              status.jev.length
                ? `Jev routes: ${status.jev.map((route) => `${route.name} (${route.model})`).join(" → ")}`
                : "Jev routes: none (add a TypeSafe key, another provider key, or a custom endpoint)",
              ...problems.map((problem) => `Problem: ${problem}`),
              `Fallback model: ${status.fallback ?? "off (follow-up)"}`,
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
