// bb-plugin-ds4 — admin a local DwarfStar (antirez/ds4) inference server from
// BB: run/stop/restart ds4-server, tail its logs, watch health, write agent
// provider configs (pi / opencode / Codex CLI), and expose the local model to
// BB agents through native tools and a `bb ds4` CLI.

import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  Ds4Process,
  type Ds4LogLine,
  type ProcessState,
} from "./src/ds4-process";
import {
  clearProcessRecord,
  isProcessAlive,
  listeningPid,
  parseExistingDs4Pid,
  processMatchesCommand,
  processStartTime,
  processWorkingDirectory,
  PROVIDER_TURN_LEASE_RELEASE_RETENTION_MS,
  providerTurnLeaseIsActive,
  readProviderTurnLease,
  readProcessRecord,
  writeProcessRecord,
} from "./src/process-recovery";
import {
  DEFAULT_DWARFSTAR_CONTEXT_TOKENS,
  resolveConfig,
  detectDs4Dir,
  dwarfStarVisionBackendError,
  dwarfStarVisionExtraArgsError,
  agentCommand,
  dwarfStarVisionArgsError,
  isDwarfStarVisionProcessReady,
  resolvedDwarfStarModelId,
  shellQuote,
  validateDsparkModelPath,
  type BackendChoice,
  type ResolvedRunConfig,
  type RunSettings,
} from "./src/run-config";
import {
  allStatuses,
  applyTargets,
  statusFor,
  type AgentTargetId,
} from "./src/agent-configs";
import {
  appendPersistentLog,
  persistentLogPath,
} from "./src/persistent-log";
import {
  CONFIGURED_DWARFSTAR_MODEL_ID,
  isDwarfStarModel,
  parseIdleTimeoutMs,
} from "./src/model-selection";
import {
  buildDwarfStarChatRequest,
  completionRequestBodySizeError,
  completionPayloadSizeError,
  completeInputSchema,
  serializeDwarfStarChatRequest,
} from "./src/request-payload";

// ---------------------------------------------------------------------------
// Schemas / contract
// ---------------------------------------------------------------------------

const healthSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number().optional(),
  status: z.number().optional(),
  error: z.string().optional(),
  models: z.array(z.string()),
  at: z.number(),
});
const DS4_PROVIDER_BRIDGE_PROCESS_RECORD_ID = "ds4-provider-bridge";
const configSchema = z.object({
  ds4Dir: z.string().nullable(),
  bin: z.string().nullable(),
  args: z.array(z.string()),
  modelPath: z.string().nullable(),
  visionPath: z.string().nullable(),
  host: z.string(),
  port: z.number(),
  ctx: z.number(),
  maxTokens: z.number(),
  backend: z.string(),
  dspark: z.boolean(),
  dsparkSupportPath: z.string().nullable(),
  dsparkConfidence: z.number().nullable(),
  fingerprint: z.string(),
});
const statusSchema = z.object({
  state: z.enum(["stopped", "starting", "running", "stopping", "exited", "crashed"]),
  ownership: z.enum(["managed", "external"]),
  displayState: z.string(),
  pid: z.number().nullable(),
  startedAt: z.number().nullable(),
  uptimeMs: z.number(),
  exitInfo: z
    .object({ code: z.number().nullable(), signal: z.string().nullable(), at: z.number() })
    .nullable(),
  health: healthSchema.nullable(),
  activeEndpoint: z.object({ host: z.string(), port: z.number() }).nullable(),
  config: configSchema,
  settings: z.object({
    idleTimeoutSeconds: z.string(),
    restartOnCrash: z.boolean(),
    maxTokens: z.string(),
  }),
  lastError: z.string().nullable(),
  log: z.object({ total: z.number(), limit: z.number(), file: z.string() }),
});
const logsSchema = z.object({
  lines: z.array(
    z.object({
      seq: z.number(),
      ts: z.number(),
      stream: z.enum(["stdout", "stderr"]),
      text: z.string(),
    }),
  ),
  nextOffset: z.number(),
  total: z.number(),
  firstSeq: z.number(),
});
const agentTargetStatusSchema = z.object({
  id: z.string(),
  label: z.string(),
  path: z.string(),
  exists: z.boolean(),
  configured: z.boolean(),
  detail: z.string(),
  error: z.string().optional(),
});
const applyResultSchema = z.object({
  id: z.string(),
  ok: z.boolean(),
  path: z.string().optional(),
  backup: z.string().optional(),
  message: z.string(),
});

export const rpcContract = defineRpcContract({
  status: { input: z.null(), output: statusSchema },
  start: { input: z.null(), output: statusSchema },
  stop: { input: z.null(), output: statusSchema },
  restart: { input: z.null(), output: statusSchema },
  logs: {
    input: z
      .object({
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(5000).optional(),
      })
      .strict(),
    output: logsSchema,
  },
  clearLogs: { input: z.null(), output: z.object({ total: z.number() }) },
  agentConfigs: {
    input: z.null(),
    output: z.object({ targets: z.array(agentTargetStatusSchema) }),
  },
  applyAgentConfigs: {
    input: z
      .object({ targets: z.array(z.enum(["pi", "opencode", "codex"])) })
      .strict(),
    output: z.object({ results: z.array(applyResultSchema) }),
  },
  launchAgent: {
    input: z.null(),
    output: z.object({ terminalId: z.string(), title: z.string() }),
  },
  complete: {
    input: completeInputSchema,
    output: z.object({ text: z.string() }),
  },
});

export type StatusDto = z.infer<typeof statusSchema>;

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

const LOG_RING_LIMIT = 5000;
const ADOPTED_HEALTH_GRACE_MS = 120_000;

type ServerEndpoint = { host: string; port: number };

const DS4_PROVIDER_ID = "ds4";
const DS4_PROVIDER_TOOLS = ["read", "edit", "bash"] as const;
const MAX_DS4_READ_BYTES = 2 * 1024 * 1024;
const MAX_DS4_TOOL_RESULT_BYTES = 256 * 1024;
const MAX_DS4_EDIT_BYTES = 1024 * 1024;
const MAX_DS4_BASH_COMMAND_CHARS = 10_000;
const MAX_DS4_BASH_CWD_CHARS = 4096;
const DEFAULT_DS4_BASH_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_DS4_BASH_TIMEOUT_MS = 10 * 60 * 1000;
const DS4_BASH_POLL_MS = 100;

function dwarfStarModelDisplayName(modelId: string): string {
  switch (modelId) {
    case "deepseek-v4-flash": return "DeepSeek V4 Flash";
    case "deepseek-v4-pro": return "DeepSeek V4 Pro";
    case "glm-5.2": return "GLM 5.2";
    case "glm-5.3-flash": return "GLM 5.3 Flash";
    default: return "DwarfStar (configured model)";
  }
}

