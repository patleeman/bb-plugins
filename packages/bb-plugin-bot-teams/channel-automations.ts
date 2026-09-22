import { isExecuting } from "./job-state";
import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { authorizeChannel } from "./agent-channels";
import type { Store } from "./store";
import type { Runtime } from "./runtime";
import {
  channelAutomationCreate,
  channelAutomationList,
  channelAutomationUpdate,
  channelAutomationAction,
  channelAutomationView,
  channelAutomationRuns,
  channelAutomationRunPage,
} from "./automation-contract";

// Task text is data in the automation record, never interpolated into shell code.
export const dispatchScript = `#!/bin/sh
set -eu
unset BB_THREAD_ID BB_ENVIRONMENT_ID
exec bb bots automation-dispatch --project "$BB_PROJECT_ID" --automation "$BB_AUTOMATION_ID" --run "$BB_AUTOMATION_RUN_ID" --json
`;
const metadataKey = "BB_BOTS_CHANNEL_AUTOMATION";
const metadataSchema = z.object({
  version: z.literal(1),
  channelId: z.string().uuid(),
  botId: z.string().regex(/^bot_[a-f0-9]{16}$/),
  prompt: z.string().min(1).max(8000),
  requestId: z.string().uuid(),
  creationHash: z.string(),
});
type Metadata = z.infer<typeof metadataSchema>;
// Deliberately project only the Automations public RPC fields we consume.
const automationSchema = channelAutomationView
  .omit({ channelId: true, botId: true, prompt: true })
  .extend({
    createdByThreadId: z.string().nullable(),
    execution: z.object({
      mode: z.string(),
      script: z.string().optional(),
      env: z.record(z.string(), z.string()).optional(),
    }),
  });
