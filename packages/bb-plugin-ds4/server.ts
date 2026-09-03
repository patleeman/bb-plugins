// bb-plugin-ds4 — admin a local DwarfStar (antirez/ds4) inference server from
// BB: run/stop/restart ds4-server, tail its logs, watch health, write agent
// provider configs (pi / opencode / Codex CLI), and expose the local model to
// BB agents through native tools and a `bb ds4` CLI.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
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
  applyPerModelOverrides,
  DEFAULT_DWARFSTAR_CONTEXT_TOKENS,
  parsePerModelConfig,
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
  validateDsparkSupportPath,
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
  DWARFSTAR_MODEL_PRESET_OPTIONS,
  isDwarfStarVisionModel,
  isDwarfStarModel,
  normalizeDwarfStarModelPreset,
  parseIdleTimeoutMs,
  wireDwarfStarModelId,
} from "./src/model-selection";
import {
  buildDwarfStarChatRequest,
  completionRequestBodySizeError,
  completionPayloadSizeError,
  completeInputSchema,
  serializeDwarfStarChatRequest,
} from "./src/request-payload";
import {
  orphanCleanupIsDue,
  providerLeaseVetoesStart,
} from "./src/supervisor-policy";
import {
  classifyModelFile,
  createModelDownloadPlan,
  hasModelFilePartial,
  isUsableModelFile,
  type ModelDownloadPlan,
  type ModelDownloadPlanInput,
  type ModelDownloadTarget,
} from "./src/model-download";

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
const modelFileSchema = z.object({
  kind: z.enum(["model", "vision", "dspark"]),
  label: z.string(),
  path: z.string().nullable(),
  required: z.boolean(),
  state: z.enum(["present", "missing", "partial", "unavailable"]),
  downloadTarget: z.string().nullable(),
});
const modelFilesStatusSchema = z.object({
  preset: z.string(),
  modelId: z.string().nullable(),
  modelDisplayName: z.string(),
  files: z.array(modelFileSchema),
  complete: z.boolean(),
  downloadable: z.boolean(),
  downloading: z.boolean(),
  currentTarget: z.string().nullable(),
  completedTargets: z.array(z.string()),
  startedAt: z.number().nullable(),
  cancelled: z.boolean(),
  error: z.string().nullable(),
  output: z.string(),
  message: z.string(),
});
const installedModelEntrySchema = z.object({
  preset: z.string(),
  displayName: z.string(),
  modelId: z.string().nullable(),
  isSelected: z.boolean(),
  isInstalled: z.boolean(),
  files: z.array(modelFileSchema),
  targets: z.array(z.string()),
  downloadable: z.boolean(),
  downloading: z.boolean(),
  currentTarget: z.string().nullable(),
  completedTargets: z.array(z.string()),
  startedAt: z.number().nullable(),
  cancelled: z.boolean(),
  error: z.string().nullable(),
  output: z.string(),
  message: z.string(),
});
const installedModelsSchema = z.object({
  ds4Dir: z.string().nullable(),
  selectedPreset: z.string(),
  models: z.array(installedModelEntrySchema),
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
  modelFiles: { input: z.null(), output: modelFilesStatusSchema },
  downloadModels: { input: z.null(), output: modelFilesStatusSchema },
  cancelDownload: { input: z.null(), output: modelFilesStatusSchema },
  installedModels: { input: z.null(), output: installedModelsSchema },
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
type ModelFilesStatusDto = z.infer<typeof modelFilesStatusSchema>;

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

const LOG_RING_LIMIT = 5000;
const ADOPTED_HEALTH_GRACE_MS = 120_000;

type ServerEndpoint = { host: string; port: number };

const DS4_PROVIDER_ID = "ds4";

function dwarfStarModelDisplayName(modelId: string): string {
  const bare = modelId.replace(/^dwarfstar\//, "").replace(/^ds4\//, "");
  switch (bare) {
    case "deepseek-v4-flash": return "DeepSeek V4 Flash";
    case "deepseek-v4-flash-vision-exp": return "DeepSeek V4 Flash Vision Experimental";
    case "deepseek-v4-pro": return "DeepSeek V4 Pro";
    case "glm-5.2": return "GLM 5.2";
    case "glm-5.3-flash": return "GLM 5.3 Flash";
    default: return "DwarfStar (configured model)";
  }
}

function dwarfStarProviderModel(modelId: string) {
  const bare = modelId.replace(/^dwarfstar\//, "").replace(/^ds4\//, "");
  return {
    id: modelId,
    displayName: dwarfStarModelDisplayName(modelId),
    description: "DwarfStar via StockPi - local DS4 with Pi toolset.",
    supportedReasoningEfforts: [
      { reasoningEffort: "none" as const, description: "None" },
      { reasoningEffort: "low" as const, description: "Low" },
      { reasoningEffort: "medium" as const, description: "Medium" },
      { reasoningEffort: "high" as const, description: "High" },
      { reasoningEffort: "xhigh" as const, description: "Extra High" },
      { reasoningEffort: "max" as const, description: "Maximum" },
    ],
    defaultReasoningEffort: bare.startsWith("glm-") ? "high" as const : "none" as const,
    isDefault: bare === "deepseek-v4-flash",
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
    modelPreset: {
      type: "select",
      label: "Model",
      description:
        "Select the single GGUF loaded by DwarfStar. Auto uses Model GGUF path; the named options find their standard files in the DS4 checkout.",
      options: [...DWARFSTAR_MODEL_PRESET_OPTIONS],
      default: "auto",
    },
    modelPath: {
      type: "string",
      label: "Model GGUF path",
      description:
        "Advanced override: absolute path, or relative to the DS4 directory. Used when Model is auto; empty = ds4flash.gguf.",
      default: "",
    },
    visionPath: {
      type: "string",
      label: "Vision encoder path",
      description:
        "Use auto to detect the selected model's standard encoder; set an absolute or DS4-relative path to override, or leave empty to disable vision.",
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
    perModelConfig: {
      type: "string",
      label: "Per-model overrides (JSON)",
      description:
        "Managed by the DwarfStar settings UI. Maps a Model name to ctx, maxTokens, vision, backend, KV, DSpark overrides.",
      default: "{}",
    },
  });

  const proc = new Ds4Process(LOG_RING_LIMIT);
  let lastHealth: z.infer<typeof healthSchema> | null = null;
  let lastError: string | null = null;
  type StoredSettings = Awaited<ReturnType<typeof settings.get>>;
  let latestSettings: StoredSettings = await settings.get();
  let inFlightCompletions = 0;
  let lastDemandAt: number | null = null;
  type ModelDownloadJob = {
    ds4Dir: string;
    preset: string;
    targets: ModelDownloadTarget[];
    completedTargets: string[];
    currentTarget: ModelDownloadTarget | null;
    startedAt: number;
    child: ChildProcess | null;
    processGroupIds: Set<number>;
    cancelPromise: Promise<void> | null;
    cancelled: boolean;
    output: string;
    error: string | null;
  };
  let modelDownloadJob: ModelDownloadJob | null = null;

  /** Best-effort realtime push so open settings pages update without waiting for their poll. */
  async function publishDownloads(): Promise<void> {
    try {
      bb.realtime.publish("model-downloads", installedModelsStatus(await currentConfig()));
    } catch {
      // best-effort
    }
  }

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
    const base: RunSettings = {
      ds4Dir: s.ds4Dir ?? "",
      modelPath: s.modelPath ?? "",
      modelPreset: s.modelPreset ?? "auto",
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
    // Per-model overrides live in perModelConfig JSON keyed by the raw Model name.
    const rawPerModel = (s as Record<string, unknown>).perModelConfig;
    const perModel = parsePerModelConfig(typeof rawPerModel === "string" ? rawPerModel : "");
    const presetKey = base.modelPreset ?? "auto";
    return applyPerModelOverrides(base, perModel, presetKey);
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

  function modelDownloadPlanForConfig(
    cfg: ResolvedRunConfig,
  ): ModelDownloadPlan {
    return createModelDownloadPlan({
      ds4Dir: cfg.ds4Dir,
      modelPreset: latestSettings.modelPreset ?? "auto",
      modelPath: cfg.modelPath,
      visionSetting: latestSettings.visionPath ?? "auto",
      visionPath: cfg.visionPath,
      dspark: cfg.dspark,
      dsparkSupportPath: cfg.dsparkSupportPath,
    });
  }

  function modelDownloadFileState(path: string | null) {
    if (!path) return "unavailable" as const;
    return classifyModelFile(
      regularFileExists(path),
      hasModelFilePartial(path),
    );
  }

  function regularFileExists(path: string): boolean {
    return isUsableModelFile(path);
  }

  function matchingModelDownloadJob(
    cfg: ResolvedRunConfig,
    plan: ModelDownloadPlan,
  ): ModelDownloadJob | null {
    const job = modelDownloadJob;
    return job && job.ds4Dir === cfg.ds4Dir && job.preset === plan.preset
      ? job
      : null;
  }

  function installedModelsStatus(
    cfg: ResolvedRunConfig,
  ): z.infer<typeof installedModelsSchema> {
    const selectedPresetRaw =
      typeof latestSettings.modelPreset === "string" && latestSettings.modelPreset
        ? latestSettings.modelPreset
        : "auto";
    const selectedPreset = (DWARFSTAR_MODEL_PRESET_OPTIONS as readonly string[]).includes(selectedPresetRaw)
      ? selectedPresetRaw
      : "auto";
    if (modelDownloadJob) pruneModelDownloadProcessGroups(modelDownloadJob);
    const anyDownloadActive =
      modelDownloadJob !== null &&
      (modelDownloadJob.currentTarget !== null || modelDownloadJob.processGroupIds.size > 0);
    const scriptAvailable =
      cfg.ds4Dir !== null && regularFileExists(join(cfg.ds4Dir, "download_model.sh"));
    const models = DWARFSTAR_MODEL_PRESET_OPTIONS.map((presetValue) => {
      const isSelected = presetValue === selectedPreset;
      const planInput: ModelDownloadPlanInput = isSelected
        ? {
            ds4Dir: cfg.ds4Dir,
            modelPreset: presetValue,
            modelPath: cfg.modelPath,
            visionSetting: latestSettings.visionPath ?? "auto",
            visionPath: cfg.visionPath,
            dspark: cfg.dspark,
            dsparkSupportPath: cfg.dsparkSupportPath,
          }
        : {
            ds4Dir: cfg.ds4Dir,
            modelPreset: presetValue,
            modelPath: null,
            visionSetting: "auto",
            visionPath: null,
            dspark: Boolean(latestSettings.dspark),
            dsparkSupportPath: null,
          };
      // For auto, reuse the selected config's plan so custom paths are reflected
      const effectiveInput =
        presetValue === "auto" && !isSelected
          ? {
              ds4Dir: cfg.ds4Dir,
              modelPreset: "auto" as const,
              modelPath: cfg.modelPath,
              visionSetting: latestSettings.visionPath ?? "auto",
              visionPath: cfg.visionPath,
              dspark: cfg.dspark,
              dsparkSupportPath: cfg.dsparkSupportPath,
            }
          : planInput;
      const plan = createModelDownloadPlan(effectiveInput as ModelDownloadPlanInput);
      const job = matchingModelDownloadJob(cfg, plan);
      const files = plan.files.map((file) => ({
        kind: file.kind,
        label: file.label,
        path: file.path,
        required: file.required,
        state: modelDownloadFileState(file.path),
        downloadTarget: file.target,
      }));
      const isInstalled = files.length > 0 && files.every((f) => f.state === "present");
      const missingTargets = plan.targets.filter((target) =>
        files.some((file) => file.downloadTarget === target && file.state !== "present"),
      );
      const downloading = Boolean(anyDownloadActive && (job !== null || plan.preset === modelDownloadJob?.preset));
      const downloadable =
        scriptAvailable && plan.downloadable && missingTargets.length > 0 && !anyDownloadActive;
      const activeJob = downloading ? (job ?? modelDownloadJob) : null;
      let message: string;
      if (downloading && activeJob) {
        const done = activeJob.completedTargets.length;
        const total = activeJob.targets.length;
        message = total > 1
          ? `Downloading ${activeJob.currentTarget ?? "model files"}… (${done + 1} of ${total})`
          : `Downloading ${activeJob.currentTarget ?? "model files"}…`;
      }
      else if (downloading) message = "Another download is in progress.";
      else if (job?.cancelled && !job?.error) message = "Download cancelled.";
      else if (job?.error) message = `Download failed: ${job.error}`;
      else if (plan.error) message = plan.error;
      else if (!scriptAvailable) message = "download_model.sh not found.";
      else if (isInstalled) message = "Ready";
      else if (missingTargets.length === 0) message = "Manual download required.";
      else message = "Missing files.";
      return {
        preset: presetValue,
        displayName:
          presetValue === "auto"
            ? "Auto (custom path)"
            : presetValue,
        modelId: plan.modelId,
        isSelected,
        isInstalled,
        files,
        targets: [...plan.targets] as string[],
        downloadable,
        downloading,
        currentTarget: activeJob?.currentTarget ?? null,
        completedTargets: activeJob ? [...activeJob.completedTargets] : [],
        startedAt: activeJob?.startedAt ?? null,
        cancelled: job?.cancelled ?? false,
        error: job?.error ?? null,
        // Only the entry that owns the job carries the log tail.
        output: job ? job.output : "",
        message,
      };
    });
    return {
      ds4Dir: cfg.ds4Dir,
      selectedPreset,
      models,
    };
  }

  function modelFilesStatusForConfig(
    cfg: ResolvedRunConfig,
  ): ModelFilesStatusDto {
    const plan = modelDownloadPlanForConfig(cfg);
    const job = matchingModelDownloadJob(cfg, plan);
    if (modelDownloadJob) pruneModelDownloadProcessGroups(modelDownloadJob);
    const activeDownloadJob =
      modelDownloadJob &&
      (modelDownloadJob.currentTarget !== null ||
        modelDownloadJob.processGroupIds.size > 0)
        ? modelDownloadJob
        : null;
    const anyDownloadActive = activeDownloadJob !== null;
    const files = plan.files.map((file) => ({
      kind: file.kind,
      label: file.label,
      path: file.path,
      required: file.required,
      state: modelDownloadFileState(file.path),
      downloadTarget: file.target,
    }));
    const complete = files.every((file) => file.state === "present");
    const missingTargets = plan.targets.filter((target) =>
      files.some(
        (file) => file.downloadTarget === target && file.state !== "present",
      ),
    );
    const scriptAvailable =
      cfg.ds4Dir !== null && regularFileExists(join(cfg.ds4Dir, "download_model.sh"));
    const downloading = activeDownloadJob !== null;
    const downloadable =
      scriptAvailable &&
      plan.downloadable &&
      missingTargets.length > 0 &&
      !anyDownloadActive;
    let message: string;
    const progressJob = downloading ? (job ?? activeDownloadJob) : null;
    if (downloading && progressJob) {
      const done = progressJob.completedTargets.length;
      const total = progressJob.targets.length;
      message = total > 1
        ? `Downloading ${progressJob.currentTarget ?? "model files"}… (${done + 1} of ${total})`
        : `Downloading ${progressJob.currentTarget ?? "model files"}…`;
    } else if (downloading) {
      message = "Another DwarfStar model download is already in progress.";
    } else if (job?.cancelled && !job?.error) {
      message = "Download cancelled.";
    } else if (job?.error) {
      message = `Download failed: ${job.error}`;
    } else if (anyDownloadActive && !job) {
      message = "Another DwarfStar model download is already in progress.";
    } else if (plan.error) {
      message = plan.error;
    } else if (!scriptAvailable) {
      message = "DS4 download_model.sh was not found in the selected checkout.";
    } else if (complete) {
      message = "All selected model files are present.";
    } else if (missingTargets.length === 0) {
      message = "Some files use custom paths and must be downloaded manually.";
    } else {
      message = "Required model files are missing.";
    }
    return {
      preset: plan.preset,
      modelId: plan.modelId,
      modelDisplayName: plan.displayName,
      files,
      complete,
      downloadable,
      downloading,
      currentTarget: progressJob?.currentTarget ?? null,
      completedTargets: progressJob ? [...progressJob.completedTargets] : [],
      startedAt: progressJob?.startedAt ?? null,
      cancelled: job?.cancelled ?? false,
      error: job?.error ?? null,
      output: job?.output ?? "",
      message,
    };
  }

  function appendModelDownloadOutput(
    job: ModelDownloadJob,
    chunk: Buffer | string,
  ): void {
    const text = Buffer.from(chunk).toString("utf8");
    // Keep a tail large enough to diagnose hf/curl failures; the downloader
    // runs detached in the background and this tail is the only visible log.
    job.output = `${job.output}${text}`.slice(-12000);
  }

  function signalModelDownloadProcess(
    job: ModelDownloadJob,
    signal: NodeJS.Signals,
  ): void {
    const child = job.child;
    let signaledProcessGroup = false;
    for (const processGroupId of job.processGroupIds) {
      try {
        // The downloader is detached so the shell and its hf/curl descendants
        // share a process group that can be terminated together. Keep every
        // live group until it is confirmed dead so a successful shell cannot
        // orphan a descendant that is still running.
        process.kill(-processGroupId, signal);
        signaledProcessGroup = true;
      } catch {
        // The group already exited between the checks.
      }
    }
    if (signaledProcessGroup || child?.pid === undefined) return;
    try {
      child.kill(signal);
    } catch {
      // The child already exited between the checks.
    }
  }

  function modelDownloadProcessGroupAlive(processGroupId: number): boolean {
    try {
      process.kill(-processGroupId, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  function pruneModelDownloadProcessGroups(job: ModelDownloadJob): void {
    for (const processGroupId of job.processGroupIds) {
      if (!modelDownloadProcessGroupAlive(processGroupId)) {
        job.processGroupIds.delete(processGroupId);
      }
    }
  }

  function waitForModelDownloadProcessGroups(
    job: ModelDownloadJob,
    timeoutMs: number,
  ): Promise<boolean> {
    return new Promise((resolvePromise) => {
      const deadline = Date.now() + timeoutMs;
      const poll = () => {
        pruneModelDownloadProcessGroups(job);
        if (job.processGroupIds.size === 0) {
          resolvePromise(true);
          return;
        }
        if (Date.now() >= deadline) {
          resolvePromise(false);
          return;
        }
        setTimeout(poll, 100);
      };
      poll();
    });
  }

  function cancelModelDownload(job: ModelDownloadJob): Promise<void> {
    if (job.cancelPromise) return job.cancelPromise;
    job.cancelled = true;
    signalModelDownloadProcess(job, "SIGTERM");
    job.cancelPromise = (async () => {
      const exitedAfterTerm = await waitForModelDownloadProcessGroups(job, 12_000);
      if (!exitedAfterTerm) {
        signalModelDownloadProcess(job, "SIGKILL");
        await waitForModelDownloadProcessGroups(job, 1_000);
      }
    })();
    return job.cancelPromise;
  }

  function runModelDownloadTarget(
    job: ModelDownloadJob,
    target: ModelDownloadTarget,
  ): Promise<void> {
    const script = join(job.ds4Dir, "download_model.sh");
    return new Promise((resolvePromise, reject) => {
      if (job.cancelled) {
        resolvePromise();
        return;
      }
      let settled = false;
      let child: ChildProcess | null = null;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (job.child === child) job.child = null;
        pruneModelDownloadProcessGroups(job);
        if (error) reject(error);
        else resolvePromise();
      };
      try {
        child = spawn(script, [target], {
          cwd: job.ds4Dir,
          env: { ...process.env },
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
        });
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      const activeChild = child;
      if (activeChild === null) {
        finish(new Error("download_model.sh did not start a child process."));
        return;
      }
      job.child = activeChild;
      if (activeChild.pid !== undefined) {
        job.processGroupIds.add(activeChild.pid);
      }
      activeChild.stdout?.on("data", (chunk: Buffer | string) =>
        appendModelDownloadOutput(job, chunk),
      );
      activeChild.stderr?.on("data", (chunk: Buffer | string) =>
        appendModelDownloadOutput(job, chunk),
      );
      activeChild.once("error", (error) =>
        finish(job.cancelled ? undefined : error),
      );
      activeChild.once("close", (code, signal) => {
        if (job.cancelled || code === 0) {
          finish();
        } else {
          finish(new Error(
            `download_model.sh ${target} exited with ${
              signal ? `signal ${signal}` : `code ${code ?? "unknown"}`
            }.`,
          ));
        }
      });
    });
  }

  function startModelDownload(
    cfg: ResolvedRunConfig,
    plan: ModelDownloadPlan,
    targets: ModelDownloadTarget[],
  ): void {
    if (!cfg.ds4Dir || targets.length === 0) return;
    const job: ModelDownloadJob = {
      ds4Dir: cfg.ds4Dir,
      preset: plan.preset,
      targets,
      completedTargets: [],
      currentTarget: null,
      startedAt: Date.now(),
      child: null,
      processGroupIds: new Set(),
      cancelPromise: null,
      cancelled: false,
      output: "",
      error: null,
    };
    modelDownloadJob = job;
    void (async () => {
      try {
        await publishDownloads();
        for (const target of targets) {
          if (job.cancelled) return;
          job.currentTarget = target;
          bb.log.info(`downloading DwarfStar model files: ${target}`);
          await publishDownloads();
          await runModelDownloadTarget(job, target);
          job.completedTargets.push(target);
          await publishDownloads();
        }
      } catch (error) {
        job.error = error instanceof Error ? error.message : String(error);
        bb.log.error(job.error);
      } finally {
        job.currentTarget = null;
        job.child = null;
        await publishDownloads();
      }
    })();
  }

  function configuredProviderModel(): { id: string } {
    // Provider declarations are shared with remote workspace hosts. The
    // server worker must not publish a host-local GGUF path or a family
    // inferred from a symlink that may resolve differently on the target
    // host. A named preset is a portable identity; the bridge resolves the
    // actual file from the target host's settings for turns.
    const preset = normalizeDwarfStarModelPreset(
      String(latestSettings.modelPreset ?? "auto"),
    );
    return {
      id: preset === "auto" ? CONFIGURED_DWARFSTAR_MODEL_ID : preset,
    };
  }

  function providerDeclaration(model = configuredProviderModel()) {
    // Stock Pi behavior with a DS4 lifecycle gate: turns run on BB's
    // provider-pi bridge (pi --mode rpc + BB_PI_EXTENSION); this plugin only
    // owns ds4-server start/stop/idle/health. Capabilities mirror provider-pi.
    return {
      id: DS4_PROVIDER_ID,
      displayName: "DwarfStar",
      icon: "./assets/icon.svg",
      strings: {
        signInHint: "DwarfStar runs locally on this host; configure the DS4 checkout and model in Settings.",
        expiredHint: "DwarfStar is local. Check the DS4 checkout, model path, and server logs.",
        installUrl: "https://github.com/antirez/ds4",
        planModeCopy: "DwarfStar plan mode",
        iconTint: { light: "#6D5DFB", dark: "#6D5DFB" },
      },
      maintenance: { health: true, usage: false, installation: true },
      capabilities: {
        supportsServiceTier: false,
        supportsNativeUserQuestion: false,
        fork: "checkpoint" as const,
        supportsManualCompaction: true,
        supportsThreadArchive: false,
        supportsThreadRename: false,
        permissionModes: ["full" as const],
        reasoningLevels: ["none", "low", "medium", "high", "xhigh", "max"] as const,
      },
      experimental_nativeSkillRoots: {
        user: [".pi/agent/skills", ".agents/skills"],
        project: [".pi/skills", ".agents/skills"],
      },
      reasoningLevels: [
        { id: "none", label: "None" },
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium" },
        { id: "high", label: "High" },
        { id: "xhigh", label: "Extra High" },
        { id: "max", label: "Maximum" },
      ],
      models: {
        scope: "workspace" as const,
        // StockPi clone: advertise DS4 models as dwarfstar/* so Pi can resolve via models.json ds4 provider.
        fallback: [
          dwarfStarProviderModel("dwarfstar/deepseek-v4-flash"),
          dwarfStarProviderModel("dwarfstar/glm-5.3-flash"),
        ],
      },
      composerActions: [] as const,
      experimental_bridgeOptions: {
        configuredModelId: model.id,
      },
      experimental_visibility: "always" as const,
      deriveProviderOptions(context: { settings: Readonly<Record<string, unknown>> }) {
        const s = context.settings;
        return {
          ds4Dir: String(s.ds4Dir ?? ""),
          modelPath: String(s.modelPath ?? ""),
          modelPreset: String(s.modelPreset ?? "auto"),
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

  // Single Pi provider clone with DS4 lifecycle: Pi handles agent turns, this plugin owns ds4-server.
  // Old custom Chat bridge (read/edit/bash only) is replaced by StockPi via host pi-bridge.
  let providerRegistration: { dispose(): void } | null = null;
  try { providerRegistration = bb.providers.register(providerDeclaration()); } catch (e) { bb.log.warn(`ds4 Pi clone register failed: ${String(e)}`); }

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
    if (!regularFileExists(cfg.dsparkSupportPath)) {
      return `DSpark support GGUF not found: ${cfg.dsparkSupportPath}. Run ./download_model.sh ds4f-dspark or set dsparkSupportPath; disable dspark for GLM/PRO or a baseline run.`;
    }
    const supportError = validateDsparkSupportPath(
      cfg.modelPath,
      cfg.dsparkSupportPath,
    );
    if (supportError) return supportError;
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
    const modelId = resolvedDwarfStarModelId(cfg.modelPath);
    if (!modelId || !isDwarfStarVisionModel(modelId)) {
      return `Vision is supported only with DeepSeek V4 Flash Vision Experimental or GLM 5.3 Flash. The configured model path is ${cfg.modelPath ?? "not set"}; select a vision model or disable vision.`;
    }
    if (!regularFileExists(cfg.visionPath)) {
      return `Vision encoder not found: ${cfg.visionPath}. Download the encoder for the selected model or set visionPath to its downloaded path.`;
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
    const settingsDto = {
      idleTimeoutSeconds: latestSettings.idleTimeoutSeconds ?? "300",
      restartOnCrash: s.restartOnCrash,
      maxTokens: s.maxTokens,
    };
    const logDto = { total: proc.logs(0, 1).total, limit: LOG_RING_LIMIT, file: persistentLogPath(bb.pluginId) };
    if (!proc.isRunning) {
      // A bridge-owned server is the same plugin's server; report it instead
      // of claiming stopped while turns are being served.
      const bridged = readBridgeServer(cfg);
      if (bridged) {
        const health = await requestHealth(cfg, bridged.endpoint);
        return {
          state: "running",
          ownership: "managed",
          displayState: healthIsReady(health) ? "ready" : "loading model…",
          pid: bridged.pid,
          startedAt: bridged.startedAt,
          uptimeMs: bridged.startedAt ? Date.now() - bridged.startedAt : 0,
          exitInfo: null,
          health,
          activeEndpoint: bridged.endpoint,
          config: cfg,
          settings: settingsDto,
          lastError,
          log: logDto,
        };
      }
    }
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
      settings: settingsDto,
      lastError,
      log: logDto,
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
    // The provider bridge starts DS4 under its own record key; adopt those
    // servers too so status, health, and idle supervision are unified.
    return reclaimRecord(bb.pluginId) || reclaimRecord(DS4_PROVIDER_BRIDGE_PROCESS_RECORD_ID);
  }

  function reclaimRecord(key: string): boolean {
    const record = readProcessRecord(key);
    if (!record) return false;
    if (record.ownership === "external") return false;
    if (!isProcessAlive(record.pid)) {
      clearProcessRecord(key, record.pid);
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

  /** Read-only view of a bridge-owned server for status display. */
  function readBridgeServer(cfg: ResolvedRunConfig): {
    pid: number;
    startedAt: number | null;
    endpoint: ServerEndpoint;
  } | null {
    const record = readProcessRecord(DS4_PROVIDER_BRIDGE_PROCESS_RECORD_ID);
    if (!record || record.ownership === "external") return null;
    if (!isProcessAlive(record.pid)) return null;
    const observedStart = processStartTime(record.pid);
    if (record.processStartedAt && observedStart && record.processStartedAt !== observedStart) {
      return null;
    }
    if (!processMatchesCommand(record.pid, record.bin, record.args, record.cwd)) return null;
    return {
      pid: record.pid,
      startedAt: record.startedAt ?? null,
      endpoint: record.host && record.port
        ? { host: record.host, port: record.port }
        : { host: cfg.host, port: cfg.port },
    };
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

  type EnsureStartedOptions = {
    onlyIfNoProviderLease?: boolean;
  };

  function startVetoed(options: EnsureStartedOptions): boolean {
    return providerLeaseVetoesStart(
      options.onlyIfNoProviderLease === true,
      hasActiveProviderTurnLease(),
    );
  }

  async function startProc(
    cfg: ResolvedRunConfig,
    options: EnsureStartedOptions = {},
  ): Promise<void> {
    if (disposed || startVetoed(options)) return;
    if (proc.isRunning) return;
    if (!cfg.bin || !existsSync(cfg.bin)) {
      lastError =
        "ds4-server binary not found. Set the DS4 checkout directory in Settings (or put ds4 on PATH).";
      bb.log.error(lastError);
      await publishState();
      return;
    }
    if (cfg.modelPath && !regularFileExists(cfg.modelPath)) {
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
    // A new process gets a fresh idle baseline. This also prevents an old
    // orphan/release timestamp from stopping a later demand immediately.
    lastDemandAt = Date.now();
    const startLogSeq = proc.logs(0, LOG_RING_LIMIT).nextOffset;
    lastStartLogSeq = startLogSeq;
    let managedPid: number | null = null;
    // Keep this check adjacent to the synchronous spawn. The supervisor may
    // have yielded before reaching this function while a provider lease began.
    if (startVetoed(options)) {
      activeEndpoint = null;
      lastHealth = null;
      return;
    }
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
  async function ensureStarted(
    cfg?: ResolvedRunConfig,
    options: EnsureStartedOptions = {},
  ): Promise<void> {
    if (disposed || startVetoed(options)) return;
    if (stopWaitPromise) {
      await stopWaitPromise;
      return ensureStarted(cfg, options);
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
      return ensureStarted(cfg, options);
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
      if (startVetoed(options)) return;
      if (await recoverExistingServer(resolved, { isCurrent })) return;
      if (!isCurrent()) return;
      // Another demand callback may have recovered or started the process
      // while the recovery check was awaiting health.
      if (startVetoed(options)) return;
      if (proc.isRunning) return;
      if (reclaimRecordedProcess()) {
        bb.log.info("stopping the previous managed ds4-server before applying new settings");
        await stopProc({ cancelPendingStart: false });
      }
      if (!isCurrent() || startVetoed(options)) return;
      await startProc(resolved, options);
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
          if (
            !orphanCleanupDone &&
            !hasStopDemand &&
            proc.state === "stopped" &&
            orphanCleanupIsDue(lastDemandAt, Date.now(), idleTimeoutMs())
          ) {
            const recovered =
              (await recoverExistingServer(cfg, {
                allowExternal: false,
                isCurrent: () => !disposed && !shuttingDown && !signal.aborted,
              })) ||
              reclaimRecordedProcess();
            if (!recovered) {
              // The scan completed and found no managed orphan to clean.
              orphanCleanupDone = true;
            } else if (!hasStopVeto()) {
              const stopped = await stopProc({ onlyIfNoDemand: true });
              if (stopped) {
                // Keep the demand/release anchor. If another native demand
                // starts this process later, startProc resets it at spawn.
                orphanCleanupDone = true;
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
            await ensureStarted(cfg, { onlyIfNoProviderLease: true });
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
              await ensureStarted(cfg, { onlyIfNoProviderLease: true });
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
      const configuredModelId = primaryModelId(cfg);
      const results = applyTargets(targets as AgentTargetId[], {
        port: cfg.port,
        ctx: cfg.ctx,
        maxTokens: cfg.maxTokens,
        modelId: wireDwarfStarModelId(configuredModelId),
        modelIds: advertisedIds(cfg).map(wireDwarfStarModelId),
        modelDisplayId: configuredModelId,
        vision: visionEnabled(cfg),
      });
      for (const r of results) {
        if (r.ok) bb.log.info(`agent config written: ${r.message}`);
        else bb.log.error(`agent config failed: ${r.message}`);
      }
      return { results };
    },
    async modelFiles() {
      return modelFilesStatusForConfig(await currentConfig());
    },
    async installedModels() {
      return installedModelsStatus(await currentConfig());
    },
    async downloadModels() {
      const cfg = await currentConfig();
      const before = modelFilesStatusForConfig(cfg);
      if (!before.downloadable) return before;
      const targets = before.files
        .filter(
          (file) =>
            file.downloadTarget !== null && file.state !== "present",
        )
        .map((file) => file.downloadTarget as ModelDownloadTarget)
        .filter((target, index, all) => all.indexOf(target) === index);
      const plan = modelDownloadPlanForConfig(cfg);
      startModelDownload(cfg, plan, targets);
      return modelFilesStatusForConfig(cfg);
    },
    async cancelDownload() {
      const job = modelDownloadJob;
      if (job) {
        await cancelModelDownload(job);
        bb.log.info("model download cancelled by user");
        await publishDownloads();
      }
      return modelFilesStatusForConfig(await currentConfig());
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
            ? "The adopted external ds4-server was not started with the configured vision encoder. Restart it with --vision or stop it so the plugin can start the configured server."
            : "Image input is unavailable because the ds4-server is not configured with the selected model's vision encoder.")
        : "Image input is disabled. Set visionPath to auto and download the encoder for the selected model, or set it to the encoder path.";
      throw new Error(visionError);
    }
    const requestBody = serializeDwarfStarChatRequest(
      buildDwarfStarChatRequest(
        wireDwarfStarModelId(primaryModelId(cfg)),
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
      { name: "download", summary: "Download selected model files", usage: "bb ds4 download" },
      { name: "download-cancel", summary: "Cancel a running model download", usage: "bb ds4 download-cancel" },
      { name: "download-log", summary: "Show the model download log tail", usage: "bb ds4 download-log" },
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
            const configuredModelId = primaryModelId(cfg);
            const results = applyTargets(targets, {
              port: cfg.port,
              ctx: cfg.ctx,
              maxTokens: cfg.maxTokens,
              modelId: wireDwarfStarModelId(configuredModelId),
              modelIds: advertisedIds(cfg).map(wireDwarfStarModelId),
              modelDisplayId: configuredModelId,
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
        case "download": {
          const cfg = await currentConfig();
          const before = modelFilesStatusForConfig(cfg);
          if (!before.downloadable) {
            return { exitCode: 1, stdout: before.message };
          }
          const targets = before.files
            .filter((file) => file.downloadTarget !== null && file.state !== "present")
            .map((file) => file.downloadTarget as ModelDownloadTarget)
            .filter((target, index, all) => all.indexOf(target) === index);
          const plan = modelDownloadPlanForConfig(cfg);
          startModelDownload(cfg, plan, targets);
          return { exitCode: 0, stdout: `Download started: ${targets.join(", ")}. Watch with \`bb ds4 download-log\`.` };
        }
        case "download-cancel": {
          const job = modelDownloadJob;
          if (!job) return { exitCode: 0, stdout: "No model download is running." };
          await cancelModelDownload(job);
          await publishDownloads();
          return { exitCode: 0, stdout: "Download cancelled." };
        }
        case "download-log": {
          const st = modelFilesStatusForConfig(await currentConfig());
          const head = [
            `preset:   ${st.preset}`,
            `state:    ${st.downloading ? `downloading ${st.currentTarget ?? ""}` : st.cancelled ? "cancelled" : st.error ? "failed" : st.complete ? "complete" : "idle"}`,
            ...(st.error ? [`error:     ${st.error}`] : []),
          ].join("\n");
          const tail = st.output ? `\n--- log tail ---\n${st.output}` : "\n(no download output yet)";
          return { exitCode: 0, stdout: `${head}${tail}` };
        }
        default:
          return {
            exitCode: 1,
            stdout: "Usage: bb ds4 <status|start|stop|restart|logs|download|download-cancel|download-log|agents|agent|complete>",
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
      "Run a one-shot text or image completion on the local DS4 (DwarfStar) OpenAI-compatible server. Pass inline PNG/JPEG data URIs in imageUrls when the selected vision model's encoder is configured. Fails if the server is not ready.",
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

  // Stock Pi turns bring their own tools. This plugin only contributes the
  // ds4_status / ds4_complete diagnostics above, and selects none of its own
  // tools into turns (Pi's read/write/edit/bash win).
  bb.agents.configure(() => ({
    tools: [],
    skills: [],
  }));

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
      (next.modelPreset ?? "auto") !== (prev.modelPreset ?? "auto") ||
      (next.ds4Dir ?? "") !== (prev.ds4Dir ?? "")
    ) {
      try { providerRegistration?.dispose(); providerRegistration = bb.providers.register(providerDeclaration()); } catch (e) { bb.log.error(`could not refresh ds4 Pi clone: ${String(e)}`); }
    }
  });

  bb.onDispose(async () => {
    disposed = true;
    shuttingDown = true;
    lifecycleEpoch += 1;
    providerRegistration?.dispose();
    const downloadJob = modelDownloadJob;
    modelDownloadJob = null;
    if (downloadJob) await cancelModelDownload(downloadJob);
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
