import { randomUUID } from "node:crypto";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { posix, win32 } from "node:path";
import {
  PLUGIN_CLI_OUTPUT_MAX_BYTES,
  type BbPluginApi,
  type PluginCliContext,
  type PluginRpcHandlers,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { rpcContract, notifyInput, type Bot, type ProfileInput } from "./contract";
import type { Store } from "./store";
import type { ChannelAutomations } from "./channel-automations";
import {
  channelAutomationCreate,
  channelAutomationUpdate,
  channelAutomationList,
  channelAutomationAction,
} from "./automation-contract";
import {
  channelReaction,
  requestStatus,
  creatorMembers,
  authorizeChannel,
  agentAuthor,
  notifyOwner,
  type SendMessage,
} from "./agent-channels";

type Method = keyof typeof rpcContract;
type Output<K extends Method> = z.output<(typeof rpcContract)[K]["output"]>;
type BotCreateApproval = { approved: boolean; bot: Bot | null };
const profileFlags = [
  "name",
  "description",
  "avatar",
  "provider",
  "model",
  "reasoning",
  "permissions",
  "interval",
];
const commands = [
  ["inbox", "List your attention requests", "[--status open|snoozed|acknowledged] [--limit N] [--offset N]"],
  ["attention", "Acknowledge, snooze, or reopen an attention request", "<message-id> <acknowledge|snooze|reopen> [--minutes N]"],
  ["channel notify", "Request the owner's attention without waking bots", "<channel> --text TEXT --reason decision|blocker|update [--request-id UUID]"],
  [
    "channel schedule-update",
    "Edit a scheduled task",
    "<channel> <automation-id> [--name NAME] [--text TEXT] [--cron EXPR --timezone ZONE | --at ISO_TIME]",
  ],
  [
    "publish-file",
    "Attach a local file to your active bot response",
    "<absolute-path> [--alt TEXT]",
  ],
  [
    "channel automations",
    "List scheduled work in this channel",
    "<channel> [--limit N] [--offset N]",
  ],
  [
    "channel schedule",
    "Schedule a bot's work in this channel",
    "<channel> --name NAME --text TEXT [--bot BOT] (--cron EXPR --timezone ZONE | --at ISO_TIME) [--request-id UUID] [--paused]",
  ],
  [
    "channel automation",
    "Manage scheduled channel work",
    "<channel> <automation-id> <pause|resume|run|delete> [--request-id UUID] [--yes]",
  ],
  [
    "automation-dispatch",
    "Internal entry point for the automation runner",
    "--project ID --automation ID --run ID",
  ],
  [
    "channel behavior",
    "Read or set who responds; also remembers the default for new channels",
    "<channel> [smart|directed|everyone]",
  ],
  [
    "channel permissions",
    "Read or set what every bot in a channel may do",
    "<channel> [each|accept-edits|auto|full]",
  ],
  [
    "channel retry-routing",
    "Retry choosing bots for a message",
    "<channel> <request-id>",
  ],
  [
    "publish-image",
    "Embed a local image in your active bot response",
    "<absolute-path> [--alt TEXT]",
  ],
  [
    "list",
    "List bots and channels",
    "[--archived | --all] [--limit N] [--offset N]",
  ],
  [
    "archive",
    "Archive a bot, stop its work and leave its channels; keep files and history",
    "<bot>",
  ],
  ["restore", "Restore an archived bot with its mission schedule off", "<bot>"],
  ["retry", "Retry one failed or stopped channel response", "<job-id>"],
  [
    "channel search",
    "Search all channel history",
    "<channel> <query> [--before MESSAGE_ID] [--limit N]",
  ],
  [
    "create",
    "Create a persistent bot",
    "<name> (--mission TEXT | --mission-file PATH) [profile flags] [--channel CHANNEL]",
  ],
  ["show", "Show a bot's profile and workspace", "<bot>"],
  ["update", "Update selected profile fields", "<bot> [profile flags]"],
  [
    "mission",
    "Read or update MISSION.md",
    "<bot> [--text TEXT | --file PATH] [--version HASH]",
  ],
  [
    "memory",
    "Read or update MEMORY.md",
    "<bot> [--text TEXT | --file PATH] [--version HASH]",
  ],
  ["wake", "Request one step toward a bot's mission", "<bot>"],
  [
    "activity",
    "List work and response IDs",
    "[--bot BOT] [--channel CHANNEL] [--limit N] [--offset N]",
  ],
  ["job", "Show one work item, output, and BB thread ID", "<job-id>"],
  ["stop", "Stop one response", "<job-id>"],
  [
    "channel list",
    "List channels",
    "[--archived | --all] [--limit N] [--offset N]",
  ],
  [
    "channel create",
    "Create an empty or populated channel",
    "[name] [--bot BOT ...] [--behavior smart|directed|everyone] [--request-id UUID]",
  ],
  [
    "channel request",
    "Collect replies and status for one consultation",
    "<channel> <request-id> [--limit N] [--offset N]",
  ],
  ["channel show", "Show channel settings and membership", "<channel>"],
  ["channel rename", "Rename a channel", "<channel> <name>"],
  ["channel members", "List channel bots", "<channel>"],
  ["channel invite", "Invite one bot", "<channel> <bot>"],
  [
    "channel remove",
    "Remove one bot and cancel its unfinished channel work",
    "<channel> <bot>",
  ],
  ["channel archive", "Archive a channel and preserve history", "<channel>"],
  [
    "channel delete",
    "Permanently delete a channel and its history",
    "<channel> --yes",
  ],
  ["channel restore", "Restore an archived channel", "<channel>"],
  ["channel pin", "Pin a channel in the sidebar", "<channel>"],
  ["channel unpin", "Unpin a channel", "<channel>"],
  ["channel read", "Mark current channel messages as read", "<channel>"],
  [
    "channel messages",
    "Read messages and reactions, newest page first",
    "<channel> [--limit N] [--offset N]",
  ],
  [
    "channel send",
    "Send a message or reply; mentions invite bots",
    "<channel> [--text TEXT | --file PATH] [--mode auto|steer|followup|fork] [--attach PATH ...] [--attachment ID ...] [--reply-to ID] [--request-id UUID]",
  ],
  [
    "channel react",
    "Add or remove your emoji reaction",
    "<channel> <message-id> <emoji> [--remove]",
  ],
  [
    "channel attach",
    "Upload a draft attachment",
    "<channel> <path> [--mime-type TYPE]",
  ],
  [
    "channel discard",
    "Discard an unsent attachment",
    "<channel> <attachment-id>",
  ],
  [
    "channel download",
    "Download a sent or draft attachment",
    "<channel> <attachment-id> --out PATH [--force]",
  ],
  [
    "transcribe",
    "Transcribe an audio file using BB's configured service",
    "<path> [--mime-type TYPE] [--prompt TEXT]",
  ],
].map(([name, summary, usage]) => ({
  name: name!,
  summary: summary!,
  usage: `bb bots ${name} ${usage} [--json]`,
}));

const help = (prefix = "") =>
  [
    ...commands
      .filter(
        (c) => !prefix || c.name === prefix || c.name.startsWith(`${prefix} `),
      )
      .map((c) => `${c.usage}\n  ${c.summary}`),
    "",
    "Bots accept an ID, @handle, or unique name. Channels accept an ID or name.",
    "Profile flags: --name --description --avatar --provider --model --reasoning --permissions --interval (minutes, 0 disables schedule).",
    "File flags: --machine HOST_ID selects the file's machine (use an absolute path). Otherwise the invoking thread determines the machine.",
    "--json returns structured output. Document reads include a version; pass --version when saving an edited copy.",
    "Messages and activity default to 20 entries (max 50); --offset continues older pages. List commands default to 50 (max 100).",
  ].join("\n");
class UsageError extends Error {}

function argumentsFor(
  argv: string[],
  strings: string[] = [],
  booleans: string[] = [],
  multiple: string[] = [],
) {
  const options: ParseArgsOptionsConfig = { json: { type: "boolean" } };
  for (const key of strings) options[key] = { type: "string" };
  for (const key of booleans) options[key] = { type: "boolean" };
  for (const key of multiple) options[key] = { type: "string", multiple: true };
  try {
    const parsed = parseArgs({
      args: argv,
      options,
      allowPositionals: true,
      strict: true,
    });
    return {
      positional(min: number, max = min) {
        if (parsed.positionals.length < min || parsed.positionals.length > max)
          throw new UsageError(
            `Expected ${min === max ? min : `${min}–${max}`} positional arguments. See --help.`,
          );
        return parsed.positionals;
      },
      has: (key: string) => parsed.values[key] !== undefined,
      text: (key: string) => parsed.values[key] as string | undefined,
      flag: (key: string) => parsed.values[key] === true,
      many: (key: string) => (parsed.values[key] ?? []) as string[],
      required(key: string) {
        const value = parsed.values[key];
        if (typeof value !== "string")
          throw new UsageError(`Missing --${key}.`);
        return value;
      },
      page(max = 50, fallback = 20) {
        const limit = Number(parsed.values.limit ?? fallback),
          offset = Number(parsed.values.offset ?? 0);
        if (
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > max ||
          !Number.isSafeInteger(offset) ||
          offset < 0
        )
          throw new UsageError(
            `Use --limit 1–${max} and a nonnegative --offset.`,
          );
        return { limit, offset };
      },
    };
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
}
type Args = ReturnType<typeof argumentsFor>;
function profile(args: Args): Partial<ProfileInput> {
  const values: Record<string, unknown> = {};
  for (const [flag, key] of Object.entries({
    name: "name",
    description: "description",
    avatar: "avatar",
    provider: "providerId",
    model: "model",
    reasoning: "reasoningLevel",
    permissions: "permissionMode",
    interval: "intervalMinutes",
  }))
    if (args.has(flag))
      values[key] =
        flag === "interval" ? Number(args.text(flag)) : args.text(flag);
  return values;
}

export function registerCli(
  bb: BbPluginApi,
  store: Store,
  handlers: PluginRpcHandlers<typeof rpcContract>,
  sendMessage: SendMessage,
  publishImage: (
    threadId: string,
    path: string,
    alt?: string,
  ) => Promise<unknown>,
  automations?: ChannelAutomations,
  publishFile?: typeof publishImage,
  approveCreate?: (
    input: z.output<typeof rpcContract.create.input>,
    threadId: string,
    signal?: AbortSignal,
  ) => Promise<BotCreateApproval>,
) {
  // Both entry points execute exactly the same validated operations.
  async function call<K extends Method>(
    method: K,
    input: unknown,
  ): Promise<Output<K>> {
    const parsed = rpcContract[method].input.parse(input);
    const value = await handlers[method](parsed as never);
    return rpcContract[method].output.parse(value) as Output<K>;
  }
  function bot(selector: string) {
    const all = store.all();
    const exact = all.find(
      (b) =>
        b.id === selector ||
        `@${b.handle}`.toLowerCase() === selector.toLowerCase(),
    );
    if (exact) return exact;
    const matches = all.filter(
      (b) =>
        b.handle.toLowerCase() === selector.toLowerCase() ||
        b.name.toLowerCase() === selector.toLowerCase(),
    );
    if (matches.length !== 1)
      throw new UsageError(
        matches.length
          ? "Bot name is ambiguous; use its ID or @handle."
          : `Bot not found: ${selector}`,
      );
    return matches[0]!;
  }
  function channel(selector: string, threadId?: string) {
    const rooms = store.rooms();
    const room =
      rooms.find((r) => r.id === selector) ??
      rooms.find((r) => r.name.toLowerCase() === selector.toLowerCase());
    if (!room) throw new UsageError(`Channel not found: ${selector}`);
    if (threadId) authorizeChannel(store, threadId, room.id);
    return room;
  }
  async function fileLocation(path: string, args: Args, ctx: PluginCliContext) {
    let hostId = args.text("machine");
    const paths =
      /^[A-Za-z]:[\\/]|^\\\\/.test(path) ||
      /^[A-Za-z]:[\\/]|^\\\\/.test(ctx.cwd ?? "")
        ? win32
        : posix;
    if (hostId && !paths.isAbsolute(path))
      throw new UsageError("Use an absolute file path with --machine.");
    if (!hostId && ctx.threadId) {
      const thread = await bb.sdk.threads.get({ threadId: ctx.threadId });
      if (thread.environmentId)
        hostId = (
          await bb.sdk.environments.get({ environmentId: thread.environmentId })
        ).hostId;
    }
    if (!hostId)
      throw new UsageError(
        "File access needs an invoking BB thread or --machine HOST_ID and an absolute path.",
      );
    if (!paths.isAbsolute(path) && !ctx.cwd)
      throw new UsageError(
        "Use an absolute file path when the working directory is unavailable.",
      );
    return {
      hostId,
      path: paths.isAbsolute(path) ? path : paths.resolve(ctx.cwd!, path),
    };
  }
  async function read(
    path: string,
    args: Args,
    ctx: PluginCliContext,
    maxBytes = 8 * 1024 * 1024,
  ) {
    const result = await bb.sdk.files.read({
      ...(await fileLocation(path, args, ctx)),
      signal: ctx.signal,
    });
    const bytes = Buffer.from(result.content, result.contentEncoding);
    if (result.sizeBytes !== bytes.length || bytes.length > maxBytes)
      throw new UsageError(
        `File must fit within ${maxBytes} bytes and be read in full.`,
      );
    return {
      bytes,
      mimeType:
        args.text("mime-type") ?? result.mimeType ?? "application/octet-stream",
      name: (path.includes("\\") ? win32 : posix).basename(path),
    };
  }
  async function textInput(
    args: Args,
    ctx: PluginCliContext,
    key = "text",
    fileKey = "file",
    required = false,
  ) {
    if (args.has(key) && args.has(fileKey))
      throw new UsageError(`Choose --${key} or --${fileKey}, not both.`);
    if (args.has(fileKey))
      return new TextDecoder("utf-8", { fatal: true }).decode(
        (await read(args.required(fileKey), args, ctx, 256_000)).bytes,
      );
    if (required && !args.has(key))
      throw new UsageError(`Provide --${key} or --${fileKey}.`);
    return args.text(key);
  }
  async function attach(
    id: string,
    path: string,
    args: Args,
    ctx: PluginCliContext,
  ) {
    const { bytes, ...meta } = await read(path, args, ctx);
    return call("upload", { id, ...meta, data: bytes.toString("base64") });
  }
  bb.cli.register({
    name: "bots",
    summary: "Create and manage bots, channels, messages, files, and activity",
    commands: commands.map((c) => ({
      ...c,
      name: c.name.replaceAll(" ", "-"),
    })),
    async run(argv, ctx) {
      if (argv[0]?.startsWith("channel-"))
        argv = ["channel", argv[0].slice(8), ...argv.slice(1)];
      const json = argv.includes("--json") || argv.includes("--json=true");
      const emit = (data: unknown, human?: string) => {
        const stdout =
          json || human === undefined
            ? JSON.stringify(data, null, json ? undefined : 2)
            : human;
        if (Buffer.byteLength(stdout) > PLUGIN_CLI_OUTPUT_MAX_BYTES - 1024)
          throw new UsageError(
            "Output is too large. Reduce --limit, use --offset, or inspect one job at a time.",
          );
        return { exitCode: 0, stdout };
      };
      const [first, second] = argv;
      const command =
        first === "channel" ? `channel ${second ?? ""}`.trim() : first;
      const rest = argv.slice(first === "channel" ? 2 : 1);
      if (
        !first ||
        first === "help" ||
        first === "--help" ||
        first === "-h" ||
        (first === "channel" && !second)
      )
        return {
          exitCode: 0,
          stdout: help(first === "channel" ? "channel" : ""),
        };
      if (argv.includes("--help") || argv.includes("-h")) {
        const prefix = commands.some((c) => c.name === command)
          ? command!
          : first === "channel" && second === "--help"
            ? "channel"
            : "";
        return { exitCode: 0, stdout: help(prefix) };
      }
      try {
        ctx.signal?.throwIfAborted();
        if (command === "automation-dispatch") {
          const a = argumentsFor(rest, ["project", "automation", "run"]);
          a.positional(0);
          if (!automations)
            throw new UsageError("Channel automations are unavailable.");
          return emit(
            await automations.dispatch(
              a.required("project"),
              a.required("automation"),
              a.required("run"),
              ctx.threadId,
              ctx.signal,
            ),
          );
        }
        const caller = ctx.threadId
          ? agentAuthor(store, ctx.threadId)
          : undefined;
        function ownBot(selector: string) {
          const value = bot(selector);
          if (caller?.botId && caller.botId !== value.id)
            throw new UsageError(
              "A bot can only administer its own profile, mission, and memory.",
            );
          return value;
        }
        function ownJob(id: string) {
          const job = store.job(id);
          if (!job || (caller?.botId && caller.botId !== job.botId))
            throw new UsageError("Work item is not available to this caller.");
          return job;
        }
        function requireChannelOwner() {
          if (caller?.botId)
            throw new UsageError(
              "Only the channel owner can rename, change membership, archive, restore, or delete a channel.",
            );
        }
        if (command === "inbox" || command === "attention") {
          if (caller?.botId) throw new UsageError("Only the owner can manage attention requests.");
          if (command === "inbox") {
            const a = argumentsFor(rest, ["status", "limit", "offset"]);
            a.positional(0);
            return emit(await call("attentionList", { status: a.text("status") ?? "open", ...a.page() }));
          }
          const a = argumentsFor(rest, ["minutes"]);
          const [id, action] = a.positional(2);
          return emit(await call("attentionUpdate", { id, action, ...(a.has("minutes") ? { minutes: Number(a.text("minutes")) } : {}) }));
        }
        if (command === "channel notify") {
          if (!ctx.threadId) throw new UsageError("Run notify from an agent or bot thread.");
          const a = argumentsFor(rest, ["text", "reason", "request-id"]);
          const [selector] = a.positional(1);
          const result = notifyOwner(store, notifyInput.parse({ channelId: channel(selector!, ctx.threadId).id,
            requestId: a.text("request-id") ?? randomUUID(), reason: a.required("reason"), text: a.required("text") }), ctx.threadId);
          bb.realtime.publish("changed", {});
          return emit(result);
        }
        if (
          [
            "channel automations",
            "channel schedule",
            "channel schedule-update",
            "channel automation",
          ].includes(command!)
        ) {
          if (!automations)
            throw new UsageError("Channel automations are unavailable.");
          if (command === "channel automations") {
            const a = argumentsFor(rest, ["limit", "offset"]);
            const [selector] = a.positional(1);
            return emit(
              await automations.list(
                channelAutomationList.parse({
                  channelId: channel(selector!, ctx.threadId).id,
                  ...(a.has("limit") ? { limit: Number(a.text("limit")) } : {}),
                  ...(a.has("offset")
                    ? { offset: Number(a.text("offset")) }
                    : {}),
                }),
                ctx.threadId,
              ),
            );
          }
          if (command === "channel schedule-update") {
            const a = argumentsFor(rest, [
              "name",
              "text",
              "cron",
              "timezone",
              "at",
            ]);
            const [selector, automationId] = a.positional(2);
            if (a.has("at") && (a.has("cron") || a.has("timezone")))
              throw new UsageError(
                "Choose a recurring schedule or a one-time date.",
              );
            const at = a.text("at");
            if (at && !/(Z|[+-]\d{2}:\d{2})$/i.test(at))
              throw new UsageError(
                "--at needs an ISO timestamp with a UTC offset.",
              );
            return emit(
              await automations.update(
                channelAutomationUpdate.parse({
                  channelId: channel(selector!, ctx.threadId).id,
                  automationId,
                  ...(a.has("name") ? { name: a.required("name") } : {}),
                  ...(a.has("text") ? { prompt: a.required("text") } : {}),
                  ...(at
                    ? {
                        trigger: { triggerType: "once", runAt: Date.parse(at) },
                      }
                    : a.has("cron") || a.has("timezone")
                      ? {
                          trigger: {
                            triggerType: "schedule",
                            cron: a.required("cron"),
                            timezone: a.required("timezone"),
                          },
                        }
                      : {}),
                }),
                ctx.threadId,
              ),
            );
          }
          if (command === "channel schedule") {
            const a = argumentsFor(
              rest,
              [
                "name",
                "text",
                "file",
                "machine",
                "bot",
                "cron",
                "timezone",
                "at",
                "request-id",
              ],
              ["paused"],
            );
            const [selector] = a.positional(1);
            if (
              a.has("at") === a.has("cron") ||
              (a.has("at") && a.has("timezone"))
            )
              throw new UsageError(
                "Choose --cron with --timezone, or --at with an ISO timestamp and UTC offset.",
              );
            const at = a.text("at");
            if (at && !/(Z|[+-]\d{2}:\d{2})$/i.test(at))
              throw new UsageError(
                "--at needs an ISO timestamp with a UTC offset.",
              );
            return emit(
              await automations.create(
                channelAutomationCreate.parse({
                  channelId: channel(selector!, ctx.threadId).id,
                  ...(a.has("bot") ? { botId: bot(a.required("bot")).id } : {}),
                  name: a.required("name"),
                  prompt: await textInput(a, ctx, "text", "file", true),
                  trigger: at
                    ? { triggerType: "once", runAt: Date.parse(at) }
                    : {
                        triggerType: "schedule",
                        cron: a.required("cron"),
                        timezone: a.required("timezone"),
                      },
                  requestId: a.text("request-id") ?? randomUUID(),
                  enabled: !a.has("paused"),
                }),
                ctx.threadId,
              ),
            );
          }
          const a = argumentsFor(rest, ["request-id"], ["yes"]);
          const [selector, automationId, action] = a.positional(3);
          if (action === "delete" && !a.has("yes"))
            throw new UsageError("Deleting an automation requires --yes.");
          return emit(
            await automations.action(
              channelAutomationAction.parse({
                channelId: channel(selector!, ctx.threadId).id,
                automationId,
                action,
                requestId:
                  a.text("request-id") ??
                  (action === "run" ? randomUUID() : undefined),
              }),
              ctx.threadId,
            ),
          );
        }
        if (command === "publish-image" || command === "publish-file") {
          const a = argumentsFor(rest, ["alt"]);
          const [path] = a.positional(1);
          if (!ctx.threadId)
            throw new UsageError(
              "Run this command from an active bot channel response.",
            );
          const publish =
            command === "publish-file" ? publishFile : publishImage;
          if (!publish) throw new UsageError("File publishing is unavailable.");
          return emit(await publish(ctx.threadId, path!, a.text("alt")));
        }
        if (command === "list" || command === "channel list") {
          const a = argumentsFor(
            rest,
            ["limit", "offset"],
            command === "channel list"
              ? ["archived", "all"]
              : ["archived", "retired", "all"],
          );
          a.positional(0);
          if ((a.flag("all") && (a.flag("archived") || a.flag("retired"))) ||
              (command === "list" && a.flag("archived") && a.flag("retired")))
            throw new UsageError(
              "Choose --all or one archive filter.",
            );
          const { limit, offset } = a.page(100, 50);
          const allRooms = store
            .rooms()
            .filter((r) => !caller?.botId || r.memberIds.includes(caller.botId))
            .filter(
              (r) =>
                command === "list" ||
                a.flag("all") ||
                !!r.archived === a.flag("archived"),
            );
          const filteredBots = store
            .all()
            .filter((b) => a.flag("all") || !!b.retired === (a.flag("archived") || a.flag("retired")));
          const rooms = allRooms.slice(offset, offset + limit),
            bots = filteredBots.slice(offset, offset + limit);
          const data =
            command === "list"
              ? {
                  bots,
                  rooms,
                  offset,
                  nextOffset:
                    Math.max(filteredBots.length, allRooms.length) >
                    offset + limit
                      ? offset + limit
                      : null,
                }
              : {
                  channels: rooms,
                  offset,
                  nextOffset:
                    allRooms.length > offset + limit ? offset + limit : null,
                };
          return emit(
            data,
            [
              ...(command === "list"
                ? bots.map(
                    (b) =>
                      `${b.id}  @${b.handle}  ${b.name}  ${b.retired ? "archived" : "ready"}`,
                  )
                : []),
              ...rooms.map(
                (r) =>
                  `${r.id}  ${r.name}  ${r.memberIds.length} bots${r.archived ? "  archived" : ""}`,
              ),
              ...(data.nextOffset !== null
                ? [`More: --offset ${data.nextOffset}`]
                : []),
            ].join("\n") || "No results.",
          );
        }
        if (command === "archive" || command === "retire" || command === "restore") {
          const a = argumentsFor(rest),
            [selector] = a.positional(1);
          return emit(
            await call("retire", {
              id: ownBot(selector!).id,
              retired: command !== "restore",
            }),
          );
        }
        if (command === "retry") {
          const a = argumentsFor(rest),
            [id] = a.positional(1);
          ownJob(id!);
          return emit(await call("retryJob", { id }));
        }
        if (command === "channel search") {
          const a = argumentsFor(rest, ["limit", "before"]),
            [selector, query] = a.positional(2);
          return emit(
            await call("history", {
              id: channel(selector!, ctx.threadId).id,
              query,
              before: a.text("before"),
              limit: a.page(100, 50).limit,
            }),
          );
        }
        if (command === "create" || command === "update") {
          const a = argumentsFor(rest, [
            ...profileFlags,
            ...(command === "create"
              ? ["mission", "mission-file", "machine", "channel"]
              : []),
          ]);
          const [selector] = a.positional(1);
          if (command === "update") {
            const patch = profile(a);
            if (!Object.keys(patch).length)
              throw new UsageError("Provide at least one profile flag.");
            return emit(
              await call("update", { id: ownBot(selector!).id, ...patch }),
            );
          }
          if (a.has("name"))
            throw new UsageError(
              "Pass the name as the positional argument when creating a bot.",
            );
          const input = rpcContract.create.input.parse({
            ...profile(a),
            name: selector,
            mission: await textInput(a, ctx, "mission", "mission-file", true),
            roomId: a.has("channel")
              ? channel(a.required("channel"), ctx.threadId).id
              : undefined,
          });
          if (caller?.botId) {
            if (!approveCreate || !ctx.threadId)
              throw new UsageError("Bot creation approval is unavailable.");
            const approval = await approveCreate(input, ctx.threadId, ctx.signal);
            if (!approval.approved)
              throw new UsageError("Bot creation was not approved.");
            if (ctx.signal?.aborted)
              throw new UsageError("Bot creation request was cancelled.");
            if (approval.bot) return emit(approval.bot);
            // The approval may have taken long enough for the invoking thread
            // to be stopped or deleted. Revalidate the author before creating.
            agentAuthor(store, ctx.threadId);
          }
          return emit(
            await call("create", input),
          );
        }
        if (command === "show" || command === "wake") {
          const a = argumentsFor(rest),
            [selector] = a.positional(1),
            b = ownBot(selector!);
          return emit(
            command === "show" ? b : await call("wake", { id: b.id }),
          );
        }
        if (command === "mission" || command === "memory") {
          const a = argumentsFor(rest, ["text", "file", "version", "machine"]),
            [selector] = a.positional(1);
          const id = ownBot(selector!).id,
            file = command === "mission" ? "MISSION.md" : "MEMORY.md";
          const text = await textInput(a, ctx);
          const current = await call("document", { id, file });
          if (text === undefined) {
            if (a.has("version"))
              throw new UsageError("--version applies to a document update.");
            return emit(current, current.text);
          }
          return emit(
            await call("saveDocument", {
              id,
              file,
              text,
              version: a.text("version") ?? current.version,
            }),
          );
        }
        if (command === "activity") {
          const a = argumentsFor(rest, ["bot", "channel", "limit", "offset"]);
          a.positional(0);
          const { limit, offset } = a.page();
          const jobs = store.activity(
            a.has("bot")
              ? ownBot(a.required("bot")).id
              : (caller?.botId ?? undefined),
            a.has("channel")
              ? channel(a.required("channel"), ctx.threadId).id
              : undefined,
            limit,
            offset,
          );
          return emit({
            jobs,
            offset,
            nextOffset: jobs.length === limit ? offset + limit : null,
          });
        }
        if (command === "job" || command === "stop") {
          const a = argumentsFor(rest),
            [id] = a.positional(1),
            job = ownJob(id!);
          if (!job) throw new UsageError("Work item not found.");
          return emit(
            command === "job" ? job : await call("cancelJob", { id }),
          );
        }
        if (command === "channel create") {
          const a = argumentsFor(rest, ["request-id", "behavior"], [], ["bot"]),
            [name] = a.positional(0, 1);
          return emit(
            await call("createRoom", {
              name,
              memberIds: creatorMembers(
                store,
                ctx.threadId,
                a.many("bot").map((s) => bot(s).id),
              ),
              requestId: a.text("request-id"),
              responseBehavior: a.text("behavior"),
            }),
          );
        }
        if (command === "channel behavior") {
          const a = argumentsFor(rest),
            [selector, behavior] = a.positional(1, 2),
            room = channel(selector!, ctx.threadId);
          return emit(
            behavior
              ? await call("channelState", {
                  id: room.id,
                  responseBehavior: behavior,
                  rememberDefault: !caller?.botId,
                })
              : { responseBehavior: room.responseBehavior ?? "everyone" },
          );
        }
        if (command === "channel permissions") {
          const a = argumentsFor(rest),
            [selector, mode] = a.positional(1, 2),
            room = channel(selector!, ctx.threadId);
          if (mode && caller?.botId)
            throw new UsageError("Only the owner can set channel permissions.");
          if (mode && !["each", "accept-edits", "auto", "full"].includes(mode))
            throw new UsageError(
              "Choose each, accept-edits, auto, or full.",
            );
          return emit(
            mode
              ? await call("channelState", {
                  id: room.id,
                  permissionMode: mode === "each" ? null : mode,
                })
              : { permissionMode: room.permissionMode ?? null },
          );
        }
        if (command === "channel retry-routing") {
          const a = argumentsFor(rest),
            [selector, requestId] = a.positional(2),
            room = channel(selector!, ctx.threadId);
          return emit(await call("retryRouting", { id: room.id, requestId }));
        }
        if (
          command === "channel rename" ||
          command === "channel invite" ||
          command === "channel remove"
        ) {
          const a = argumentsFor(rest),
            [selector, value] = a.positional(2),
            room = channel(selector!, ctx.threadId);
          requireChannelOwner();
          return emit(
            command === "channel rename"
              ? await call("updateRoom", { id: room.id, name: value })
              : await call("member", {
                  id: room.id,
                  botId: bot(value!).id,
                  present: command === "channel invite",
                }),
          );
        }
        if (
          [
            "channel show",
            "channel members",
            "channel archive",
            "channel restore",
            "channel pin",
            "channel unpin",
            "channel read",
          ].includes(command!)
        ) {
          const a = argumentsFor(rest),
            [selector] = a.positional(1),
            room = channel(selector!, ctx.threadId);
          if (command === "channel show") return emit(room);
          if (command === "channel members")
            return emit(room.memberIds.map((id) => store.get(id)));
          if (command === "channel archive" || command === "channel restore")
            requireChannelOwner();
          return emit(
            await call("channelState", {
              id: room.id,
              ...(command === "channel read"
                ? { lastReadAt: room.updatedAt }
                : command!.endsWith("pin")
                  ? { pinned: command === "channel pin" }
                  : { archived: command === "channel archive" }),
            }),
          );
        }
        if (command === "channel delete") {
          const a = argumentsFor(rest, [], ["yes"]),
            [selector] = a.positional(1),
            room = channel(selector!, ctx.threadId);
          requireChannelOwner();
          if (!a.flag("yes"))
            throw new UsageError(
              "Deleting a channel permanently removes its history. Pass --yes to confirm, or use channel archive to preserve it.",
            );
          return emit(await call("deleteRoom", { id: room.id }));
        }
        if (command === "channel request") {
          const a = argumentsFor(rest, ["limit", "offset"]),
            [selector, requestId] = a.positional(2);
          const { limit, offset } = a.page();
          return emit(
            requestStatus(
              store,
              channel(selector!, ctx.threadId).id,
              requestId!,
              limit,
              offset,
            ),
          );
        }
        if (command === "channel messages") {
          const a = argumentsFor(rest, ["limit", "offset"]),
            [selector] = a.positional(1),
            room = channel(selector!, ctx.threadId);
          const { limit, offset } = a.page(),
            messages = store.visibleMessages(room.id, limit, offset),
            ids = new Set(messages.map((m) => m.id));
          return emit({
            messages,
            reactions: store
              .reactions(room.id)
              .filter((r) => ids.has(r.messageId)),
            offset,
            nextOffset: messages.length === limit ? offset + limit : null,
          });
        }
        if (command === "channel send") {
          const a = argumentsFor(
            rest,
            [
              "text",
              "file",
              "machine",
              "reply-to",
              "request-id",
              "mime-type",
              "mode",
            ],
            [],
            ["attach", "attachment"],
          );
          const [selector] = a.positional(1),
            room = channel(selector!, ctx.threadId);
          const text = (await textInput(a, ctx)) ?? "",
            requestId = a.text("request-id") ?? randomUUID();
          z.string().uuid().parse(requestId);
          if (a.many("attach").length + a.many("attachment").length > 10)
            throw new UsageError("Attach at most 10 files.");
          if (text.length > 16000)
            throw new UsageError("Messages must fit within 16000 characters.");
          if (room.archived)
            throw new UsageError(
              "Restore this channel before sending a message.",
            );
          const attachmentIds = [...a.many("attachment")];
          for (const path of a.many("attach"))
            attachmentIds.push((await attach(room.id, path, a, ctx)).id);
          try {
            return emit(
              await sendMessage(
                rpcContract.send.input.parse({
                  id: room.id,
                  text,
                  requestId,
                  attachmentIds,
                  replyTo: a.text("reply-to"),
                  sendMode: a.text("mode"),
                }),
                ctx.threadId,
              ),
            );
          } catch (e) {
            throw new Error(
              `${(e as Error).message}\nRequest ID: ${requestId}. Reuse --request-id with identical content to retry safely.`,
            );
          }
        }
        if (command === "channel react") {
          const a = argumentsFor(rest, [], ["remove"]),
            [selector, messageId, emoji] = a.positional(3),
            id = channel(selector!, ctx.threadId).id;
          const input = rpcContract.reaction.input.parse({
            id,
            messageId,
            emoji,
            active: !a.flag("remove"),
          });
          if (ctx.threadId) {
            channelReaction(store, ctx.threadId, input);
            bb.realtime.publish("changed", {});
          } else await call("reaction", input);
          return emit({ messageId, emoji, active: !a.flag("remove") });
        }
        if (command === "channel attach") {
          const a = argumentsFor(rest, ["machine", "mime-type"]),
            [selector, path] = a.positional(2);
          const room = channel(selector!, ctx.threadId);
          if (room.archived)
            throw new UsageError(
              "Restore this channel before attaching a file.",
            );
          return emit(await attach(room.id, path!, a, ctx));
        }
        if (command === "channel discard" || command === "channel download") {
          const a = argumentsFor(
            rest,
            command === "channel download" ? ["out", "machine"] : [],
            command === "channel download" ? ["force"] : [],
          );
          const [selector, attachmentId] = a.positional(2),
            id = channel(selector!, ctx.threadId).id;
          if (command === "channel discard")
            return emit(await call("discardAttachment", { id, attachmentId }));
          const attachment = store.attachment(attachmentId!);
          if (attachment.roomId !== id)
            throw new UsageError("Attachment belongs to another channel.");
          const destination = await fileLocation(a.required("out"), a, ctx);
          const bytes =
            store.stagedAttachment(attachment.id) ??
            (
              await bb.sdk.projects.attachments.read({
                projectId: attachment.projectId,
                path: attachment.path,
              })
            ).bytes;
          const saved = await bb.sdk.files.write({
            ...destination,
            content: Buffer.from(bytes).toString("base64"),
            contentEncoding: "base64",
            createParents: true,
            expectedSha256: a.flag("force") ? undefined : null,
          });
          if (saved.outcome === "conflict")
            throw new UsageError(
              "Destination already exists. Choose another path or pass --force.",
            );
          return emit({ ...destination, ...saved });
        }
        if (command === "transcribe") {
          const a = argumentsFor(rest, ["machine", "mime-type", "prompt"]),
            [path] = a.positional(1);
          const file = await read(path!, a, ctx, 5 * 1024 * 1024);
          const result = await call("transcribe", {
            data: file.bytes.toString("base64"),
            mimeType: file.mimeType,
            prompt: a.text("prompt"),
          });
          return emit(result, result.text);
        }
        throw new UsageError(
          `Unknown command: ${command}. Run bb bots --help.`,
        );
      } catch (e) {
        const message =
          e instanceof z.ZodError ? z.prettifyError(e) : (e as Error).message;
        return {
          exitCode: e instanceof UsageError || e instanceof z.ZodError ? 2 : 1,
          stderr: json ? JSON.stringify({ error: message }) : message,
        };
      }
    },
  });
}