function dwarfStarProviderModel(modelId: string) {
  return {
    id: modelId,
    displayName: dwarfStarModelDisplayName(modelId),
    description: "The GGUF configured in DwarfStar settings.",
    supportedReasoningEfforts: [
      { reasoningEffort: "none" as const, description: "None" },
      { reasoningEffort: "low" as const, description: "Low" },
      { reasoningEffort: "medium" as const, description: "Medium" },
      { reasoningEffort: "high" as const, description: "High" },
      { reasoningEffort: "max" as const, description: "Maximum" },
    ],
    defaultReasoningEffort: modelId.startsWith("glm-") ? "high" as const : "none" as const,
    isDefault: true,
  };
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  const settings = bb.settings.define({
    ds4Dir: {
      type: "string",
      label: "DS4 checkout directory",
      description:
        "Directory containing ds4-server. Empty = auto-detect (DS4_DIR, ~/workingdir/ds4, ~/ds4, …).",
      default: "",
    },
    modelPath: {
      type: "string",
      label: "Model GGUF path",
      description: "Absolute path, or relative to the DS4 directory. Empty = ds4flash.gguf.",
      default: "",
    },
    visionPath: {
      type: "string",
      label: "GLM 5.3 vision encoder path",
      description:
        "Use auto to detect gguf/GLM-5.3-Flash-Vision-Encoder.gguf for a GLM 5.3 Flash model; set an absolute or DS4-relative path to override, or leave empty to disable vision.",
      default: "auto",
    },
    ctx: {
      type: "string",
      label: "Context tokens (-c)",
      description: "Server context window AND the client-side contextWindow written to agent configs. Defaults to 250000 for the 2-bit model on a 128 GB Apple Silicon host. Restarts the server on change.",
      default: String(DEFAULT_DWARFSTAR_CONTEXT_TOKENS),
    },
    idleTimeoutSeconds: {
      type: "string",
      label: "Stop after idle (seconds)",
      description:
        "After the last DS4 turn finishes, keep the model warm for this long before stopping the local server. Default: 300.",
      default: "300",
    },
    backend: {
      type: "select",
      label: "Backend",
      description: "metal/cuda/rocm/cpu; auto lets ds4-server pick.",
      options: ["auto", "metal", "cuda", "rocm", "cpu"],
      default: "auto",
    },
    host: { type: "string", label: "Bind host", default: "127.0.0.1" },
    port: { type: "string", label: "Port", default: "8000" },
    maxTokens: {
      type: "string",
      label: "Default max output tokens (-n)",
      description: "Default output limit for the server and the maxTokens/output limit written to agent configs.",
      default: "384000",
    },
    kvDiskDir: {
      type: "string",
      label: "KV disk cache dir",
      description: "Empty disables disk KV caching.",
      default: "/tmp/ds4-kv",
    },
    kvDiskSpaceMb: {
      type: "string",
      label: "KV disk budget (MB)",
      default: "8192",
    },
    power: {
      type: "string",
      label: "GPU duty cycle (--power, 1-100)",
      description: "Empty = default (100).",
      default: "",
    },
    extraArgs: {
      type: "string",
      label: "Extra ds4-server args",
      description: "Free-form flags appended to the command line.",
      default: "",
    },
    dspark: {
      type: "boolean",
      label: "Enable DSpark speculative decoding",
      description:
        "Off by default because DSpark is an opt-in Flash-only optimization. Enable it with the matching 0731 support GGUF.",
      default: false,
    },
    dsparkSupportPath: {
      type: "string",
      label: "DSpark support GGUF path",
      description:
        "Absolute or DS4-relative path. Empty auto-detects the 0731 support GGUF.",
      default: "",
    },
    dsparkConfidence: {
      type: "string",
      label: "DSpark confidence threshold",
      description:
        "0–1; empty uses DwarfStar's backend-specific default (Metal 0.6, CUDA/ROCm 0.7).",
      default: "",
    },
    restartOnCrash: {
      type: "boolean",
      label: "Restart automatically after a crash",
      default: true,
    },
  });

  const proc = new Ds4Process(LOG_RING_LIMIT);
  let lastHealth: z.infer<typeof healthSchema> | null = null;
  let lastError: string | null = null;
  type StoredSettings = Awaited<ReturnType<typeof settings.get>>;
  let latestSettings: StoredSettings = await settings.get();
  let inFlightCompletions = 0;
  let lastDemandAt: number | null = null;

  function primaryModelId(cfg: ResolvedRunConfig): string {
    return resolvedDwarfStarModelId(cfg.modelPath) ?? CONFIGURED_DWARFSTAR_MODEL_ID;
  }

  function advertisedIds(cfg: ResolvedRunConfig): string[] {
    return [primaryModelId(cfg)];
  }

  let startPromise: Promise<void> | null = null;
  let startPromiseEpoch: number | null = null;
  let activeStop: Promise<void> | null = null;
  let stopWaitPromise: Promise<void> | null = null;
  let resolveStopWait: (() => void) | null = null;
  let stopRequested = false;
  let disposed = false;
  let shuttingDown = false;
  let lifecycleEpoch = 0;
  let activeEndpoint: ServerEndpoint | null = null;
  let activeProcessStartedAt: string | null = null;
  let adoptedHealthFailureAt: number | null = null;
  let adoptedHealthTimedOut = false;
  let lastStartLogSeq = 0;

  const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });

  function toRunSettings(s: StoredSettings): RunSettings {
    latestSettings = s;
    return {
      ds4Dir: s.ds4Dir ?? "",
      modelPath: s.modelPath ?? "",
      visionPath: s.visionPath ?? "auto",
      backend: (s.backend ?? "auto") as BackendChoice,
      host: s.host ?? "127.0.0.1",
      port: s.port ?? "8000",
      ctx: s.ctx ?? String(DEFAULT_DWARFSTAR_CONTEXT_TOKENS),
      maxTokens: s.maxTokens ?? "384000",
      kvDiskDir: s.kvDiskDir ?? "",
      kvDiskSpaceMb: s.kvDiskSpaceMb ?? "8192",
      power: s.power ?? "",
      extraArgs: s.extraArgs ?? "",
      dspark: s.dspark ?? false,
      dsparkSupportPath: s.dsparkSupportPath ?? "",
      dsparkConfidence: s.dsparkConfidence ?? "",
      restartOnCrash: s.restartOnCrash ?? true,
    };
  }

  async function currentSettings(): Promise<RunSettings> {
    return toRunSettings(await settings.get());
  }

  function idleTimeoutMs(): number {
    return parseIdleTimeoutMs(latestSettings.idleTimeoutSeconds ?? "300");
  }

  function providerTurnLeaseSnapshot(): {
    active: boolean;
    releasedAt: number | null;
  } {
    const lease = readProviderTurnLease(bb.pluginId);
    if (!lease) {
      return { active: false, releasedAt: null };
    }
    const now = Date.now();
    const releasedAt =
      typeof lease.releasedAt === "number" &&
      lease.releasedAt <= now &&
      now - lease.releasedAt <= PROVIDER_TURN_LEASE_RELEASE_RETENTION_MS
        ? lease.releasedAt
        : null;
    if (!isProcessAlive(lease.pid)) {
      return { active: false, releasedAt };
    }
    const observedStart = processStartTime(lease.pid);
    return {
      active: providerTurnLeaseIsActive(lease, now, observedStart),
      releasedAt,
    };
  }

  function hasActiveProviderTurnLease(): boolean {
    return providerTurnLeaseSnapshot().active;
  }

  function hasCompletionDemand(): boolean {
    return inFlightCompletions > 0;
  }

  function hasStopVeto(): boolean {
    return hasCompletionDemand() || hasActiveProviderTurnLease();
  }

  async function currentConfig(): Promise<ResolvedRunConfig> {
    return resolveConfig(await currentSettings());
  }

  type WorkspaceToolContext = {
    threadId: string;
    signal: AbortSignal;
  };

  async function workspaceForTool(context: WorkspaceToolContext): Promise<{
    hostId: string;
    rootPath: string;
  }> {
    const thread = await bb.sdk.threads.get({ threadId: context.threadId, signal: context.signal });
    if (!thread.environmentId) {
      throw new Error("This thread has no workspace environment.");
    }
    const environment = await bb.sdk.environments.get({
      environmentId: thread.environmentId,
      signal: context.signal,
    });
    if (!environment.path) {
      throw new Error("The thread workspace has no local path.");
    }
    return { hostId: environment.hostId, rootPath: environment.path };
  }

  function resolveWorkspaceToolPath(rootPath: string, requestedPath: string, allowRoot = false): string {
    const candidate = resolve(rootPath, requestedPath);
    const child = relative(rootPath, candidate);
    const outside = child === ".." || child.startsWith("../") || isAbsolute(child);
    if ((!allowRoot && child.length === 0) || outside) {
      throw new Error("Path must stay inside the current workspace.");
    }
    return candidate;
  }

  function workspaceToolLabel(rootPath: string, targetPath: string): string {
    return relative(rootPath, targetPath) || ".";
  }

  function limitDs4ToolResult(value: string): string {
    if (Buffer.byteLength(value, "utf8") <= MAX_DS4_TOOL_RESULT_BYTES) return value;
    return `${Buffer.from(value, "utf8").subarray(0, MAX_DS4_TOOL_RESULT_BYTES).toString("utf8")}\n[tool output truncated]`;
  }

  async function readWorkspaceToolFile(
    context: WorkspaceToolContext,
    requestedPath: string,
  ): Promise<{
    hostId: string;
    rootPath: string;
    path: string;
    label: string;
    text: string;
    sha256: string;
  }> {
    const workspace = await workspaceForTool(context);
    const path = resolveWorkspaceToolPath(workspace.rootPath, requestedPath);
    const result = await bb.sdk.files.read({
      hostId: workspace.hostId,
      path,
      rootPath: workspace.rootPath,
      signal: context.signal,
    });
    if (result.sizeBytes > MAX_DS4_READ_BYTES) {
      throw new Error(`File is too large to read through the DS4 tool (${result.sizeBytes} bytes).`);
    }
    if (result.contentEncoding === "base64") {
      throw new Error("DS4 workspace tools only support UTF-8 text files.");
    }
    const text = result.content;
    if (Buffer.byteLength(text, "utf8") > MAX_DS4_READ_BYTES) {
      throw new Error("File is too large to read through the DS4 tool.");
    }
    return {
      ...workspace,
      path,
      label: workspaceToolLabel(workspace.rootPath, path),
      text,
      sha256: result.sha256,
    };
  }

  function hostShellQuote(value: string): string {
    return `'${value.replace(/'/gu, "'\\''")}'`;
  }

  async function waitForDs4BashPoll(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error("DwarfStar bash was cancelled.");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, DS4_BASH_POLL_MS);
      const onAbort = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        reject(new Error("DwarfStar bash was cancelled."));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      timer.unref?.();
    });
  }

  function appendDs4BashOutput(
    current: string,
    next: string,
  ): { value: string; truncated: boolean } {
    const bytes = Buffer.from(`${current}${next}`, "utf8");
    if (bytes.byteLength <= MAX_DS4_TOOL_RESULT_BYTES) {
      return { value: bytes.toString("utf8"), truncated: false };
    }
    return {
      value: bytes.subarray(-MAX_DS4_TOOL_RESULT_BYTES).toString("utf8"),
      truncated: true,
    };
  }

  async function executeDs4Bash(
    context: WorkspaceToolContext,
    command: string,
    requestedCwd: string | undefined,
    requestedTimeoutMs: number | undefined,
  ): Promise<string | { content: [{ type: "text"; text: string }]; isError: true }> {
    const workspace = await workspaceForTool(context);
    const cwd = requestedCwd
      ? isAbsolute(requestedCwd)
        ? resolve(requestedCwd)
        : resolve(workspace.rootPath, requestedCwd)
      : workspace.rootPath;
    const timeoutMs = Math.min(
      Math.max(requestedTimeoutMs ?? DEFAULT_DS4_BASH_TIMEOUT_MS, 1),
      MAX_DS4_BASH_TIMEOUT_MS,
    );
    const marker = `__BB_DS4_BASH_${randomUUID().replaceAll("-", "")}`;
    const wrappedCommand = [
      "__bb_ds4_status=0",
      `/bin/sh -c ${hostShellQuote(command)} || __bb_ds4_status=$?`,
      `printf '\\n${marker}:%s\\n' \"$__bb_ds4_status\"`,
      // Keep the PTY alive long enough for the bridge to read the marker. It
      // is force-closed in finally, while detached children remain exactly as
      // the user's shell command left them.
      "sleep 30",
    ].join("; ");
    const terminal = await bb.sdk.terminals.create({
      cols: 120,
      rows: 40,
      // This is intentionally host_path rather than a workspace-scoped
      // target: DwarfStar's bash tool is an unrestricted host shell.
      scope: { kind: "host_path", hostId: workspace.hostId, cwd },
      start: { mode: "command", command: wrappedCommand },
      title: "DwarfStar bash",
    });
    let nextSeq = 0;
    let output = "";
    let truncated = false;
    const deadline = Date.now() + timeoutMs;
    try {
      for (;;) {
        if (context.signal.aborted) throw new Error("DwarfStar bash was cancelled.");
        const status = await bb.sdk.terminals.get({
          terminalId: terminal.id,
          signal: context.signal,
        });
        if (status.status === "running") {
          const replay = await bb.sdk.terminals.output({
            terminalId: terminal.id,
            sinceSeq: nextSeq,
            tailBytes: MAX_DS4_TOOL_RESULT_BYTES,
            signal: context.signal,
          });
          nextSeq = replay.nextSeq;
          truncated ||= replay.truncated;
          for (const chunk of replay.chunks) {
            const appended = appendDs4BashOutput(
              output,
              Buffer.from(chunk.dataBase64, "base64").toString("utf8"),
            );
            output = appended.value;
            truncated ||= appended.truncated;
          }
          const markerStart = output.lastIndexOf(`${marker}:`);
          if (markerStart >= 0) {
            const statusStart = markerStart + marker.length + 1;
            const statusEnd = output.indexOf("\n", statusStart);
            if (statusEnd >= 0) {
              const exitCode = Number.parseInt(output.slice(statusStart, statusEnd), 10);
              if (Number.isInteger(exitCode)) {
                const commandOutput = output.slice(0, markerStart).replace(/^\n/u, "");
                const resultText = `${truncated ? "[output truncated]\n" : ""}${commandOutput || "(no output)"}\nexit code: ${exitCode}`;
                if (exitCode === 0) return resultText;
                return {
                  content: [{ type: "text", text: resultText }],
                  isError: true,
                };
              }
            }
          }
        } else if (status.status === "exited" || status.status === "disconnected") {
          throw new Error("DwarfStar bash terminal ended before reporting a result.");
        }
        if (Date.now() >= deadline) {
          throw new Error(`DwarfStar bash timed out after ${timeoutMs}ms.`);
        }
        await waitForDs4BashPoll(context.signal);
      }
    } finally {
      await bb.sdk.terminals.close({ terminalId: terminal.id, mode: "force" }).catch(() => undefined);
    }
  }

  function configuredProviderModel(): { id: string } {
    // Provider declarations are shared with remote workspace hosts. The
    // server worker must not publish a host-local GGUF path or a family
    // inferred from a symlink that may resolve differently on the target
    // host. The bridge resolves the real settings for turns on that host.
    return { id: CONFIGURED_DWARFSTAR_MODEL_ID };
  }

  function providerDeclaration(model = configuredProviderModel()) {
    return {
      id: DS4_PROVIDER_ID,
      displayName: "DwarfStar",
      icon: "./assets/icon.svg",
      strings: {
        signInHint: "DwarfStar runs locally on this host; configure the DS4 checkout and model in Settings.",
        expiredHint: "DwarfStar is local. Check the DS4 checkout, model path, and server logs.",
        installUrl: "https://github.com/antirez/ds4",
        planModeCopy: "DwarfStar plan mode",
        iconTint: { light: "#475569", dark: "#cbd5e1" },
      },
      maintenance: { health: true, usage: false, installation: false },
      capabilities: {
        supportsServiceTier: false,
        supportsNativeUserQuestion: false,
        fork: "none" as const,
        supportsManualCompaction: false,
        supportsThreadArchive: false,
        supportsThreadRename: false,
        // The bridge does not have an approval interaction channel. Claim only
        // the mode whose policy it can actually enforce.
        permissionModes: ["full" as const],
        reasoningLevels: ["none", "low", "medium", "high", "max"] as const,
      },
      reasoningLevels: [
        { id: "none", label: "None" },
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium" },
        { id: "high", label: "High" },
        { id: "max", label: "Maximum" },
      ],
      models: {
        scope: "workspace" as const,
        // DwarfStar loads one GGUF per process. The provider model is the
        // modelPath setting; changing the picker must not silently switch the
        // server to another downloaded file.
        fallback: [dwarfStarProviderModel(model.id)],
      },
      composerActions: ["plan" as const],
      experimental_bridgeOptions: {
        configuredModelId: model.id,
      },
      experimental_visibility: "always" as const,
      deriveProviderOptions(context: { settings: Readonly<Record<string, unknown>> }) {
        const s = context.settings;
        return {
          ds4Dir: String(s.ds4Dir ?? ""),
          modelPath: String(s.modelPath ?? ""),
          visionPath: String(s.visionPath ?? "auto"),
          backend: String(s.backend ?? "auto"),
          host: String(s.host ?? "127.0.0.1"),
          port: String(s.port ?? "8000"),
          ctx: String(s.ctx ?? DEFAULT_DWARFSTAR_CONTEXT_TOKENS),
          maxTokens: String(s.maxTokens ?? "384000"),
          kvDiskDir: String(s.kvDiskDir ?? "/tmp/ds4-kv"),
          kvDiskSpaceMb: String(s.kvDiskSpaceMb ?? "8192"),
          power: String(s.power ?? ""),
          extraArgs: String(s.extraArgs ?? ""),
          dspark: s.dspark === true,
          dsparkSupportPath: String(s.dsparkSupportPath ?? ""),
          dsparkConfidence: String(s.dsparkConfidence ?? ""),
          idleTimeoutSeconds: String(s.idleTimeoutSeconds ?? "300"),
        };
      },
    };
  }

  let providerRegistration = bb.providers.register(providerDeclaration());

  function formatWorkspaceFileRange(
    text: string,
    startLine: number | undefined,
    endLine: number | undefined,
  ): { value: string; start: number; end: number; total: number } {
    const lines = text.split(/\r?\n/u);
    const start = startLine ?? 1;
    const end = endLine ?? lines.length;
    if (end < start) throw new Error("endLine must be greater than or equal to startLine.");
    if (end - start > 2000) throw new Error("Read at most 2000 lines per tool call.");
    return {
      value: lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join("\n"),
      start,
      end: Math.min(end, lines.length),
      total: lines.length,
    };
  }

  function endpointFromArgs(args: string[], fallback: ServerEndpoint): ServerEndpoint {
    const hostIndex = args.indexOf("--host");
    const portIndex = args.indexOf("--port");
    const host = hostIndex >= 0 && args[hostIndex + 1] ? args[hostIndex + 1] : fallback.host;
    const parsedPort = portIndex >= 0 ? Number(args[portIndex + 1]) : Number.NaN;
    return {
      host,
      port: Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : fallback.port,
    };
  }

  function dsparkConfigError(cfg: ResolvedRunConfig): string | null {
    if (!cfg.dspark) return null;
    const modelError = validateDsparkModelPath(cfg.modelPath);
    if (modelError) return modelError;
    if (!cfg.dsparkSupportPath) {
      return "DSpark is enabled but its support GGUF path could not be resolved. Set dsparkSupportPath or disable dspark.";
    }
    if (!existsSync(cfg.dsparkSupportPath)) {
      return `DSpark support GGUF not found: ${cfg.dsparkSupportPath}. Run ./download_model.sh ds4f-dspark or set dsparkSupportPath; disable dspark for GLM/PRO or a baseline run.`;
    }
    return null;
  }

  function visionConfigError(cfg: ResolvedRunConfig): string | null {
    const extraArgsError = dwarfStarVisionExtraArgsError(cfg.extraArgs, cfg.visionPath);
    if (extraArgsError) return extraArgsError;
    const argsError = dwarfStarVisionArgsError(cfg.args, cfg.visionPath);
    if (argsError) return argsError;
    if (!cfg.visionPath) return null;
    const backendError = dwarfStarVisionBackendError(cfg.backend, cfg.visionPath);
    if (backendError) return backendError;
    if (resolvedDwarfStarModelId(cfg.modelPath) !== "glm-5.3-flash") {
      return `Vision is supported only with a GLM 5.3 Flash model. The configured model path is ${cfg.modelPath ?? "not set"}; disable vision or select a GLM-5.3-Flash GGUF.`;
    }
    if (!existsSync(cfg.visionPath)) {
      return `GLM 5.3 vision encoder not found: ${cfg.visionPath}. Run ./download_model.sh glm53-vision or set visionPath to the downloaded encoder.`;
    }
    return null;
  }

  function visionEnabled(cfg: ResolvedRunConfig): boolean {
    if (!cfg.visionPath || visionConfigError(cfg)) return false;
    return isDwarfStarVisionProcessReady(
      proc.isExternal,
      proc.cmdline,
      cfg.visionPath,
      proc.cwd,
    );
  }

  function deriveDisplay(state: ProcessState, cfg: ResolvedRunConfig): string {
    switch (state) {
      case "stopped":
        return "stopped";
      case "starting":
        return "starting";
      case "stopping":
        return "stopping";
      case "exited":
        return "exited";
      case "crashed":
        return "crashed";
      case "running":
        if (healthIsReady(lastHealth)) return "ready";
        return adoptedHealthTimedOut || lastError ? "unavailable" : "loading model…";
    }
  }

  async function buildStatus(): Promise<StatusDto> {
    const cfg = await currentConfig();
    const s = await currentSettings();
    return {
      state: proc.state,
      ownership: proc.ownership,
      displayState: deriveDisplay(proc.state, cfg),
      pid: proc.pid,
      startedAt: proc.startedAt,
      uptimeMs: proc.startedAt ? Date.now() - proc.startedAt : 0,
      exitInfo: proc.exitInfo,
      health: lastHealth,
      activeEndpoint,
      config: cfg,
      settings: {
        idleTimeoutSeconds: latestSettings.idleTimeoutSeconds ?? "300",
        restartOnCrash: s.restartOnCrash,
        maxTokens: s.maxTokens,
      },
      lastError,
      log: { total: proc.logs(0, 1).total, limit: LOG_RING_LIMIT, file: persistentLogPath(bb.pluginId) },
    };
  }

  async function publishState(): Promise<void> {
    try {
      bb.realtime.publish("state", await buildStatus());
    } catch {
      // best-effort
    }
  }

  async function requestHealth(
    cfg: ResolvedRunConfig,
    endpointOverride?: ServerEndpoint,
  ): Promise<z.infer<typeof healthSchema>> {
    const endpoint = endpointOverride ?? (proc.isAdopted && activeEndpoint
      ? activeEndpoint
      : { host: cfg.host, port: cfg.port });
    const url = `http://${endpoint.host}:${endpoint.port}/v1/models`;
    try {
      const t0 = Date.now();
      const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
      if (res.ok) {
        const body = (await res.json()) as { data?: { id: string }[] };
        return {
          ok: true,
          latencyMs: Date.now() - t0,
          models: body.data?.map((m) => m.id) ?? [],
          at: Date.now(),
        };
      }
      return { ok: false, status: res.status, models: [], at: Date.now() };
    } catch (err) {
      return { ok: false, error: String(err), models: [], at: Date.now() };
    }
  }

  async function pollHealth(cfg: ResolvedRunConfig): Promise<z.infer<typeof healthSchema> | null> {
    if (!proc.isRunning) return null;
    return requestHealth(cfg);
  }

  function looksLikeDs4(health: z.infer<typeof healthSchema>): boolean {
    return health.ok && health.models.some(isDwarfStarModel);
  }

  function healthIsReady(health: z.infer<typeof healthSchema> | null): boolean {
    return health !== null && looksLikeDs4(health);
  }

  function recentCollisionPid(afterSeq = lastStartLogSeq): number | null {
    const lines = proc.logs(0, LOG_RING_LIMIT).lines;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (lines[i].seq < afterSeq) continue;
      const pid = parseExistingDs4Pid(lines[i].text);
      if (pid) return pid;
    }
    return null;
  }

  /**
   * Recover a compatible server left behind by a disconnected plugin worker,
   * including one that is still loading its model.
   * A matching process record is safe to reclaim. Without one, the server is
   * treated as external and is never stopped by idle supervision.
   */
  async function recoverExistingServer(
    cfg: ResolvedRunConfig,
    options: { allowExternal?: boolean; isCurrent?: () => boolean } = {},
  ): Promise<boolean> {
    const record = readProcessRecord(bb.pluginId);
    if (proc.isRunning) return false;
    if (!cfg.bin && !(record?.ownership === "external" && options.allowExternal !== false)) {
      return false;
    }
    const recordObservedStart = record ? processStartTime(record.pid) : null;
    const recordStartMatches = Boolean(
      record &&
        (!record.processStartedAt ||
          !recordObservedStart ||
          recordObservedStart === record.processStartedAt),
    );
    const recordIdentityMatches = Boolean(
      record &&
        recordStartMatches &&
        isProcessAlive(record.pid) &&
        processMatchesCommand(record.pid, record.bin, record.args, record.cwd),
    );
    const recordMatches = Boolean(
      recordIdentityMatches &&
        record?.fingerprint === cfg.fingerprint &&
        record.bin === cfg.bin &&
        processMatchesCommand(record.pid, cfg.bin, cfg.args, record.cwd ?? cfg.ds4Dir) &&
        (record.ownership !== "external" || options.allowExternal !== false),
    );
    const canUseRecordedExternal =
      recordIdentityMatches && record?.ownership === "external" && options.allowExternal !== false;
    const useRecorded = recordMatches || canUseRecordedExternal;
    let pid = useRecorded ? record?.pid ?? null : null;
    let ownership: "managed" | "external" =
      useRecorded && record?.ownership === "external" ? "external" : "managed";
    let commandBin = useRecorded ? record?.bin ?? cfg.bin : cfg.bin;
    let commandArgs = useRecorded ? record?.args ?? cfg.args : cfg.args;
    let endpoint: ServerEndpoint = useRecorded && record
      ? record.host && record.port
        ? { host: record.host, port: record.port }
        : endpointFromArgs(record.args, { host: cfg.host, port: cfg.port })
      : { host: cfg.host, port: cfg.port };

    if (!pid) {
      if (options.allowExternal === false || !cfg.bin) return false;
      ownership = "external";
      commandBin = cfg.bin;
      commandArgs = cfg.args;
      endpoint = { host: cfg.host, port: cfg.port };
      const candidates = [recentCollisionPid(), listeningPid(cfg.port)].filter(
        (candidate, index, all): candidate is number =>
          candidate !== null && all.indexOf(candidate) === index,
      );
      pid =
        candidates.find(
          (candidate) =>
            isProcessAlive(candidate) &&
            processMatchesCommand(candidate, commandBin!, commandArgs, cfg.ds4Dir),
        ) ?? null;
      if (!pid) {
        return false;
      }
    }

    const processStartedAt =
      (useRecorded ? record?.processStartedAt : undefined) ?? processStartTime(pid);
    const commandCwd = useRecorded
      ? record?.cwd ?? cfg.ds4Dir ?? homedir()
      : cfg.ds4Dir ?? homedir();
    const health = await requestHealth(cfg, endpoint);
    // An HTTP 200 with no models is a valid loading state for a recovered
    // server. Only reject a live candidate when it has reported a different
    // non-empty model namespace.
    if (
      !isProcessAlive(pid) ||
      (health.ok && health.models.length > 0 && !looksLikeDs4(health) && !useRecorded)
    ) {
      return false;
    }
    // Re-check identity after the health request so a recycled PID cannot be
    // adopted after the original process disappeared during the request.
    if (!processMatchesCommand(pid, commandBin!, commandArgs, commandCwd)) {
      return false;
    }
    const adoptedCwd = processWorkingDirectory(pid) ?? commandCwd;
    const observedStart = processStartTime(pid);
    if (processStartedAt && observedStart && processStartedAt !== observedStart) return false;
    if (options.isCurrent && !options.isCurrent()) return false;

    proc.adopt(pid, {
      ownership,
      cmdline: [commandBin!, ...commandArgs],
      cwd: adoptedCwd,
      startedAt: useRecorded ? record?.startedAt : undefined,
    });
    if (!proc.isAdopted || proc.pid !== pid) return false;
    activeProcessStartedAt = processStartedAt ?? observedStart;
    activeEndpoint = endpoint;
    adoptedHealthFailureAt = null;
    adoptedHealthTimedOut = false;
    lastHealth = health;
    lastError =
      ownership === "external" && useRecorded && record?.fingerprint !== cfg.fingerprint
        ? "An existing external ds4-server is using its previous settings. Run `bb ds4 stop` to apply the new settings."
        : null;
    writeProcessRecord(bb.pluginId, {
      pid,
      fingerprint: useRecorded ? record?.fingerprint ?? cfg.fingerprint : cfg.fingerprint,
      bin: commandBin!,
      args: commandArgs,
      cwd: adoptedCwd,
      startedAt: useRecorded ? record?.startedAt ?? Date.now() : Date.now(),
      host: endpoint.host,
      port: endpoint.port,
      ownership,
      processStartedAt: processStartedAt ?? observedStart ?? undefined,
    });
    if (ownership === "managed") {
      bb.log.info(`recovered ds4-server orphan (pid ${pid})`);
    } else {
      bb.log.warn(`using existing ds4-server (pid ${pid}); it is not owned by this plugin`);
    }
    const externalSettingsChanged =
      ownership === "external" &&
      useRecorded &&
      record?.fingerprint !== cfg.fingerprint;
    if (externalSettingsChanged) {
      bb.log.info("leaving agent configs unchanged for an external server using previous settings");
    }
    await publishState();
    return true;
  }

  /** Adopt a previously managed process when settings changed before reload. */
  function reclaimRecordedProcess(): boolean {
    if (proc.isRunning) return false;
    const record = readProcessRecord(bb.pluginId);
    if (!record) return false;
    if (record.ownership === "external") return false;
    if (!isProcessAlive(record.pid)) {
      clearProcessRecord(bb.pluginId, record.pid);
      return false;
    }
    const observedStart = processStartTime(record.pid);
    if (record.processStartedAt && observedStart && record.processStartedAt !== observedStart) {
      return false;
    }
    if (!processMatchesCommand(record.pid, record.bin, record.args, record.cwd)) return false;
    proc.adopt(record.pid, {
      ownership: "managed",
      cmdline: [record.bin, ...record.args],
      cwd: record.cwd,
      startedAt: record.startedAt,
    });
    activeProcessStartedAt = record.processStartedAt ?? processStartTime(record.pid);
    activeEndpoint = record.host && record.port
      ? { host: record.host, port: record.port }
      : endpointFromArgs(record.args, { host: "127.0.0.1", port: 8000 });
    adoptedHealthFailureAt = null;
    adoptedHealthTimedOut = false;
    return proc.isAdopted && proc.pid === record.pid;
  }

  /** Stop a bridge-owned server even when its settings fingerprint is stale. */
  async function stopBridgeProcessRecord(): Promise<boolean> {
    const record = readProcessRecord(DS4_PROVIDER_BRIDGE_PROCESS_RECORD_ID);
    if (!record || record.ownership === "external") return false;
    const pid = record.pid;
    if (!isProcessAlive(pid)) {
      clearProcessRecord(DS4_PROVIDER_BRIDGE_PROCESS_RECORD_ID, pid);
      return false;
    }
    const observedStart = processStartTime(pid);
    if (
      (record.processStartedAt && observedStart && observedStart !== record.processStartedAt) ||
      !processMatchesCommand(pid, record.bin, record.args, record.cwd)
    ) {
      bb.log.warn("the recorded DwarfStar provider process is no longer the expected process; not terminating it");
      return false;
    }
    const bridgeProc = new Ds4Process();
    bridgeProc.adopt(pid, {
      ownership: "managed",
      cmdline: [record.bin, ...record.args],
      cwd: record.cwd,
      startedAt: record.startedAt,
    });
    const verifyPid = (candidate: number): boolean => {
      if (!processMatchesCommand(candidate, record.bin, record.args, record.cwd)) return false;
      if (!record.processStartedAt) return true;
      const currentStart = processStartTime(candidate);
      return !currentStart || currentStart === record.processStartedAt;
    };
    await bridgeProc.stop(12_000, { verifyPid });
    if (isProcessAlive(pid)) {
      bb.log.warn("the recorded DwarfStar provider process changed while stopping; leaving it running");
      return false;
    }
    clearProcessRecord(DS4_PROVIDER_BRIDGE_PROCESS_RECORD_ID, pid);
    bb.log.info(`stopped bridge-owned ds4-server (pid ${pid})`);
    return true;
  }

  async function startProc(cfg: ResolvedRunConfig): Promise<void> {
    if (disposed) return;
    if (proc.isRunning) return;
    if (!cfg.bin || !existsSync(cfg.bin)) {
      lastError =
        "ds4-server binary not found. Set the DS4 checkout directory in Settings (or put ds4 on PATH).";
      bb.log.error(lastError);
      await publishState();
      return;
    }
    if (cfg.modelPath && !existsSync(cfg.modelPath)) {
      lastError = `Model not found: ${cfg.modelPath}. Download it first (./download_model.sh) or set modelPath.`;
      bb.log.error(lastError);
      await publishState();
      return;
    }
    const visionError = visionConfigError(cfg);
    if (visionError) {
      lastError = visionError;
      bb.log.error(lastError);
      await publishState();
      return;
    }
    const dsparkError = dsparkConfigError(cfg);
    if (dsparkError) {
      lastError = dsparkError;
      bb.log.error(lastError);
      await publishState();
      return;
    }
    lastError = null;
    lastHealth = null;
    activeEndpoint = { host: cfg.host, port: cfg.port };
    adoptedHealthFailureAt = null;
    adoptedHealthTimedOut = false;
    bb.log.info(`starting ds4-server: ${cfg.bin} ${cfg.args.join(" ")}`);
    lastDemandAt ??= Date.now();
    const startLogSeq = proc.logs(0, LOG_RING_LIMIT).nextOffset;
    lastStartLogSeq = startLogSeq;
    let managedPid: number | null = null;
    proc.start({
      bin: cfg.bin,
      args: cfg.args,
      cwd: cfg.ds4Dir ?? homedir(),
      onLine: (line: Ds4LogLine) => {
        logFlushQueue.push(line);
        scheduleLogFlush();
      },
      onExit: (code, signal) => {
        clearProcessRecord(bb.pluginId, managedPid);
        lastHealth = null;
        activeEndpoint = null;
        activeProcessStartedAt = null;
        adoptedHealthFailureAt = null;
        adoptedHealthTimedOut = false;
        const message = `ds4-server exited (code=${code} signal=${signal})`;
        if (stopRequested) bb.log.info(message);
        else {
          const conflictingPid = recentCollisionPid(startLogSeq);
          lastError = conflictingPid
            ? `Another ds4-server is already running (pid ${conflictingPid}).`
            : message;
          bb.log.warn(message);
          void publishState();
        }
      },
    });
    managedPid = proc.pid;
    if (managedPid) {
      activeProcessStartedAt = processStartTime(managedPid);
      writeProcessRecord(bb.pluginId, {
        pid: managedPid,
        fingerprint: cfg.fingerprint,
        bin: cfg.bin,
        args: cfg.args,
        cwd: cfg.ds4Dir ?? homedir(),
        startedAt: proc.startedAt ?? Date.now(),
        host: cfg.host,
        port: cfg.port,
        ownership: "managed",
        processStartedAt: activeProcessStartedAt ?? undefined,
      });
    }
    await publishState();
  }

  /** Start at most one local server process when a model call creates demand. */
  async function ensureStarted(cfg?: ResolvedRunConfig): Promise<void> {
    if (disposed) return;
    if (stopWaitPromise) {
      await stopWaitPromise;
      return ensureStarted(cfg);
    }
    if (proc.isRunning) return;
    if (startPromise) {
      const pending = startPromise;
      if (startPromiseEpoch === lifecycleEpoch) return pending;
      await pending.catch(() => undefined);
      if (startPromise === pending) {
        startPromise = null;
        startPromiseEpoch = null;
      }
      return ensureStarted(cfg);
    }

    const epoch = lifecycleEpoch;
    const isCurrent = () => !disposed && !shuttingDown && lifecycleEpoch === epoch;
    const run = (async () => {
      if (!isCurrent()) return;
      if (proc.state === "stopping") {
        if (activeStop) await activeStop;
        else await proc.stop();
      }
      if (!isCurrent()) return;
      const resolved = cfg ?? (await currentConfig());
      if (!isCurrent()) return;
      if (await recoverExistingServer(resolved, { isCurrent })) return;
      if (!isCurrent()) return;
      // Another demand callback may have recovered or started the process
      // while the recovery check was awaiting health.
      if (proc.isRunning) return;
      if (reclaimRecordedProcess()) {
        bb.log.info("stopping the previous managed ds4-server before applying new settings");
        await stopProc({ cancelPendingStart: false });
      }
      if (!isCurrent()) return;
      await startProc(resolved);
    })();
    let tracked: Promise<void>;
    tracked = run.finally(() => {
      if (startPromise === tracked) {
        startPromise = null;
        startPromiseEpoch = null;
      }
    });
    startPromise = tracked;
    startPromiseEpoch = epoch;
    await startPromise;
  }

  /** Transition the process to stopping before broadcasting its new state. */
  async function stopProc(
    options: {
      terminateExternal?: boolean;
      onlyIfNoDemand?: boolean;
      cancelPendingStart?: boolean;
    } = {},
  ): Promise<boolean> {
    if (proc.isExternal && !options.terminateExternal) {
      bb.log.info("leaving the existing external ds4-server running");
      return false;
    }
    if (options.onlyIfNoDemand && hasStopVeto()) {
      return false;
    }
    if (stopWaitPromise) {
      await stopWaitPromise;
      return true;
    }
    if (options.cancelPendingStart !== false) lifecycleEpoch += 1;
    const stopWait = new Promise<void>((resolve) => {
      resolveStopWait = resolve;
    });
    stopWaitPromise = stopWait;
    const finishStopWait = () => {
      if (stopWaitPromise !== stopWait) return;
      stopWaitPromise = null;
      const resolve = resolveStopWait;
      resolveStopWait = null;
      resolve?.();
    };
    const stoppedPid = proc.pid;
    let expectedAdoptedCommand: string[] | null = null;
    let expectedAdoptedProcessStartedAt: string | null = null;
    let expectedAdoptedCwd: string | null = null;
    if (proc.isAdopted && stoppedPid) {
      let cfg: ResolvedRunConfig;
      try {
        cfg = await currentConfig();
      } catch (error) {
        finishStopWait();
        throw error;
      }
      const expectedCommand = proc.cmdline;
      const expectedBin = expectedCommand?.[0] ?? cfg.bin;
      const expectedArgs = expectedCommand?.slice(1) ?? cfg.args;
      const expectedCwd = proc.cwd ?? cfg.ds4Dir ?? homedir();
      expectedAdoptedCwd = expectedCwd;
      expectedAdoptedProcessStartedAt =
        activeProcessStartedAt ?? processStartTime(stoppedPid);
      const observedStart = processStartTime(stoppedPid);
      if (
        !expectedBin ||
        !isProcessAlive(stoppedPid) ||
        !processMatchesCommand(stoppedPid, expectedBin, expectedArgs, expectedCwd) ||
        Boolean(
          expectedAdoptedProcessStartedAt &&
            observedStart &&
            expectedAdoptedProcessStartedAt !== observedStart,
        )
      ) {
        bb.log.warn("the adopted ds4-server process is no longer the expected process; not terminating it");
        proc.detachAdopted("exited");
        clearProcessRecord(bb.pluginId, stoppedPid);
        activeEndpoint = null;
        activeProcessStartedAt = null;
        adoptedHealthFailureAt = null;
        adoptedHealthTimedOut = false;
        finishStopWait();
        return false;
      }
      expectedAdoptedCommand = [expectedBin, ...expectedArgs];
      if (options.onlyIfNoDemand && hasStopVeto()) {
        finishStopWait();
        return false;
      }
    }
    // Recheck after the adopted-process identity work above and immediately
    // before stopping. A completion can begin while that asynchronous check
    // is in progress, so the first guard alone is not sufficient.
    if (options.onlyIfNoDemand && hasStopVeto()) {
      finishStopWait();
      return false;
    }
    if (activeStop) {
      await activeStop;
      finishStopWait();
      return true;
    }
    const verifyPid =
      stoppedPid && expectedAdoptedCommand
        ? (pid: number) =>
            processMatchesCommand(
              pid,
              expectedAdoptedCommand![0],
              expectedAdoptedCommand!.slice(1),
              expectedAdoptedCwd,
            ) &&
            (() => {
              if (!expectedAdoptedProcessStartedAt) return true;
              const observedStart = processStartTime(pid);
              return !observedStart || observedStart === expectedAdoptedProcessStartedAt;
            })()
        : undefined;
    const ownsStop = activeStop === null;
    if (ownsStop) stopRequested = true;
    let stopping: Promise<void> | null = null;
    try {
      stopping =
        activeStop ??
        proc.stop(12_000, {
          terminateExternal: options.terminateExternal,
          verifyPid,
        });
      activeStop = stopping;
      await publishState();
      await stopping!;
      clearProcessRecord(bb.pluginId, stoppedPid);
      activeEndpoint = null;
      activeProcessStartedAt = null;
      adoptedHealthFailureAt = null;
      adoptedHealthTimedOut = false;
    } finally {
      if (stopping && activeStop === stopping) activeStop = null;
      if (ownsStop) stopRequested = false;
      finishStopWait();
    }
    return true;
  }

  /** Make an explicit stop/restart able to find a server after plugin reload. */
  async function recoverForExplicitStop(): Promise<void> {
    await stopBridgeProcessRecord();
    if (proc.isRunning) return;
    const cfg = await currentConfig();
    if (await recoverExistingServer(cfg)) return;
    reclaimRecordedProcess();
  }

  // --- realtime log fan-out (batched + throttled) ---
  let logFlushQueue: Ds4LogLine[] = [];
  let logFlushTimer: NodeJS.Timeout | null = null;
  let persistedSeq = 0;

  function scheduleLogFlush(): void {
    if (logFlushTimer) return;
    logFlushTimer = setTimeout(() => {
      logFlushTimer = null;
      flushLogs();
    }, 150);
  }

  function flushLogs(): void {
    if (!logFlushQueue.length) return;
    const batch = logFlushQueue;
    logFlushQueue = [];
    try {
      bb.realtime.publish("logs", { lines: batch });
      const toPersist = batch.filter((l) => l.seq >= persistedSeq);
      if (toPersist.length) {
        persistedSeq = toPersist[toPersist.length - 1].seq + 1;
        appendPersistentLog(
          bb.pluginId,
          toPersist.map((l) => ({ ts: l.ts, stream: l.stream, text: l.text })),
        );
      }
    } catch {
      // best-effort
    }
  }

  // -------------------------------------------------------------------------
  // Supervisor service: demand-driven start, restart-on-crash, config-drift
  // restart, health polling, and idle shutdown. It always stops the server on
  // plugin reload/disable/shutdown.
  // -------------------------------------------------------------------------
  bb.background.service("supervisor", {
    start: async (signal) => {
      bb.log.info("supervisor started");
      shuttingDown = false;
      let lastFingerprint: string | null = null;
      let crashBackoffMs = 2000;
      let orphanCleanupDone = false;
      let providerLeaseWasActive = false;
      let lastProviderLeaseReleaseAt: number | null = null;

      try {
        while (!signal.aborted) {
          const cfg = await currentConfig();
          const s = await currentSettings();
          const providerLease = providerTurnLeaseSnapshot();
          const providerLeaseActive = providerLease.active;
          const hasDemand = hasCompletionDemand();
          if (
            (providerLeaseWasActive && !providerLeaseActive) ||
            (providerLease.releasedAt !== null &&
              providerLease.releasedAt !== lastProviderLeaseReleaseAt)
          ) {
            // A provider turn may have outlived the legacy supervisor's last
            // native completion. Start the idle grace period after that turn
            // ends, rather than measuring from the old server start time.
            lastDemandAt = Date.now();
          }
          if (providerLease.releasedAt !== null) {
            lastProviderLeaseReleaseAt = providerLease.releasedAt;
          }
          providerLeaseWasActive = providerLeaseActive;
          const hasStopDemand = hasDemand || providerLeaseActive;

          // A managed orphan may be all that remains after an abrupt host
          // daemon disconnect. Reclaim it only when there is no active demand,
          // then stop it so a fresh turn owns the next process cleanly. Do not
          // scan for or interfere with unmarked, user-owned servers here.
          if (!orphanCleanupDone && !hasStopDemand && proc.state === "stopped") {
            orphanCleanupDone = true;
            const recovered =
              (await recoverExistingServer(cfg, {
                allowExternal: false,
                isCurrent: () => !disposed && !shuttingDown && !signal.aborted,
              })) ||
              reclaimRecordedProcess();
            if (recovered && !hasStopVeto()) {
              const stopped = await stopProc({ onlyIfNoDemand: true });
              if (stopped) {
                lastDemandAt = null;
                lastHealth = null;
                await publishState();
              }
            }
          }

          // Config drift → restart so changes apply before the next request.
          let restartAfterDrift = false;
          if (
            proc.isRunning &&
            lastFingerprint !== null &&
            cfg.fingerprint !== lastFingerprint
          ) {
            if (proc.isExternal) {
              lastError =
                "DS4 settings changed while an external server is in use. Run `bb ds4 stop` to apply the new settings.";
              bb.log.warn(lastError);
            } else {
              bb.log.info("config changed — restarting ds4-server");
              const stopped = await stopProc({ onlyIfNoDemand: true });
              if (stopped || !proc.isRunning) {
                restartAfterDrift = true;
                lastHealth = null;
              } else {
                bb.log.info("deferring the config restart until active demand ends");
              }
            }
            if (proc.isExternal || restartAfterDrift) lastHealth = null;
          }
          if (
            !proc.isRunning ||
            !lastFingerprint ||
            lastFingerprint === cfg.fingerprint ||
            restartAfterDrift ||
            proc.isExternal
          ) {
            lastFingerprint = cfg.fingerprint;
          }

          if (
            cfg.bin &&
            hasDemand &&
            !providerLeaseActive &&
            !hasActiveProviderTurnLease() &&
            (restartAfterDrift || proc.state === "stopped" || proc.state === "exited")
          ) {
            await ensureStarted(cfg);
          }

          if (
            s.restartOnCrash &&
            hasDemand &&
            !providerLeaseActive &&
            !hasActiveProviderTurnLease() &&
            proc.state === "crashed" &&
            cfg.bin
          ) {
            const recovered = await recoverExistingServer(cfg, {
              isCurrent: () => !disposed && !shuttingDown && !signal.aborted,
            });
            if (recovered) {
              crashBackoffMs = 2000;
            }
            const since = Date.now() - (proc.exitInfo?.at ?? 0);
            if (!recovered && !signal.aborted && !shuttingDown && since >= crashBackoffMs) {
              bb.log.warn(`restarting after crash (backoff ${crashBackoffMs}ms)`);
              await ensureStarted(cfg);
            }
          }

          if (
            !hasStopDemand &&
            proc.isRunning &&
            lastDemandAt !== null &&
            Date.now() - lastDemandAt >= idleTimeoutMs()
          ) {
            let stopped = false;
            if (proc.isExternal) {
              bb.log.info("idle period reached; keeping the external ds4-server running");
              stopped = true;
            } else {
              bb.log.info("stopping ds4-server after the configured idle period");
              stopped = await stopProc({ onlyIfNoDemand: true });
            }
            if (stopped || (!proc.isRunning && !hasStopVeto())) {
              lastDemandAt = null;
            }
            if (stopped && !proc.isExternal) {
              lastHealth = null;
              await publishState();
            }
          }

          const health = await pollHealth(cfg);
          const previousHealth = lastHealth;
          lastHealth = health;
          if (proc.isAdopted && health && !health.ok) {
            const wasExternal = proc.isExternal;
            const adoptedPid = proc.pid;
            const adoptedCommand = proc.cmdline;
            const identityStillMatches = Boolean(
              adoptedPid &&
                adoptedCommand?.[0] &&
                isProcessAlive(adoptedPid) &&
                processMatchesCommand(
                  adoptedPid,
                  adoptedCommand[0],
                  adoptedCommand.slice(1),
                  proc.cwd,
                ),
            );
            if (!identityStillMatches) {
              proc.detachAdopted("crashed");
              clearProcessRecord(bb.pluginId, adoptedPid);
              activeEndpoint = null;
              activeProcessStartedAt = null;
              adoptedHealthFailureAt = null;
              adoptedHealthTimedOut = false;
              lastError = wasExternal
                ? "The existing ds4-server is no longer reachable."
                : "The recovered ds4-server is no longer reachable.";
              bb.log.warn(lastError);
              await publishState();
            } else {
              adoptedHealthFailureAt ??= Date.now();
              if (Date.now() - adoptedHealthFailureAt >= ADOPTED_HEALTH_GRACE_MS) {
                lastError = wasExternal
                  ? "The existing ds4-server did not become reachable."
                  : "The recovered ds4-server did not become reachable.";
                if (wasExternal) {
                  // Keep the external process adopted and probe it again. This
                  // preserves an explicit stop path and avoids repeatedly
                  // rediscovering the same unhealthy listener as external.
                  if (!adoptedHealthTimedOut) {
                    adoptedHealthTimedOut = true;
                    bb.log.warn(lastError);
                    await publishState();
                  }
                } else {
                  bb.log.warn(lastError);
                  await stopProc();
                  lastHealth = null;
                  adoptedHealthFailureAt = null;
                  await publishState();
                }
              }
            }
          } else if (proc.isAdopted && health?.ok) {
            adoptedHealthFailureAt = null;
            if (adoptedHealthTimedOut) {
              adoptedHealthTimedOut = false;
              lastError = null;
              await publishState();
            }
          } else if (!proc.isAdopted) {
            adoptedHealthFailureAt = null;
          }
          const healthChanged =
            health !== null &&
            (previousHealth === null ||
              health.ok !== previousHealth.ok ||
              JSON.stringify(health.models) !== JSON.stringify(previousHealth.models));
          if (healthChanged) await publishState();
          if (healthIsReady(health) && proc.isRunning) {
            crashBackoffMs = 2000; // healthy run resets the crash backoff
          } else if (proc.state === "crashed" && hasDemand) {
            crashBackoffMs = Math.min(30_000, crashBackoffMs * 2); // exponential
          }
          await sleep(2000, signal);
        }
      } catch (err) {
        bb.log.error(`supervisor error: ${String(err)}`);
      }

      shuttingDown = true;
      lifecycleEpoch += 1;
      flushLogs();
      if (proc.isRunning || proc.state === "stopping") {
        bb.log.info("stopping ds4-server (supervisor aborted)");
        await stopProc();
      }
      bb.log.info("supervisor stopped");
    },
  });

  // -------------------------------------------------------------------------
  // RPC
  // -------------------------------------------------------------------------
  bb.rpc.register(rpcContract, {
    async status() {
      return buildStatus();
    },
    async start() {
      await ensureStarted(await currentConfig());
      return buildStatus();
    },
    async stop() {
      lastError = null;
      bb.log.info("manual stop requested");
      await recoverForExplicitStop();
      await stopProc({ terminateExternal: true });
      lastDemandAt = null;
      lastHealth = null;
      await publishState();
      return buildStatus();
    },
    async restart() {
      lastError = null;
      bb.log.info("manual restart requested");
      await recoverForExplicitStop();
      await stopProc({ terminateExternal: true });
      lastDemandAt = Date.now();
      await ensureStarted(await currentConfig());
      return buildStatus();
    },
    async logs({ offset, limit }) {
      return proc.logs(offset ?? 0, limit ?? 300);
    },
    async clearLogs() {
      proc.clearLogs();
      persistedSeq = 0;
      try {
        bb.realtime.publish("logs", { cleared: true, lines: [] });
      } catch {
        // ignore
      }
      return { total: 0 };
    },
    async agentConfigs() {
      return { targets: allStatuses() };
    },
    async applyAgentConfigs({ targets }) {
      const cfg = await currentConfig();
      const results = applyTargets(targets as AgentTargetId[], {
        port: cfg.port,
        ctx: cfg.ctx,
        maxTokens: cfg.maxTokens,
        modelId: primaryModelId(cfg),
        modelIds: advertisedIds(cfg),
        vision: visionEnabled(cfg),
      });
      for (const r of results) {
        if (r.ok) bb.log.info(`agent config written: ${r.message}`);
        else bb.log.error(`agent config failed: ${r.message}`);
      }
      return { results };
    },
    async launchAgent() {
      const cfg = await currentConfig();
      return launchAgentTerminal(cfg);
    },
    async complete(params) {
      const cfg = await currentConfig();
      const text = await ds4Complete(cfg, params);
      return { text };
    },
  });

  async function launchAgentTerminal(cfg: ResolvedRunConfig): Promise<{
    terminalId: string;
    title: string;
  }> {
    const visionError = visionConfigError(cfg);
    if (visionError) throw new Error(visionError);
    const dsparkError = dsparkConfigError(cfg);
    if (dsparkError) throw new Error(dsparkError);
    const hosts = await bb.sdk.hosts.list();
    const host = hosts.find((h) => h.status === "connected") ?? hosts[0];
    if (!host) throw new Error("No connected host available for a terminal");
    const { bin, args } = agentCommand(cfg);
    const command = [bin, ...args].map(shellQuote).join(" ");
    const term = await bb.sdk.terminals.create({
      cols: 110,
      rows: 32,
      scope: { kind: "host_path", hostId: host.id, cwd: cfg.ds4Dir },
      start: { mode: "command", command },
      title: "ds4-agent",
    });
    bb.log.info(`launched interactive ds4-agent terminal ${term.id}`);
    return { terminalId: term.id, title: term.title ?? "ds4-agent" };
  }

  async function performDs4Complete(
    cfg: ResolvedRunConfig,
    params: {
      prompt: string;
      system?: string;
      maxTokens: number;
      temperature?: number;
      imageUrls?: string[];
    },
  ): Promise<string> {
    if (proc.isExternal && !externalServerMatchesCurrentConfig(cfg)) {
      throw new Error(
        "The adopted external ds4-server is using previous settings. Run `bb ds4 stop` and start it again to apply the current configuration.",
      );
    }
    const endpoint = proc.isAdopted && activeEndpoint
      ? activeEndpoint
      : { host: cfg.host, port: cfg.port };
    const url = `http://${endpoint.host}:${endpoint.port}/v1/chat/completions`;
    const imageUrls = params.imageUrls ?? [];
    const contentSizeError = completionPayloadSizeError(
      params.prompt,
      params.system,
      imageUrls,
    );
    if (contentSizeError) throw new Error(contentSizeError);
    if (imageUrls.length && !visionEnabled(cfg)) {
      const visionError = cfg.visionPath
        ? visionConfigError(cfg) ??
          (proc.isExternal
            ? "The adopted external ds4-server was not started with the configured GLM 5.3 vision encoder. Restart it with --vision or stop it so the plugin can start the configured server."
            : "Image input is unavailable because the ds4-server is not configured with the GLM 5.3 vision encoder.")
        : "Image input is disabled. Set visionPath to auto and download ./download_model.sh glm53-vision, or set it to the encoder path.";
      throw new Error(visionError);
    }
    const requestBody = serializeDwarfStarChatRequest(
      buildDwarfStarChatRequest(
        primaryModelId(cfg),
        params.prompt,
        params.system,
        params.maxTokens,
        params.temperature,
        imageUrls,
      ),
    );
    const requestBodySizeError = completionRequestBodySizeError(requestBody);
    if (requestBodySizeError) throw new Error(requestBodySizeError);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer dsv4-local",
      },
      body: requestBody,
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`ds4-server responded ${res.status}: ${text.slice(0, 300)}`);
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return (data.choices?.[0]?.message?.content ?? "").trim();
  }

  async function ds4Complete(
    cfg: ResolvedRunConfig,
    params: {
      prompt: string;
      system?: string;
      maxTokens: number;
      temperature?: number;
      imageUrls?: string[];
    },
  ): Promise<string> {
    inFlightCompletions += 1;
    lastDemandAt ??= Date.now();
    try {
      return await performDs4Complete(cfg, params);
    } finally {
      inFlightCompletions = Math.max(0, inFlightCompletions - 1);
      if (inFlightCompletions === 0) {
        lastDemandAt = Date.now();
      }
    }
  }

  function externalServerMatchesCurrentConfig(cfg: ResolvedRunConfig): boolean {
    if (!proc.isExternal) return true;
    const pid = proc.pid;
    const command = proc.cmdline;
    if (!pid || !cfg.bin || !command?.[0] || command.length < 1) return false;
    return processMatchesCommand(
      pid,
      cfg.bin,
      cfg.args,
      proc.cwd ?? cfg.ds4Dir,
    );
  }

  // -------------------------------------------------------------------------
  // CLI: `bb ds4 …`
  // -------------------------------------------------------------------------
  bb.cli.register({
    name: "ds4",
    summary: "Administer a local DwarfStar (ds4-server) inference engine",
    commands: [
      { name: "status", summary: "Show server status and health", usage: "bb ds4 status" },
      { name: "start", summary: "Start ds4-server", usage: "bb ds4 start" },
      { name: "stop", summary: "Stop ds4-server", usage: "bb ds4 stop" },
      { name: "restart", summary: "Restart ds4-server", usage: "bb ds4 restart" },
      { name: "logs", summary: "Show recent process output", usage: "bb ds4 logs [-n N]" },
      {
        name: "agents",
        summary: "Show or write agent provider configs",
        usage: "bb ds4 agents [status|apply [pi|opencode|codex ...]]",
      },
      {
        name: "agent",
        summary: "Launch the interactive ds4-agent in a BB terminal",
        usage: "bb ds4 agent",
      },
      {
        name: "complete",
        summary: "One-shot completion against the local server",
        usage: "bb ds4 complete <prompt>",
      },
    ],
    async run(argv) {
      const [cmd, ...rest] = argv;
      switch (cmd) {
        case "status":
          return { exitCode: 0, stdout: renderStatus(await buildStatus()) };
        case "start": {
          await ensureStarted(await currentConfig());
          return { exitCode: 0, stdout: renderStatus(await buildStatus()) };
        }
        case "stop": {
          await recoverForExplicitStop();
          await stopProc({ terminateExternal: true });
          lastDemandAt = null;
          lastHealth = null;
          await publishState();
          return { exitCode: 0, stdout: renderStatus(await buildStatus()) };
        }
        case "restart": {
          await recoverForExplicitStop();
          await stopProc({ terminateExternal: true });
          lastDemandAt = Date.now();
          await ensureStarted(await currentConfig());
          return { exitCode: 0, stdout: renderStatus(await buildStatus()) };
        }
        case "logs": {
          let n = 100;
          for (let i = 0; i < rest.length; i++) {
            if (rest[i] === "-n" && rest[i + 1]) n = parseInt(rest[++i], 10) || 100;
          }
          const { lines } = proc.logs(0, Math.min(n, 2000));
          if (!lines.length) return { exitCode: 0, stdout: "(no log lines yet)" };
          const out = lines
            .map((l) => {
              const t = new Date(l.ts);
              const hh = String(t.getHours()).padStart(2, "0");
              const mm = String(t.getMinutes()).padStart(2, "0");
              const ss = String(t.getSeconds()).padStart(2, "0");
              return `${hh}:${mm}:${ss} [${l.stream}] ${l.text}`;
            })
            .join("\n");
          return { exitCode: 0, stdout: out };
        }
        case "agents": {
          const sub = rest[0] ?? "status";
          if (sub === "apply") {
            const cfg = await currentConfig();
            const wanted = rest.slice(1);
            const targets = wanted as AgentTargetId[];
            if (!targets.length) {
              return { exitCode: 1, stdout: "Pass at least one target: pi, opencode, or codex." };
            }
            const results = applyTargets(targets, {
              port: cfg.port,
              ctx: cfg.ctx,
              maxTokens: cfg.maxTokens,
              modelId: primaryModelId(cfg),
              modelIds: advertisedIds(cfg),
              vision: visionEnabled(cfg),
            });
            const out = results
              .map((r) => `${r.ok ? "ok   " : "FAIL "} ${r.id}: ${r.message}${r.backup ? ` (backup: ${r.backup})` : ""}`)
              .join("\n");
            return { exitCode: results.every((r) => r.ok) ? 0 : 1, stdout: out };
          }
          const st = allStatuses()
            .map(
              (t) =>
                `${t.id.padEnd(8)} ${t.configured ? "configured" : "missing   "} ${t.path} — ${t.detail}`,
            )
            .join("\n");
          return { exitCode: 0, stdout: st };
        }
        case "agent": {
          try {
            const { terminalId, title } = await launchAgentTerminal(await currentConfig());
            return {
              exitCode: 0,
              stdout: `Opened terminal "${title}" (${terminalId}) in the BB terminal area.`,
            };
          } catch (err) {
            return { exitCode: 1, stdout: `Failed to launch ds4-agent: ${String(err)}` };
          }
        }
        case "complete": {
          const prompt = rest.join(" ");
          if (!prompt) {
            return {
              exitCode: 1,
              stdout: "Usage: bb ds4 complete <prompt>",
              stderr: "missing prompt",
            };
          }
          if (!(proc.state === "running" && healthIsReady(lastHealth))) {
            return {
              exitCode: 1,
              stdout: `ds4-server is not ready (state=${proc.state}). Run \`bb ds4 start\` first.`,
            };
          }
          try {
            const text = await ds4Complete(await currentConfig(), {
              prompt,
              maxTokens: 2048,
            });
            return { exitCode: 0, stdout: text };
          } catch (err) {
            return { exitCode: 1, stdout: `ds4 complete failed: ${String(err)}` };
          }
        }
        default:
          return {
            exitCode: 1,
            stdout: "Usage: bb ds4 <status|start|stop|restart|logs|agents|agent|complete>",
          };
      }
    },
  });

  // -------------------------------------------------------------------------
  // Native agent tools — let BB agents use the local DS4 model directly
  // -------------------------------------------------------------------------
  bb.agents.registerTool({
    name: "ds4_status",
    description:
      "Check the local DS4 (DwarfStar) inference server: running state, health latency, and served model ids. Use before relying on the local model.",
    instructions:
      "When the user mentions DS4, DwarfStar, or a local DeepSeek server, check ds4_status before assuming it is running.",
    presentation: {
      label: {
        pending: "Checking DS4 server",
        completed: "Checked DS4 server",
      },
    },
    parameters: z.object({}).strict(),
    async execute() {
      const st = await buildStatus();
      return renderStatus(st);
    },
  });

  bb.agents.registerTool({
    name: "ds4_complete",
    description:
      "Run a one-shot text or image completion on the local DS4 (DwarfStar) OpenAI-compatible server. Pass inline PNG/JPEG data URIs in imageUrls when a GLM 5.3 vision encoder is configured. Fails if the server is not ready.",
    presentation: {
      label: {
        pending: "Querying local DS4 model",
        completed: "Queried local DS4 model",
      },
    },
    parameters: completeInputSchema,
    async execute({ prompt, system, maxTokens, temperature, imageUrls }) {
      if (!(proc.state === "running" && healthIsReady(lastHealth))) {
        return `DS4 server is not ready (state=${proc.state}). Start it with \`bb ds4 start\` first.`;
      }
      try {
        return await ds4Complete(await currentConfig(), {
          prompt,
          system,
          maxTokens,
          temperature,
          imageUrls,
        });
      } catch (err) {
        return `ds4_complete failed: ${String(err)}`;
      }
    },
  });

  bb.agents.registerTool({
    name: "read",
    description: "Read a UTF-8 text file from the current BB workspace. The path is confined to the workspace and output is line-numbered.",
    instructions: "Use read for workspace files. Paths are relative to the workspace unless absolute and inside it.",
    presentation: {
      label: { pending: "Reading workspace file", completed: "Read workspace file" },
    },
    parameters: z.object({
      path: z.string().min(1).max(4096),
      startLine: z.number().int().min(1).optional(),
      endLine: z.number().int().min(1).optional(),
    }).strict(),
    async execute({ path, startLine, endLine }, context) {
      const file = await readWorkspaceToolFile(context, path);
      const range = formatWorkspaceFileRange(file.text, startLine, endLine);
      return limitDs4ToolResult(
        `${file.label}:${range.start}-${range.end} of ${range.total}\n${range.value || "(empty file)"}`,
      );
    },
  });

  bb.agents.registerTool({
    name: "edit",
    description: "Replace one exact occurrence in a UTF-8 text file in the current BB workspace using an optimistic hash check.",
    instructions: "Use edit for precise file changes. Include enough oldText to match exactly one occurrence; re-read after a conflict.",
    presentation: {
      label: { pending: "Editing workspace file", completed: "Edited workspace file" },
    },
    parameters: z.object({
      path: z.string().min(1).max(4096),
      oldText: z.string().min(1).max(MAX_DS4_EDIT_BYTES),
      newText: z.string().max(MAX_DS4_EDIT_BYTES),
    }).strict(),
    async execute({ path, oldText, newText }, context) {
      const file = await readWorkspaceToolFile(context, path);
      const first = file.text.indexOf(oldText);
      if (first < 0) throw new Error(`The requested text was not found in ${file.label}.`);
      if (file.text.indexOf(oldText, first + 1) >= 0) {
        throw new Error(`The requested text occurs more than once in ${file.label}; make oldText more specific.`);
      }
      const next = `${file.text.slice(0, first)}${newText}${file.text.slice(first + oldText.length)}`;
      if (Buffer.byteLength(next, "utf8") > MAX_DS4_READ_BYTES) {
        throw new Error("The edited file is too large for the DS4 tool.");
      }
      const result = await bb.sdk.files.write({
        hostId: file.hostId,
        path: file.path,
        rootPath: file.rootPath,
        content: next,
        contentEncoding: "utf8",
        createParents: false,
        expectedSha256: file.sha256,
      });
      if (result.outcome === "conflict") {
        throw new Error(`The file changed while editing ${file.label}; read it again and retry.`);
      }
      return `${file.label}: replaced one occurrence (${result.sizeBytes} bytes).`;
    },
  });

  bb.agents.registerTool({
    name: "bash",
    description: "Run an unrestricted shell command on the current host. It starts in the current workspace by default and may access any host path.",
    instructions: "Use bash for shell commands. This is an unrestricted host shell: absolute paths, network access, and commands outside the workspace are allowed by design.",
    presentation: {
      label: { pending: "Running shell command", completed: "Ran shell command" },
    },
    parameters: z.object({
      command: z.string().min(1).max(MAX_DS4_BASH_COMMAND_CHARS),
      cwd: z.string().min(1).max(MAX_DS4_BASH_CWD_CHARS).optional(),
      timeout: z.number().int().min(1).max(MAX_DS4_BASH_TIMEOUT_MS).optional(),
    }).strict(),
    async execute({ command, cwd, timeout }, context) {
      return executeDs4Bash(context, command, cwd, timeout);
    },
  });

  // The first-class provider owns startup. This callback contributes only the
  // native tools available when a DS4 session is created.
  bb.agents.configure((context) => {
    if (context.provider.id === DS4_PROVIDER_ID) {
      return {
        tools: [...DS4_PROVIDER_TOOLS],
        skills: [],
        instructions:
          "DwarfStar provides read and edit for workspace files and bash for unrestricted host-shell commands.",
      };
    }
    return {
      tools: [],
      skills: [],
    };
  });

  // -------------------------------------------------------------------------
  // Settings change logging + dispose
  // -------------------------------------------------------------------------
  settings.onChange((next, prev) => {
    latestSettings = next;
    const n = next as Record<string, unknown>;
    const p = prev as Record<string, unknown>;
    const changed = Object.keys(n).filter(
      (k) => JSON.stringify(n[k]) !== JSON.stringify(p[k]),
    );
    if (changed.length) bb.log.info(`settings changed: ${changed.join(", ")}`);
    if (
      (next.modelPath ?? "") !== (prev.modelPath ?? "") ||
      (next.ds4Dir ?? "") !== (prev.ds4Dir ?? "")
    ) {
      try {
        providerRegistration.dispose();
        providerRegistration = bb.providers.register(providerDeclaration());
      } catch (error) {
        bb.log.error(`could not refresh DwarfStar provider model: ${String(error)}`);
      }
    }
  });

  bb.onDispose(() => {
    disposed = true;
    shuttingDown = true;
    lifecycleEpoch += 1;
    providerRegistration.dispose();
    if (logFlushTimer) {
      clearTimeout(logFlushTimer);
      logFlushTimer = null;
    }
    bb.log.info("disposed");
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderStatus(st: StatusDto): string {
  const lines: string[] = [];
  lines.push(`state:     ${st.displayState}`);
  lines.push(`ownership: ${st.ownership}`);
  if (st.pid) lines.push(`pid:       ${st.pid}`);
  if (st.startedAt) {
    const s = Math.floor(st.uptimeMs / 1000);
    const mm = Math.floor(s / 60);
    const ss = s % 60;
    lines.push(`uptime:    ${mm}m ${String(ss).padStart(2, "0")}s`);
  }
  if (st.health) {
    if (st.health.ok) {
      lines.push(
        `health:    ok (${st.health.latencyMs} ms)${st.health.models.length ? ` — models: ${st.health.models.join(", ")}` : ""}`,
      );
    } else {
      lines.push(`health:    not ready (${st.health.error ?? st.health.status ?? "no response"})`);
    }
  } else {
    lines.push(`health:    —`);
  }
  const endpoint = st.activeEndpoint ?? { host: st.config.host, port: st.config.port };
  lines.push(
    `endpoint:  http://${endpoint.host}:${endpoint.port}/v1`,
    `port:      ${endpoint.port}`,
    ...(st.activeEndpoint &&
    (st.activeEndpoint.host !== st.config.host || st.activeEndpoint.port !== st.config.port)
      ? [`configured: http://${st.config.host}:${st.config.port}/v1`]
      : []),
    `ctx:       ${st.config.ctx}`,
    `max out:   ${st.config.maxTokens}`,
    `dspark:    ${st.config.dspark ? `on (confidence ${st.config.dsparkConfidence ?? "upstream default"})` : "off"}`,
    `model:     ${st.config.modelPath ?? "(none)"}`,
    `vision:    ${st.config.visionPath ?? "off"}`,
    `dir:       ${st.config.ds4Dir ?? "(not found)"}`,
    `dspark GGUF: ${st.config.dsparkSupportPath ?? "(not found)"}`,
    `backend:   ${st.config.backend}`,
    `log file:  ${st.log.file}`,
  );
  if (st.config.bin) lines.push(`bin:       ${st.config.bin}`);
  if (st.lastError) lines.push(`error:     ${st.lastError}`);
  lines.push(
    `settings:  idle=${st.settings.idleTimeoutSeconds}s restartOnCrash=${st.settings.restartOnCrash ? "on" : "off"} maxTokens=${st.settings.maxTokens}`,
  );
  return lines.join("\n");
}