type Automation = z.infer<typeof automationSchema>;
const runSchema = z.object({ id: z.string(), status: z.string() });
function metadata(automation: Automation): Metadata | null {
  if (automation.execution.mode !== "script") return null;
  try {
    return metadataSchema.parse(
      JSON.parse(automation.execution.env?.[metadataKey] ?? ""),
    );
  } catch {
    return null;
  }
}
function view(automation: Automation) {
  const m = metadata(automation);
  if (!m) throw new Error("This is not a channel automation.");
  return channelAutomationView.parse({ ...automation, ...m });
}
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export class ChannelAutomations {
  constructor(
    readonly bb: BbPluginApi,
    readonly store: Store,
    readonly runtime: Runtime,
  ) {}

  private rpc<T>(
    method: string,
    input: Record<string, unknown>,
    outputSchema: z.ZodType<T>,
  ) {
    return this.bb.sdk.plugins.callRpc({
      pluginId: "automations",
      method: `automations_${method}`,
      input: input as never,
      outputSchema,
    });
  }
  private context(channelId: string | undefined, threadId?: string) {
    const conversation = threadId ? this.store.byThread(threadId) : null;
    const job =
      conversation &&
      this.store
        .work(conversation.botId)
        .find((j) => j.threadId === threadId && isExecuting(j));
    const id = channelId ?? job?.roomId;
    if (!id) throw new Error("Choose a channelId for this automation.");
    const room = this.store.room(id);
    const author = threadId
      ? authorizeChannel(this.store, threadId, id)
      : undefined;
    const projectId = this.store.all()[0]?.projectId;
    if (!projectId)
      throw new Error("Create a bot before scheduling channel work.");
    return { room, projectId, author };
  }
  private preventRecursion(threadId?: string) {
    if (!threadId) return;
    const c = this.store.byThread(threadId);
    if (
      c &&
      this.store
        .work(c.botId)
        .some(
          (j) => j.threadId === threadId && isExecuting(j) && j.automationId,
        )
    )
      throw new Error(
        "Scheduled channel work cannot create, resume, update, or run automations. Ask the owner in a normal channel response.",
      );
  }
  private async all(projectId: string) {
    const rows = await this.rpc("list", { projectId }, z.array(z.unknown()));
    return rows.flatMap((row) => {
      const result = automationSchema.safeParse(row);
      return result.success && metadata(result.data) ? [result.data] : [];
    });
  }
  async list(input: z.output<typeof channelAutomationList>, threadId?: string) {
    const { room, projectId } = this.context(input.channelId, threadId);
    const rows = (await this.all(projectId)).filter(
      (a) => metadata(a)!.channelId === room.id,
    );
    return {
      automations: rows
        .slice(input.offset, input.offset + input.limit)
        .map(view),
      nextOffset:
        input.offset + input.limit < rows.length
          ? input.offset + input.limit
          : null,
    };
  }
  async create(
    input: z.output<typeof channelAutomationCreate>,
    threadId?: string,
  ) {
    this.preventRecursion(threadId);
    const context = this.context(input.channelId, threadId);
    return this.runtime.locked(
      `automation-create:${context.projectId}`,
      async () => {
        // Re-check membership after waiting for another creation.
        const { room, projectId, author } = this.context(
          context.room.id,
          threadId,
        );
        const botId = input.botId ?? author?.botId;
        if (!botId)
          throw new Error(
            "Choose the botId that will perform this automation.",
          );
        if (author?.botId && author.botId !== botId)
          throw new Error("A bot can only schedule its own channel work.");
        const bot = this.store.get(botId);
        if (room.archived || bot.retired || !room.memberIds.includes(botId))
          throw new Error("Choose an active bot that belongs to this channel.");
        const creationHash = hash([
          room.id,
          botId,
          input.name,
          input.prompt,
          input.trigger,
          input.enabled,
          threadId ?? null,
        ]);
        const existing = (await this.all(projectId)).find(
          (a) => metadata(a)!.requestId === input.requestId,
        );
        if (existing) {
          if (metadata(existing)!.creationHash !== creationHash)
            throw new Error(
              "This requestId was already used for another automation.",
            );
          return view(existing);
        }
        const m: Metadata = {
          version: 1,
          channelId: room.id,
          botId,
          prompt: input.prompt,
          requestId: input.requestId,
          creationHash,
        };
        const automation = await this.rpc(
          "create",
          {
            projectId,
            name: input.name,
            enabled: input.enabled,
            trigger: input.trigger,
            origin: threadId ? "agent" : "human",
            ...(threadId ? { createdByThreadId: threadId } : {}),
            execution: this.execution(m),
          },
          automationSchema,
        );
        this.runtime.changed();
        return view(automation);
      },
    );
  }
  private execution(m: Metadata) {
    return {
      mode: "script",
      interpreter: "sh",
      script: dispatchScript,
      timeoutMs: 60_000,
      env: { [metadataKey]: JSON.stringify(m) },
    };
  }
  private async target(
    channelId: string | undefined,
    automationId: string,
    threadId?: string,
  ) {
    const { room, projectId, author } = this.context(channelId, threadId);
    const automation = await this.rpc(
      "get",
      { projectId, automationId },
      automationSchema,
    );
    const m = metadata(automation);
    if (!m || m.channelId !== room.id)
      throw new Error("Automation not found in this channel.");
    if (author?.botId && author.botId !== m.botId)
      throw new Error("A bot can only manage its own channel automations.");
    return { automation, m, room, projectId };
  }
  async update(
    input: z.output<typeof channelAutomationUpdate>,
    threadId?: string,
  ) {
    this.preventRecursion(threadId);
    return this.runtime.locked(`automation:${input.automationId}`, async () => {
      const { m, projectId } = await this.target(
        input.channelId,
        input.automationId,
        threadId,
      );
      const result = await this.rpc(
        "update",
        {
          projectId,
          automationId: input.automationId,
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.trigger !== undefined ? { trigger: input.trigger } : {}),
          ...(input.prompt !== undefined
            ? { execution: this.execution({ ...m, prompt: input.prompt }) }
            : {}),
        },
        automationSchema,
      );
      this.runtime.changed();
      return view(result);
    });
  }
  async action(
    input: z.output<typeof channelAutomationAction>,
    threadId?: string,
  ) {
    if (["resume", "run"].includes(input.action))
      this.preventRecursion(threadId);
    const { m, room, projectId } = await this.target(
      input.channelId,
      input.automationId,
      threadId,
    );
    if (
      ["resume", "run"].includes(input.action) &&
      (room.archived ||
        this.store.get(m.botId).retired ||
        !room.memberIds.includes(m.botId))
    )
      throw new Error(
        "Restore the channel and invite its bot before running this automation.",
      );
    const result = await this.rpc(
      input.action,
      {
        projectId,
        automationId: input.automationId,
        ...(input.action === "run" ? { idempotencyKey: input.requestId } : {}),
      },
      z.unknown(),
    );
    this.runtime.changed();
    return { ok: true as const, result: result ?? null };
  }
  async runs(input: z.output<typeof channelAutomationRuns>, threadId?: string) {
    const { projectId } = await this.target(
      input.channelId,
      input.automationId,
      threadId,
    );
    const page = await this.rpc(
      "runs",
      {
        projectId,
        automationId: input.automationId,
        limit: input.limit,
        ...(input.cursor ? { cursor: input.cursor } : {}),
      },
      channelAutomationRunPage,
    );
    return {
      ...page,
      runs: page.runs.map((run) => {
        const jobs = this.store.requestJobs(
          `automation:${input.automationId}:${run.id}`,
        );
        const current = jobs.filter(
          (j) => !jobs.some((r) => r.retryOf === j.id),
        );
        const pending = current.find((j) =>
          ["queued", "dispatching", "running"].includes(j.status),
        );
        const error = current.find((j) => j.status === "error");
        const last = current.at(-1);
        const response = current.find((j) => !!this.store.message(j.id));
        return {
          ...run,
          ...(last
            ? {
                responseStatus: pending?.status ?? error?.status ?? last.status,
                ...(last.threadId ? { responseThreadId: last.threadId } : {}),
                ...(response ? { responseMessageId: response.id } : {}),
                ...(error?.error ? { responseError: error.error } : {}),
              }
            : {}),
          output: run.output?.slice(0, 2000) ?? null,
          error: run.error?.slice(0, 2000) ?? null,
        };
      }),
    };
  }
  async dispatch(
    projectId: string,
    automationId: string,
    runId: string,
    threadId?: string,
    signal?: AbortSignal,
  ) {
    if (threadId)
      throw new Error(
        "Only the automation runner dispatches scheduled channel work. Use the run action.",
      );
    const automation = await this.rpc(
      "get",
      { projectId, automationId },
      automationSchema,
    );
    const m = metadata(automation);
    if (!m || automation.execution.script !== dispatchScript)
      throw new Error("This automation is not a channel dispatcher.");
    return this.runtime.locked(`room:${m.channelId}`, async () => {
      signal?.throwIfAborted();
      const { runs } = await this.rpc(
        "runs",
        { projectId, automationId, limit: 100 },
        z.object({ runs: z.array(runSchema) }),
      );
      signal?.throwIfAborted();
      if (!runs.some((r) => r.id === runId && r.status === "running"))
        throw new Error("Automation run is no longer active.");
      const room = this.store.findRoom(m.channelId);
      const bot = this.store.all().find((b) => b.id === m.botId);
      if (
        !room ||
        room.archived ||
        !bot ||
        bot.retired ||
        !room.memberIds.includes(bot.id)
      )
        return {
          wakeAgent: false,
          reason: "Channel or bot is no longer active.",
        };
      if (bot.projectId !== projectId)
        throw new Error("Automation belongs to a different project.");
      const requestId = `automation:${automationId}:${runId}`;
      const existing = this.store.message(requestId);
      if (existing) return { requestId: existing.id, channelId: room.id };
      if (
        this.store
          .roomJobs(room.id, -1)
          .some(
            (j) =>
              j.automationId === automationId &&
              (!["done", "error", "cancelled"].includes(j.status) ||
                j.cancellationPending),
          )
      )
        return {
          wakeAgent: false,
          reason: "The previous channel response is still unfinished.",
        };
      this.runtime.sendScheduled(
        room,
        bot.id,
        automationId,
        automation.name,
        m.prompt,
        requestId,
      );
      return { requestId, channelId: room.id };
    });
  }
  registerTools() {
    const names: string[] = [];
    const register = <S extends z.ZodType>(
      name: string,
      description: string,
      parameters: S,
      execute: (input: z.output<S>, threadId: string) => Promise<unknown>,
    ) => {
      names.push(name);
      this.bb.agents.registerTool({
        name,
        description,
        parameters,
        execute: async (input, context) =>
          JSON.stringify(await execute(input, context.threadId)),
      });
    };
    register(
      "bots_channel_automation_create",
      "Schedule your own work in a channel. Defaults to your current channel and bot; other agents must supply both IDs. Use cron plus an IANA timezone, or a one-shot runAt in Unix milliseconds. Reuse requestId on retries. Runs use current channel history and post the bot's final answer there.",
      channelAutomationCreate,
      (input, thread) => this.create(input, thread),
    );
    register(
      "bots_channel_automations",
      "List a channel's automations. Defaults to your current channel. Page with offset.",
      channelAutomationList,
      (input, thread) => this.list(input, thread),
    );
    register(
      "bots_channel_automation_update",
      "Update your channel automation's name, prompt, or schedule. Omitted fields stay unchanged.",
      channelAutomationUpdate,
      (input, thread) => this.update(input, thread),
    );
    register(
      "bots_channel_automation_runs",
      "Read bounded dispatch history for your channel automation. This records dispatch success; inspect channel activity for the bot's response. Page with cursor.",
      channelAutomationRuns,
      (input, thread) => this.runs(input, thread),
    );
    register(
      "bots_channel_automation_action",
      "Pause, resume, run, or delete your channel automation. Run requires a UUID requestId; reuse it on retries. Pausing affects future runs; stop an active response through channel activity.",
      channelAutomationAction,
      (input, thread) => this.action(input, thread),
    );
    return names;
  }
}
