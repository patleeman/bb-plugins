import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  BRIDGE_INBOUND_REQUEST_METHODS,
  BRIDGE_JSON_RPC_ERRORS,
  BRIDGE_NOTIFICATION_METHODS,
  BRIDGE_REQUEST_METHODS,
  PROVIDER_BRIDGE_PROTOCOL_VERSION,
  THREAD_DELTA_GRAMMAR_V3,
  THREAD_DELTA_NOTIFICATION_METHOD,
  createBridgeIo,
  createBridgeLineHandler,
  decodeToolCallResponsePayload,
  experimental_defineProviderBridge,
  experimental_toolPresentation,
  initializeParamsSchema,
  modelListParamsSchema,
  mimeTypeFromExtension,
  providerMaintenanceParamsSchema,
  runBridgeRequest,
  threadArchiveParamsSchema,
  threadDiscardParamsSchema,
  threadGoalClearParamsSchema,
  threadNameSetParamsSchema,
  threadResumeParamsSchema,
  threadStartParamsSchema,
  threadStopParamsSchema,
  threadUnarchiveParamsSchema,
  turnStartParamsSchema,
  turnSteerParamsSchema,
  type AvailableModel,
  type ClientTurnRequestId,
  type DynamicTool,
  type PromptInput,
  type ProviderHealthResult,
  type ThreadDelta,
} from "@get-bb/plugin-sdk/provider-bridge";
import {
  completionPayloadSizeError,
  completionRequestBodySizeError,
} from "./request-payload.ts";
import {
  clearProviderTurnLease,
  clearProcessRecord,
  isProcessAlive,
  processMatchesCommand,
  processStartTime,
  processWorkingDirectory,
  PROVIDER_TURN_LEASE_RELEASE_RETENTION_MS,
  readProcessRecord,
  readProviderTurnLease,
  writeProviderTurnLease,
  writeProcessRecord,
} from "./process-recovery.ts";
import {
  DEFAULT_DWARFSTAR_CONTEXT_TOKENS,
  dwarfStarVisionArgsError,
  dwarfStarVisionBackendError,
  dwarfStarVisionExtraArgsError,
  resolveConfig,
  resolvedDwarfStarModelId,
  validateDsparkModelPath,
  validateDsparkSupportPath,
  type ResolvedRunConfig,
  type RunSettings,
} from "./run-config.ts";
import { Ds4Process } from "./ds4-process.ts";
import {
  CONFIGURED_DWARFSTAR_MODEL_ID,
  canonicalModelId,
  inferDwarfStarModelId,
  isDwarfStarModel,
  isDwarfStarVisionModel,
  wireDwarfStarModelId,
  type CanonicalDwarfStarModelId,
} from "./model-selection.ts";
import { isUsableModelFile } from "./model-download.ts";

const BRIDGE_PLUGIN_ID = "ds4";
// The server worker has its own legacy supervisor and uses the `ds4` process
// record. Keep the host bridge's record separate so the supervisor cannot
// mistake a provider-owned process for an idle legacy process and stop it.
const BRIDGE_PROCESS_RECORD_ID = "ds4-provider-bridge";
const STARTUP_TIMEOUT_MS = 10 * 60 * 1000;
const STARTUP_POLL_MS = 500;
const COMPLETION_TIMEOUT_MS = 30 * 60 * 1000;
const TOOL_CALL_TIMEOUT_MS = 10 * 60 * 1000;
const STOP_WAIT_TIMEOUT_MS = 5_000;
const PROVIDER_TURN_LEASE_TTL_MS = 15_000;
const PROVIDER_TURN_LEASE_HEARTBEAT_MS = 5_000;
const MAX_TOOL_RESULT_BYTES = 256 * 1024;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_IMAGE_COUNT = 16;
const MAX_SESSION_BYTES = 64 * 1024 * 1024;
const PLAN_INSTRUCTION = "Work in plan mode. Explain the plan before changing files.";

const DWARFSTAR_STARTUP_PRESENTATION = {
  label: { pending: "Starting DwarfStar", completed: "DwarfStar ready" },
  icon: { glyph: "Zap" },
};

type JsonRpcId = string | number;

type DwarfStarTextPart = { type: "text"; text: string };
type DwarfStarImagePart = {
  type: "image_url";
  image_url: { url: string };
};
type DwarfStarMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | Array<DwarfStarTextPart | DwarfStarImagePart> | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: DwarfStarToolCall[];
  reasoning_content?: string;
};
type DwarfStarToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type DwarfStarOptions = {
  model?: string;
  promptMode?: "plan" | null;
  reasoningLevel?: string;
  instructions?: string;
  ds4Dir: string;
  modelPath: string;
  modelPreset: string;
  visionPath: string;
  backend: RunSettings["backend"];
  host: string;
  port: string;
  ctx: string;
  maxTokens: string;
  kvDiskDir: string;
  kvDiskSpaceMb: string;
  power: string;
  extraArgs: string;
  dspark: boolean;
  dsparkSupportPath: string;
  dsparkConfidence: string;
  idleTimeoutSeconds: string;
};

const dwarfStarOptionsSchema = z
  .object({
    model: z.string().optional(),
    promptMode: z.union([z.literal("plan"), z.null()]).optional(),
    reasoningLevel: z.string().optional(),
    instructions: z.string().optional(),
    ds4Dir: z.string().default(""),
    modelPath: z.string().default(""),
    modelPreset: z.string().default("auto"),
    visionPath: z.string().default("auto"),
    backend: z.enum(["auto", "metal", "cuda", "rocm", "cpu"]).default("auto"),
    host: z.string().default("127.0.0.1"),
    port: z.string().default("8000"),
    ctx: z.string().default(String(DEFAULT_DWARFSTAR_CONTEXT_TOKENS)),
    maxTokens: z.string().default("384000"),
    kvDiskDir: z.string().default("/tmp/ds4-kv"),
    kvDiskSpaceMb: z.string().default("8192"),
    power: z.string().default(""),
    extraArgs: z.string().default(""),
    dspark: z.boolean().default(false),
    dsparkSupportPath: z.string().default(""),
    dsparkConfidence: z.string().default(""),
    idleTimeoutSeconds: z.string().default("300"),
  })
  .passthrough();

interface Session {
  threadId: string;
  providerThreadId: string;
  cwd: string;
  instructions: string | undefined;
  instructionMode: "append" | "replace";
  tools: Map<string, DynamicTool>;
  disallowedTools: Set<string>;
  messages: DwarfStarMessage[];
  usageTotal: TokenUsage;
  idleTimeoutSeconds: string;
  queuedTurns: QueuedTurn[];
  turn: TurnState | null;
  closed: boolean;
  restorable: boolean;
}

interface QueuedTurn {
  input: DwarfStarMessage;
  options: DwarfStarOptions;
  model: string | undefined;
  clientRequestId: ClientTurnRequestId;
}

interface TurnState {
  id: string;
  controller: AbortController;
  pendingToolCalls: Set<string>;
  openItems: Map<string, OpenStreamItem>;
  startupNotice: StartupNotice | null;
  done: Promise<void>;
  resolveDone: () => void;
  boundarySent: boolean;
  settled: boolean;
}

interface StartupNotice {
  key: { providerItemId: string };
  model: string;
}

interface OpenStreamItem {
  key: { providerItemId: string };
  channel: "agentMessage" | "reasoningText";
  text: () => string;
  item: () => Extract<ThreadDelta, { kind: "item.close" }>["item"];
}

interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

interface ToolCallResult {
  content: string;
  images: string[];
  isError: boolean;
}

interface CompletionResult {
  assistant: DwarfStarMessage;
  toolCalls: DwarfStarToolCall[];
  usage: TokenUsage | null;
}

const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
};

const io = createBridgeIo<Record<string, unknown>>();
const sessions = new Map<string, Session>();
const ds4Process = new Ds4Process(2000);
let bridgeDataDir: string | null = null;
let activeConfigFingerprint: string | null = null;
let activeEndpoint: { host: string; port: number } | null = null;
interface ReadyState {
  cfg: ResolvedRunConfig;
  endpoint: { host: string; port: number };
  fingerprint: string;
  processBacked: boolean;
  processIdentity?: DwarfStarProcessIdentity;
}

export interface DwarfStarProcessIdentity {
  pid: number;
  bin: string;
  args: string[];
  cwd: string;
  processStartedAt?: string;
}

interface ReadyLease extends ReadyState {
  release: () => void;
}

let activeReady: ReadyState | null = null;
interface ReadinessEntry {
  fingerprint: string;
  promise: Promise<ReadyState>;
  controller: AbortController;
  consumers: number;
}

let readiness: ReadinessEntry | null = null;
let readinessController: AbortController | null = null;
let activeReadyLeases = 0;
const leaseWaiters = new Set<() => void>();
let idleTimer: NodeJS.Timeout | null = null;
let providerTurnLeaseCount = 0;
let providerTurnLeaseTimer: NodeJS.Timeout | null = null;
let providerTurnLeaseReleaseTimer: NodeJS.Timeout | null = null;
const providerTurnLeaseId = `${process.pid}-${randomUUID()}`;
const providerTurnLeaseProcessStartedAt = processStartTime(process.pid) ?? undefined;
let requestCounter = 0;
let threadCounter = 0;
let disposed = false;

interface PersistedSession {
  threadId: string;
  providerThreadId: string;
  cwd: string;
  instructions?: string;
  instructionMode: "append" | "replace";
  messages: DwarfStarMessage[];
  usageTotal: TokenUsage;
  queuedTurns?: QueuedTurn[];
}

function sessionFilePath(threadId: string): string {
  const dataDir = bridgeDataDir ?? join(homedir(), ".bb", "plugins", BRIDGE_PLUGIN_ID);
  const id = createHash("sha256").update(threadId).digest("hex");
  return join(dataDir, "sessions", `${id}.json`);
}

function persistSession(session: Session): boolean {
  const path = sessionFilePath(session.threadId);
  try {
    const value: PersistedSession = {
      threadId: session.threadId,
      providerThreadId: session.providerThreadId,
      cwd: session.cwd,
      ...(session.instructions === undefined ? {} : { instructions: session.instructions }),
      instructionMode: session.instructionMode,
      messages: session.messages,
      usageTotal: session.usageTotal,
      queuedTurns: session.queuedTurns,
    };
    const serialized = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_SESSION_BYTES) {
      try {
        unlinkSync(path);
      } catch {
        // A missing snapshot is already the desired state.
      }
      return false;
    }
    mkdirSync(dirname(path), { recursive: true });
    const temporaryPath = `${path}.tmp-${process.pid}`;
    writeFileSync(temporaryPath, serialized, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, path);
    return true;
  } catch {
    return false;
  }
}

function persistSessionAndUpdate(session: Session): boolean {
  const restorable = persistSession(session);
  if (restorable !== session.restorable) {
    session.restorable = restorable;
    notify(BRIDGE_NOTIFICATION_METHODS.threadIdentity, {
      threadId: session.threadId,
      providerThreadId: session.providerThreadId,
      sessionRestorable: restorable,
    });
  }
  return restorable;
}

function loadPersistedSession(threadId: string, providerThreadId: string): PersistedSession | null {
  const path = sessionFilePath(threadId);
  try {
    if (!existsSync(path) || statSync(path).size > MAX_SESSION_BYTES) return null;
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<PersistedSession>;
    if (
      value.threadId !== threadId ||
      value.providerThreadId !== providerThreadId ||
      typeof value.cwd !== "string" ||
      (value.instructionMode !== "append" && value.instructionMode !== "replace") ||
      !Array.isArray(value.messages) ||
      value.usageTotal === null ||
      typeof value.usageTotal !== "object" ||
      (value.queuedTurns !== undefined && !Array.isArray(value.queuedTurns))
    ) {
      return null;
    }
    return {
      ...(value as PersistedSession),
      queuedTurns: Array.isArray(value.queuedTurns) ? value.queuedTurns : [],
    };
  } catch {
    return null;
  }
}

function notify(method: string, params: Record<string, unknown>): void {
  io.send({ jsonrpc: "2.0", method, params });
}

function sendDeltas(threadId: string, deltas: readonly ThreadDelta[]): void {
  if (deltas.length === 0) return;
  io.send({
    jsonrpc: "2.0",
    method: THREAD_DELTA_NOTIFICATION_METHOD,
    params: { threadId, deltas: [...deltas] },
  });
}

function startupModelLabel(model: string | undefined): string {
  switch (canonicalModelId(model ?? "")) {
    case "deepseek-v4-flash":
      return "DeepSeek V4 Flash";
    case "deepseek-v4-flash-vision-exp":
      return "DeepSeek V4 Flash Vision Experimental";
    case "deepseek-v4-pro":
      return "DeepSeek V4 Pro";
    case "glm-5.2":
      return "GLM 5.2";
    case "glm-5.3-flash":
      return "GLM 5.3 Flash";
    default:
      return model?.trim() ?? "configured model";
  }
}

export function dwarfStarStartupNoticeDeltas(
  providerTurnId: string,
  model: string | undefined,
  phase: "open" | "progress" | "close",
  detail = "",
  status: "completed" | "failed" | "interrupted" = "completed",
): ThreadDelta[] {
  const modelId = startupModelLabel(model);
  const key = { providerItemId: `${providerTurnId}-dwarfstar-startup` };
  const item = {
    type: "tool" as const,
    tool: "DwarfStar",
    server: "ds4",
    args: { phase: "startup", model: modelId },
  };
  if (phase === "open") {
    return [{
      kind: "item.open",
      key,
      item,
      presentation: DWARFSTAR_STARTUP_PRESENTATION,
      providerTurnId,
    }];
  }
  if (phase === "progress") {
    return [{
      kind: "item.progress",
      key,
      message: detail,
      flush: true,
      providerTurnId,
    }];
  }
  return [{
    kind: "item.close",
    key,
    status,
    item: {
      ...item,
      ...(status === "completed" ? { result: detail } : { error: detail }),
    },
    resultText: detail,
    presentation: DWARFSTAR_STARTUP_PRESENTATION,
    providerTurnId,
  }];
}

function emitDwarfStarStartupNotice(
  session: Session,
  turn: TurnState,
  model: string | undefined,
  message: string,
): void {
  if (session.closed || session.turn !== turn) return;
  const modelId = startupModelLabel(model);
  if (turn.startupNotice === null) {
    const key = { providerItemId: `${turn.id}-dwarfstar-startup` };
    turn.startupNotice = { key, model: modelId };
    sendDeltas(session.threadId, dwarfStarStartupNoticeDeltas(turn.id, modelId, "open"));
  }
  sendDeltas(session.threadId, dwarfStarStartupNoticeDeltas(turn.id, turn.startupNotice.model, "progress", message));
}

function closeDwarfStarStartupNotice(
  session: Session,
  turn: TurnState,
  status: "completed" | "failed" | "interrupted",
  detail: string,
): void {
  const notice = turn.startupNotice;
  if (notice === null) return;
  turn.startupNotice = null;
  if (session.closed || session.turn !== turn) return;
  sendDeltas(session.threadId, dwarfStarStartupNoticeDeltas(turn.id, notice.model, "close", detail, status));
}

function invalidParams(id: JsonRpcId, method: string, issues: unknown): void {
  io.sendError(
    id,
    BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
    `Invalid params for ${method}: ${typeof issues === "string" ? issues : JSON.stringify(issues)}`,
  );
}

function optionRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseOptions(value: unknown, model: string | undefined): DwarfStarOptions {
  const parsed = dwarfStarOptionsSchema.safeParse(value);
  const defaults: DwarfStarOptions = {
    ds4Dir: "",
    modelPath: "",
    modelPreset: "auto",
    visionPath: "auto",
    backend: "auto",
    host: "127.0.0.1",
    port: "8000",
    ctx: String(DEFAULT_DWARFSTAR_CONTEXT_TOKENS),
    maxTokens: "384000",
    kvDiskDir: "/tmp/ds4-kv",
    kvDiskSpaceMb: "8192",
    power: "",
    extraArgs: "",
    dspark: false,
    dsparkSupportPath: "",
    dsparkConfidence: "",
    idleTimeoutSeconds: "300",
  };
  if (!parsed.success) return { ...defaults, model };
  return { ...defaults, ...parsed.data, model: model ?? parsed.data.model };
}

function parseExecutionOptions(value: unknown): DwarfStarOptions {
  const record = optionRecord(value);
  const options = parseOptions(
    record.providerOptions,
    typeof record.model === "string" ? record.model : undefined,
  );
  return {
    ...options,
    ...(record.reasoningLevel === undefined
      ? {}
      : { reasoningLevel: String(record.reasoningLevel) }),
    ...(record.promptMode === "plan" ? { promptMode: "plan" as const } : {}),
    ...(typeof record.instructions === "string"
      ? { instructions: record.instructions }
      : {}),
  };
}

function settingsForOptions(options: DwarfStarOptions, model: string | undefined): RunSettings {
  // DwarfStar loads exactly one GGUF per process. The provider model picker
  // is only a display identity; the settings-selected preset/path determines
  // which downloaded file is loaded.
  void model;
  return {
    ds4Dir: options.ds4Dir,
    modelPath: options.modelPath,
    modelPreset: options.modelPreset,
    visionPath: options.visionPath,
    backend: options.backend,
    host: options.host,
    port: options.port,
    ctx: options.ctx,
    maxTokens: options.maxTokens,
    kvDiskDir: options.kvDiskDir,
    kvDiskSpaceMb: options.kvDiskSpaceMb,
    power: options.power,
    extraArgs: options.extraArgs,
    dspark: options.dspark,
    dsparkSupportPath: options.dsparkSupportPath,
    dsparkConfidence: options.dsparkConfidence,
    restartOnCrash: true,
  };
}

function resolveBridgeConfig(options: DwarfStarOptions, model: string | undefined): ResolvedRunConfig {
  return resolveConfig(settingsForOptions(options, model));
}

function configError(
  cfg: ResolvedRunConfig,
  requestedModel?: string,
  visionRequested = false,
): string | null {
  if (!cfg.bin || !cfg.ds4Dir) {
    return "DwarfStar is not installed. Set the DS4 checkout directory in the DwarfStar plugin settings.";
  }
  if (!existsSync(cfg.bin)) return `ds4-server was not found at ${cfg.bin}.`;
  if (!cfg.modelPath) return "No DwarfStar model GGUF was found. Set modelPath or download a supported model.";
  if (!isUsableModelFile(cfg.modelPath)) return `Model not found: ${cfg.modelPath}.`;
  // The settings-selected GGUF is authoritative. Ignore a stale model id
  // from a picker or restored session rather than trying to switch files.
  void requestedModel;
  if (visionRequested && !cfg.visionPath) {
    return "Image input requires a vision encoder for the selected model. Set visionPath or install the standard encoder beside DS4.";
  }
  if (cfg.visionPath) {
    const extraArgsError = dwarfStarVisionExtraArgsError(cfg.extraArgs, cfg.visionPath);
    if (extraArgsError) return extraArgsError;
    const argsError = dwarfStarVisionArgsError(cfg.args, cfg.visionPath);
    if (argsError) return argsError;
    const backendError = dwarfStarVisionBackendError(cfg.backend, cfg.visionPath);
    if (backendError) return backendError;
    const modelId = resolvedDwarfStarModelId(cfg.modelPath);
    if (!modelId || !isDwarfStarVisionModel(modelId)) {
      return "Vision requires a DeepSeek V4 Flash Vision Experimental or GLM 5.3 Flash model GGUF.";
    }
    if (!isUsableModelFile(cfg.visionPath)) return `Vision encoder not found: ${cfg.visionPath}.`;
  }
  if (cfg.dspark) {
    const dsparkModelError = validateDsparkModelPath(cfg.modelPath);
    if (dsparkModelError) return dsparkModelError;
  }
  if (cfg.dspark && !cfg.dsparkSupportPath) {
    return "DSpark is enabled but its support GGUF could not be resolved.";
  }
  if (cfg.dspark && cfg.dsparkSupportPath && !isUsableModelFile(cfg.dsparkSupportPath)) {
    return `DSpark support GGUF not found: ${cfg.dsparkSupportPath}.`;
  }
  if (cfg.dspark) {
    const supportError = validateDsparkSupportPath(
      cfg.modelPath,
      cfg.dsparkSupportPath,
    );
    if (supportError) return supportError;
  }
  return null;
}

function endpointFor(cfg: ResolvedRunConfig): { host: string; port: number } {
  return effectiveDwarfStarEndpoint(cfg.args, { host: cfg.host, port: cfg.port });
}

function abortOrphanedReadiness(entry: ReadinessEntry): void {
  if (entry.consumers > 0 || readiness !== entry) return;
  readiness = null;
  if (readinessController === entry.controller) readinessController = null;
  entry.controller.abort();
}

async function awaitReadiness(
  entry: ReadinessEntry,
  signal: AbortSignal,
): Promise<ReadyState> {
  entry.consumers += 1;
  try {
    return await awaitWithSignal(entry.promise, signal);
  } finally {
    entry.consumers = Math.max(0, entry.consumers - 1);
    abortOrphanedReadiness(entry);
  }
}

export function effectiveDwarfStarEndpoint(
  args: readonly string[],
  fallback: { host: string; port: number },
): { host: string; port: number } {
  return {
    host: lastArgValue(args, "--host") ?? fallback.host,
    port: parsePositivePort(lastArgValue(args, "--port"), fallback.port),
  };
}

function lastArgValue(args: readonly string[], flag: string): string | undefined {
  for (let index = args.length - 1; index >= 0; index -= 1) {
    const arg = args[index];
    if (arg === flag) return args[index + 1];
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  }
  return undefined;
}

function parsePositivePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const port = Number.parseInt(value, 10);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : fallback;
}

function endpointUrl(endpoint: { host: string; port: number }, path: string): string {
  return `http://${endpoint.host}:${endpoint.port}/v1${path}`;
}

function combinedSignal(signal: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}

export interface DwarfStarModelInfo {
  id: string;
  name?: string;
}

async function requestModels(
  endpoint: { host: string; port: number },
  signal: AbortSignal,
): Promise<DwarfStarModelInfo[]> {
  const response = await fetch(endpointUrl(endpoint, "/models"), {
    signal: combinedSignal(signal, 2500),
  });
  if (!response.ok) throw new Error(`DwarfStar health returned HTTP ${response.status}.`);
  const body = (await response.json()) as { data?: Array<{ id?: unknown }> };
  if (!Array.isArray(body.data)) return [];
  const rawModels = body.data.flatMap((item) =>
    typeof item.id === "string"
      ? [{
          id: item.id,
          name: typeof (item as { name?: unknown }).name === "string"
            ? (item as { name: string }).name
            : undefined,
        }]
      : [],
  );
  const normalizedIds = normalizeDwarfStarModelIds(rawModels);
  return rawModels.map((model, index) => ({
    id: normalizedIds[index] ?? model.id,
    ...(model.name ? { name: model.name } : {}),
  }));
}

/**
 * DS4's GLM 5.3 runtime briefly shipped a discovery response with GLM 5.2
 * wire aliases (`glm-5.2*`) but a GLM 5.3 display name. Keep that known
 * server bug at the bridge boundary so readiness does not wait forever.
 * Remove this shim once upstream /v1/models emits the 5.3 ids.
 */
export function normalizeDwarfStarModelIds(
  models: readonly { id: string; name?: string }[],
): string[] {
  const isLegacyGlm53Response = models.some((model) =>
    /glm[\s-]*5\.3(?:[\s-]*flash)?/iu.test(model.name ?? ""),
  );
  return models.map(({ id }) => {
    if (!isLegacyGlm53Response) return id;
    return id.replace(
      /(^|[/])glm-5\.2(?=$|[-_])/iu,
      "$1glm-5.3-flash",
    );
  });
}

function looksLikeDwarfStar(models: readonly DwarfStarModelInfo[]): boolean {
  return models.some((model) => isDwarfStarModel(model.id));
}

function modelFamilyFromName(name: string | undefined): CanonicalDwarfStarModelId | null {
  const normalized = name?.trim().toLowerCase() ?? "";
  if (
    /deepseek[\s_-]*v4[\s_-]*flash[\s_-]*vision[\s_-]*(?:exp|experimental)/u.test(
      normalized,
    )
  ) {
    return "deepseek-v4-flash-vision-exp";
  }
  if (/deepseek[\s_-]*v4[\s_-]*pro/u.test(normalized)) return "deepseek-v4-pro";
  if (/deepseek[\s_-]*v4[\s_-]*flash/u.test(normalized)) return "deepseek-v4-flash";
  if (/glm[\s_-]*5\.3(?:[\s_-]*flash)?/u.test(normalized)) return "glm-5.3-flash";
  if (/glm[\s_-]*5\.2/u.test(normalized)) return "glm-5.2";
  return null;
}

function modelIdForRequest(
  _options: DwarfStarOptions,
  _model: string | undefined,
  cfg: ResolvedRunConfig,
): CanonicalDwarfStarModelId | null {
  // Readiness must identify the GGUF selected in settings, never the model
  // picker value. DwarfStar exposes aliases for the one engine it loaded.
  return resolvedDwarfStarModelId(cfg.modelPath);
}

export function modelsMatchRequest(
  models: readonly DwarfStarModelInfo[],
  requestedModel: CanonicalDwarfStarModelId | null,
  allowUnknownModel = false,
  allowVisionExperimentalFlashAlias = false,
): boolean {
  if (models.length === 0) return false;
  if (!looksLikeDwarfStar(models)) return false;
  if (requestedModel === null) return allowUnknownModel;
  const modelIds = models.map((model) => canonicalModelId(model.id));
  const describedFamilies = new Set(
    models
      .map((model) => modelFamilyFromName(model.name))
      .filter((model): model is CanonicalDwarfStarModelId => model !== null),
  );
  // Older DS4 builds expose the Vision-Exp checkpoint with the generic Flash
  // name and aliases. When the configured process has a vision sidecar, the
  // configured model path is authoritative and this is a safe compatibility
  // shim for those servers.
  if (
    allowVisionExperimentalFlashAlias &&
    requestedModel === "deepseek-v4-flash-vision-exp" &&
    !describedFamilies.has("deepseek-v4-flash-vision-exp") &&
    !describedFamilies.has("deepseek-v4-pro") &&
    modelIds.includes("deepseek-v4-flash")
  ) {
    return true;
  }
  if (describedFamilies.size > 0) return describedFamilies.has(requestedModel);
  // DS4 advertises both DeepSeek aliases regardless of the loaded GGUF. If
  // metadata is unavailable, an ambiguous list must not make a Pro request
  // look ready when Flash is actually loaded (or vice versa).
  const hasDeepSeekFlash = modelIds.includes("deepseek-v4-flash");
  const hasDeepSeekPro = modelIds.includes("deepseek-v4-pro");
  if (hasDeepSeekFlash && hasDeepSeekPro) return false;
  return modelIds.includes(requestedModel);
}

export function dwarfStarProcessIdentityMatches(
  identity: DwarfStarProcessIdentity,
  observers: {
    isAlive?: typeof isProcessAlive;
    matchesCommand?: typeof processMatchesCommand;
    startTime?: typeof processStartTime;
  } = {},
): boolean {
  const isAlive = observers.isAlive ?? isProcessAlive;
  const matchesCommand = observers.matchesCommand ?? processMatchesCommand;
  const startTime = observers.startTime ?? processStartTime;
  if (!isAlive(identity.pid)) return false;
  if (!matchesCommand(identity.pid, identity.bin, identity.args, identity.cwd)) return false;
  const observedStart = startTime(identity.pid);
  return !identity.processStartedAt || !observedStart || observedStart === identity.processStartedAt;
}

function currentDwarfStarProcessIdentity(): DwarfStarProcessIdentity | undefined {
  const pid = ds4Process.pid;
  const cmdline = ds4Process.cmdline;
  const cwd = ds4Process.cwd;
  if (pid === null || !cmdline?.[0] || !cwd) return undefined;
  return {
    pid,
    bin: cmdline[0],
    args: cmdline.slice(1),
    cwd,
    processStartedAt: processStartTime(pid) ?? undefined,
  };
}

function readyProcessIsCurrent(ready: ReadyState): boolean {
  return !ready.processBacked ||
    (ready.processIdentity !== undefined &&
      dwarfStarProcessIdentityMatches(ready.processIdentity));
}

function readyState(
  cfg: ResolvedRunConfig,
  endpoint: { host: string; port: number },
  processBacked: boolean,
): ReadyState {
  const processIdentity = processBacked ? currentDwarfStarProcessIdentity() : undefined;
  return {
    cfg,
    endpoint,
    fingerprint: cfg.fingerprint,
    processBacked,
    ...(processIdentity ? { processIdentity } : {}),
  };
}

function invalidateReadyState(ready: ReadyState): void {
  if (activeReady === ready) activeReady = null;
  if (activeConfigFingerprint === ready.fingerprint) {
    activeConfigFingerprint = null;
    activeEndpoint = null;
  }
  if (
    ready.processIdentity &&
    ds4Process.isAdopted &&
    ds4Process.pid === ready.processIdentity.pid
  ) {
    // The adopted handle has no exit event. Forget it before probing the
    // endpoint again so a replaced PID cannot retain bridge ownership.
    ds4Process.detachAdopted("exited");
  }
}

async function adoptRecordedProcess(cfg: ResolvedRunConfig): Promise<boolean> {
  const record = readProcessRecord(BRIDGE_PROCESS_RECORD_ID);
  if (
    !record ||
    record.fingerprint !== cfg.fingerprint ||
    !isProcessAlive(record.pid) ||
    !processMatchesCommand(record.pid, record.bin, record.args, record.cwd)
  ) {
    return false;
  }
  const observedStart = processStartTime(record.pid);
  if (record.processStartedAt && observedStart && record.processStartedAt !== observedStart) {
    return false;
  }
  ds4Process.adopt(record.pid, {
    ownership: record.ownership ?? "managed",
    cmdline: [record.bin, ...record.args],
    cwd: processWorkingDirectory(record.pid) ?? record.cwd,
    startedAt: record.startedAt,
  });
  activeEndpoint = record.host && record.port ? { host: record.host, port: record.port } : endpointFor(cfg);
  activeConfigFingerprint = cfg.fingerprint;
  return ds4Process.isRunning;
}

async function waitForReady(
  cfg: ResolvedRunConfig,
  endpoint: { host: string; port: number },
  signal: AbortSignal,
  requestedModel: CanonicalDwarfStarModelId | null = resolvedDwarfStarModelId(cfg.modelPath),
  processBacked = true,
): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastError = "no response";
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error("DwarfStar startup was cancelled.");
    if (processBacked && !ds4Process.isRunning) {
      throw new Error("ds4-server exited before becoming ready.");
    }
    try {
      const models = await requestModels(endpoint, signal);
      if (
        modelsMatchRequest(
          models,
          requestedModel,
          processBacked,
          cfg.visionPath !== null,
        )
      ) return;
      if (models.length > 0) lastError = `unexpected model list: ${models.map((model) => model.id).join(", ")}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleepWithSignal(STARTUP_POLL_MS, signal);
  }
  throw new Error(`DwarfStar did not become ready within ${Math.round(STARTUP_TIMEOUT_MS / 60000)} minutes (${lastError}).`);
}

function abortError(): Error {
  return new Error("DwarfStar startup was cancelled.");
}

function refreshProviderTurnLease(): void {
  if (providerTurnLeaseReleaseTimer) {
    clearTimeout(providerTurnLeaseReleaseTimer);
    providerTurnLeaseReleaseTimer = null;
  }
  writeProviderTurnLease(BRIDGE_PLUGIN_ID, {
    leaseId: providerTurnLeaseId,
    pid: process.pid,
    expiresAt: Date.now() + PROVIDER_TURN_LEASE_TTL_MS,
    ...(providerTurnLeaseProcessStartedAt
      ? { processStartedAt: providerTurnLeaseProcessStartedAt }
      : {}),
  });
}

function acquireProviderTurnLease(): () => void {
  providerTurnLeaseCount += 1;
  if (providerTurnLeaseCount === 1) {
    refreshProviderTurnLease();
    providerTurnLeaseTimer = setInterval(
      refreshProviderTurnLease,
      PROVIDER_TURN_LEASE_HEARTBEAT_MS,
    );
    providerTurnLeaseTimer.unref?.();
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    providerTurnLeaseCount = Math.max(0, providerTurnLeaseCount - 1);
    if (providerTurnLeaseCount > 0) return;
    if (providerTurnLeaseTimer) {
      clearInterval(providerTurnLeaseTimer);
      providerTurnLeaseTimer = null;
    }
    const releasedAt = Date.now();
    writeProviderTurnLease(BRIDGE_PLUGIN_ID, {
      leaseId: providerTurnLeaseId,
      pid: process.pid,
      expiresAt: releasedAt,
      releasedAt,
      ...(providerTurnLeaseProcessStartedAt
        ? { processStartedAt: providerTurnLeaseProcessStartedAt }
        : {}),
    });
    providerTurnLeaseReleaseTimer = setTimeout(() => {
      const lease = readProviderTurnLease(BRIDGE_PLUGIN_ID);
      if (
        lease?.leaseId === providerTurnLeaseId &&
        lease.releasedAt === releasedAt
      ) {
        clearProviderTurnLease(BRIDGE_PLUGIN_ID, providerTurnLeaseId);
      }
      providerTurnLeaseReleaseTimer = null;
    }, PROVIDER_TURN_LEASE_RELEASE_RETENTION_MS);
    providerTurnLeaseReleaseTimer.unref?.();
  };
}

async function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortError();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    timer.unref?.();
  });
}

async function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortError();
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

async function stopProcess(force = false): Promise<void> {
  if (!force && activeReadyLeases > 0) return;
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const pid = ds4Process.pid;
  const external = ds4Process.isExternal;
  const adopted = ds4Process.isAdopted && pid !== null && !external;
  const adoptedCommand = ds4Process.cmdline;
  const adoptedCwd = ds4Process.cwd;
  const adoptedStart = pid === null ? null : processStartTime(pid);
  if (ds4Process.isRunning) {
    if (external) {
      // An unowned server must remain alive. Drop our adopted handle so a
      // later configuration can probe its endpoint instead of treating it as
      // the process for the old configuration.
      ds4Process.detachExternal("exited");
    } else if (adopted && pid !== null && adoptedCommand) {
      const verifyPid = (candidate: number): boolean => {
        if (!processMatchesCommand(
          candidate,
          adoptedCommand[0] ?? "",
          adoptedCommand.slice(1),
          adoptedCwd,
        )) return false;
        const observedStart = processStartTime(candidate);
        return !adoptedStart || !observedStart || observedStart === adoptedStart;
      };
      if (!verifyPid(pid)) {
        ds4Process.detachAdopted("exited");
      } else {
        await ds4Process.stop(12_000, { terminateExternal: false, verifyPid });
      }
    } else {
      await ds4Process.stop(12_000, { terminateExternal: false });
    }
  }
  if (pid !== null && !external) clearProcessRecord(BRIDGE_PROCESS_RECORD_ID, pid);
  activeConfigFingerprint = null;
  activeEndpoint = null;
  activeReady = null;
}

function scheduleIdleStop(options: DwarfStarOptions): void {
  if (
    activeReadyLeases > 0 ||
    [...sessions.values()].some((session) => session.turn !== null) ||
    !ds4Process.isRunning
  ) return;
  if (idleTimer) clearTimeout(idleTimer);
  const seconds = Number(options.idleTimeoutSeconds);
  const timeout = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 86_400) * 1000 : 0;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (
      activeReadyLeases > 0 ||
      [...sessions.values()].some((session) => session.turn !== null)
    ) return;
    void stopProcess();
  }, timeout);
}

function idleStopOptions(session: Session | undefined): DwarfStarOptions {
  const options = parseOptions(undefined, undefined);
  return session
    ? { ...options, idleTimeoutSeconds: session.idleTimeoutSeconds }
    : options;
}

function releaseReadyLease(): void {
  activeReadyLeases = Math.max(0, activeReadyLeases - 1);
  if (activeReadyLeases === 0) {
    for (const resolve of leaseWaiters) resolve();
    leaseWaiters.clear();
  }
}

function acquireReadyLease(state: ReadyState): ReadyLease {
  activeReadyLeases += 1;
  let released = false;
  return {
    ...state,
    release: () => {
      if (released) return;
      released = true;
      releaseReadyLease();
    },
  };
}

async function waitForReadyLeasesToDrain(signal: AbortSignal): Promise<void> {
  while (activeReadyLeases > 0) {
    const drained = new Promise<void>((resolve) => leaseWaiters.add(resolve));
    await awaitWithSignal(drained, signal);
  }
}

async function startReady(
  options: DwarfStarOptions,
  model: string | undefined,
  cfg: ResolvedRunConfig,
  requestedModel: CanonicalDwarfStarModelId | null,
  signal: AbortSignal,
): Promise<ReadyState> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (ds4Process.isRunning && activeConfigFingerprint !== cfg.fingerprint) {
    await stopProcess();
  }
  if (!ds4Process.isRunning) {
    if (await adoptRecordedProcess(cfg)) {
      const endpoint = activeEndpoint ?? endpointFor(cfg);
      await waitForReady(cfg, endpoint, signal, requestedModel, true);
      return readyState(cfg, endpoint, true);
    }
    const endpoint = endpointFor(cfg);
    let probeSucceeded = false;
    try {
      const models = await requestModels(endpoint, signal);
      probeSucceeded = true;
      if (models.length === 0) {
        if (requestedModel === null) {
          throw new Error(
            `A server on ${endpoint.host}:${endpoint.port} is already reachable, but the configured GGUF identity cannot be verified. Stop it before using a custom DwarfStar model path.`,
          );
        }
        activeEndpoint = endpoint;
        activeConfigFingerprint = cfg.fingerprint;
        // A reachable endpoint with an empty model list is a loading state.
        // It has no child process handle, so keep polling it instead of
        // treating the bridge's stopped handle as a server exit.
        await waitForReady(cfg, endpoint, signal, requestedModel, false);
        return readyState(cfg, endpoint, false);
      }
      if (
        modelsMatchRequest(
          models,
          requestedModel,
          false,
          cfg.visionPath !== null,
        )
      ) {
        activeEndpoint = endpoint;
        activeConfigFingerprint = cfg.fingerprint;
        return readyState(cfg, endpoint, false);
      }
      if (requestedModel === null) {
        throw new Error(
          `A server on ${endpoint.host}:${endpoint.port} is already reachable, but the configured GGUF identity cannot be verified. Stop it before using a custom DwarfStar model path.`,
        );
      }
      throw new Error(
        `A server on ${endpoint.host}:${endpoint.port} is not serving the requested DwarfStar model.`,
      );
    } catch (error) {
      if (probeSucceeded) throw error;
      // Start the configured process below when the endpoint is unreachable.
    }
    let startedPid: number | null = null;
    ds4Process.start({
      bin: cfg.bin as string,
      args: cfg.args,
      cwd: cfg.ds4Dir as string,
      onExit: () => {
        if (activeConfigFingerprint === cfg.fingerprint) {
          clearProcessRecord(BRIDGE_PROCESS_RECORD_ID, startedPid);
          activeConfigFingerprint = null;
          activeEndpoint = null;
          activeReady = null;
        }
      },
    });
    startedPid = ds4Process.pid;
    if (!ds4Process.isRunning) throw new Error("ds4-server could not be started.");
    activeEndpoint = endpoint;
    activeConfigFingerprint = cfg.fingerprint;
    if (ds4Process.pid) {
      writeProcessRecord(BRIDGE_PROCESS_RECORD_ID, {
        pid: ds4Process.pid,
        fingerprint: cfg.fingerprint,
        bin: cfg.bin as string,
        args: cfg.args,
        cwd: cfg.ds4Dir as string,
        startedAt: ds4Process.startedAt ?? Date.now(),
        host: endpoint.host,
        port: endpoint.port,
        ownership: "managed",
        processStartedAt: processStartTime(ds4Process.pid) ?? undefined,
      });
    }
  }
  const endpoint = activeEndpoint ?? endpointFor(cfg);
  await waitForReady(cfg, endpoint, signal, requestedModel, true);
  return readyState(cfg, endpoint, true);
}

async function ensureReady(
  options: DwarfStarOptions,
  model: string | undefined,
  signal: AbortSignal,
  visionRequested = false,
  reportProgress?: (message: string) => void,
): Promise<ReadyLease> {
  const cfg = resolveBridgeConfig(options, model);
  const error = configError(cfg, model ?? options.model, visionRequested);
  if (error) throw new Error(error);
  const requestedModel = modelIdForRequest(options, model, cfg);
  const report = reportProgress ?? (() => undefined);
  for (;;) {
    const ready = activeReady;
    if (ready?.fingerprint === cfg.fingerprint) {
      if (!readyProcessIsCurrent(ready)) {
        report("DwarfStar's process changed; reconnecting to the configured server.");
        invalidateReadyState(ready);
        continue;
      }
      try {
        // Adopted and endpoint-only servers have no child-process exit hook.
        // Confirm the endpoint still serves the requested model before using
        // the cached readiness result for another turn.
        const models = await requestModels(ready.endpoint, signal);
        if (
          modelsMatchRequest(
            models,
            requestedModel,
            ready.processBacked,
            cfg.visionPath !== null,
          )
        ) {
          return acquireReadyLease(ready);
        }
        report("DwarfStar is restarting for the configured model.");
        if (activeReady === ready) activeReady = null;
        if (models.length > 0 && activeConfigFingerprint === cfg.fingerprint) {
          activeConfigFingerprint = null;
          activeEndpoint = null;
        }
      } catch {
        if (signal.aborted) throw abortError();
        report("Reconnecting to DwarfStar while it finishes loading.");
        if (activeReady === ready) activeReady = null;
        if (activeConfigFingerprint === cfg.fingerprint) {
          activeConfigFingerprint = null;
          activeEndpoint = null;
        }
      }
    }
    const pending = readiness;
    if (pending) {
      if (pending.fingerprint !== cfg.fingerprint) {
        if (pending.consumers === 0) {
          abortOrphanedReadiness(pending);
          continue;
        }
        report("Waiting for the current DwarfStar startup before reconfiguring it.");
        try {
          await awaitWithSignal(pending.promise, signal);
        } catch {
          if (signal.aborted) throw abortError();
        }
        continue;
      }
      report("Waiting for DwarfStar to finish loading the model.");
      const ready = await awaitReadiness(pending, signal);
      if (ready.fingerprint === cfg.fingerprint) return acquireReadyLease(ready);
      continue;
    }
    if (activeReadyLeases > 0) {
      report("Waiting for the current DwarfStar turn to finish before reconfiguring it.");
      await waitForReadyLeasesToDrain(signal);
      continue;
    }
    report(
      `Starting DwarfStar and loading ${startupModelLabel(model)}. This can take a few minutes.`,
    );
    const controller = new AbortController();
    const run = startReady(options, model, cfg, requestedModel, controller.signal).then(
      (ready) => {
        activeReady = ready;
        return ready;
      },
      (error: unknown) => {
        if (activeConfigFingerprint === cfg.fingerprint) {
          activeConfigFingerprint = null;
          activeEndpoint = null;
        }
        if (activeReady?.fingerprint === cfg.fingerprint) activeReady = null;
        throw error;
      },
    );
    const entry: ReadinessEntry = {
      fingerprint: cfg.fingerprint,
      promise: run,
      controller,
      consumers: 0,
    };
    readiness = entry;
    readinessController = controller;
    const clearPending = () => {
      if (readiness === entry) readiness = null;
      if (readinessController === controller) readinessController = null;
    };
    // A caller may cancel its own wait while startup must continue for
    // followers. Keep the shared promise registered until it actually
    // settles, otherwise a second turn could launch a duplicate server.
    void run.then(clearPending, clearPending);
    return acquireReadyLease(await awaitReadiness(entry, signal));
  }
}

function imageMimeType(path: string): string {
  return mimeTypeFromExtension(path) ?? "image/png";
}

function dataUriMimeType(value: string): string | null {
  const match = /^data:([^;,]+);base64,/u.exec(value);
  return match?.[1] ?? null;
}

function validateDataUri(value: string, maxBytes = MAX_IMAGE_BYTES): void {
  const mime = dataUriMimeType(value);
  if (!mime || !mime.startsWith("image/")) throw new Error("DwarfStar vision requires an image data URI.");
  if (!/^data:image\/(?:png|jpeg|jpg);base64,[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    throw new Error("Only PNG and JPEG image data URIs are supported.");
  }
  const encoded = value.slice(value.indexOf(",") + 1);
  if (encoded.length % 4 !== 0) {
    throw new Error("Image data URI base64 must use complete 4-character groups.");
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error("Each image is too large for DwarfStar.");
  }
}

async function imageInputToDataUri(input: Extract<PromptInput, { type: "image" | "localImage" }>): Promise<string> {
  if (input.type === "localImage") {
    const bytes = readFileSync(input.path);
    if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error(`Image is too large: ${input.path}`);
    const mime = imageMimeType(input.path);
    if (!/^image\/(?:png|jpeg|jpg)$/u.test(mime)) {
      throw new Error("Only PNG and JPEG images are supported.");
    }
    return `data:${mime};base64,${bytes.toString("base64")}`;
  }
  if (input.url.startsWith("data:")) {
    validateDataUri(input.url);
    return input.url;
  }
  if (!/^https?:\/\//iu.test(input.url)) throw new Error("Image URLs must be data:, http:, or https:.");
  const response = await fetch(input.url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Image download returned HTTP ${response.status}.`);
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > MAX_IMAGE_BYTES) throw new Error("Downloaded image is too large for DwarfStar.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("Downloaded image is too large for DwarfStar.");
  const mime = (response.headers.get("content-type") ?? "image/png").split(";", 1)[0];
  if (!/^image\/(?:png|jpeg|jpg)$/u.test(mime)) throw new Error("Only PNG and JPEG images are supported.");
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
}

export async function promptToMessages(input: readonly PromptInput[]): Promise<DwarfStarMessage> {
  const parts: Array<DwarfStarTextPart | DwarfStarImagePart> = [];
  for (const item of input) {
    if (item.type === "text") parts.push({ type: "text", text: item.text });
    else if (item.type === "image" || item.type === "localImage") {
      const imageCount = parts.filter((part) => part.type === "image_url").length;
      if (imageCount >= MAX_IMAGE_COUNT) {
        throw new Error(`DwarfStar accepts at most ${MAX_IMAGE_COUNT} images per turn.`);
      }
      parts.push({ type: "image_url", image_url: { url: await imageInputToDataUri(item) } });
    }
    else if (item.type === "localFile") parts.push({ type: "text", text: `[Attached file: ${item.path}]` });
  }
  const images = parts
    .filter((part): part is DwarfStarImagePart => part.type === "image_url")
    .map((part) => part.image_url.url);
  const imageSizeError = completionPayloadSizeError("", undefined, images);
  if (imageSizeError) throw new Error(imageSizeError);
  if (parts.length === 0) throw new Error("The turn has no text or image input.");
  const hasNonEmptyText = parts.some((part) => part.type === "text" && part.text.length > 0);
  if (images.length > 0 && !hasNonEmptyText) {
    parts.unshift({ type: "text", text: "[Image attachment]" });
  }
  return {
    role: "user",
    content: images.length
      ? parts
      : parts.filter((part): part is DwarfStarTextPart => part.type === "text").map((part) => part.text).join("\n"),
  };
}

function messageHasImages(message: DwarfStarMessage): boolean {
  return Array.isArray(message.content) && message.content.some((part) => part.type === "image_url");
}

function sessionHasImages(session: Session): boolean {
  return session.messages.some(messageHasImages);
}

function toolParameters(tool: DynamicTool): Record<string, unknown> {
  const schema = tool.inputSchema;
  if (schema !== null && typeof schema === "object" && !Array.isArray(schema)) {
    return schema as Record<string, unknown>;
  }
  return { type: "object", properties: {} };
}

function openAiTools(
  session: Session,
  options: DwarfStarOptions,
): Array<Record<string, unknown>> {
  return [...session.tools.values()]
    .filter((tool) => toolIsAllowed(session, options, tool.name))
    .map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: toolParameters(tool),
      },
    }));
}

function reasoningFields(level: string | undefined): Record<string, unknown> {
  switch (level) {
    case "none":
      return { reasoning_effort: "none", thinking: false };
    case "low":
    case "medium":
    case "high":
      return { reasoning_effort: level, thinking: true };
    case "max":
    case "xhigh":
      return { reasoning_effort: "max", thinking: true };
    default:
      return {};
  }
}

function deltaText(
  threadId: string,
  key: { providerItemId: string },
  channel: "agentMessage" | "reasoningText",
  text: string,
  providerTurnId: string,
): void {
  if (!text) return;
  sendDeltas(threadId, [{ kind: "item.textDelta", key, channel, text, providerTurnId }]);
}

function usageFromResponse(value: unknown): TokenUsage | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const prompt = typeof record.prompt_tokens === "number" ? record.prompt_tokens : 0;
  const completion = typeof record.completion_tokens === "number" ? record.completion_tokens : 0;
  const total = typeof record.total_tokens === "number" ? record.total_tokens : prompt + completion;
  const details = record.completion_tokens_details;
  const reasoning = details && typeof details === "object" && typeof (details as Record<string, unknown>).reasoning_tokens === "number"
    ? (details as Record<string, number>).reasoning_tokens
    : 0;
  return {
    inputTokens: prompt,
    cachedInputTokens: 0,
    outputTokens: completion,
    reasoningOutputTokens: reasoning,
    totalTokens: total,
  };
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningOutputTokens: a.reasoningOutputTokens + b.reasoningOutputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

function emitUsage(session: Session, usage: TokenUsage | null, cfg: ResolvedRunConfig, providerTurnId: string): void {
  const last = usage ?? ZERO_USAGE;
  session.usageTotal = addUsage(session.usageTotal, last);
  sendDeltas(session.threadId, [
    {
      kind: "usage",
      total: session.usageTotal,
      last,
      modelContextWindow: cfg.ctx,
      providerTurnId,
    },
    {
      kind: "contextWindow",
      used: session.usageTotal.inputTokens + session.usageTotal.outputTokens,
      size: cfg.ctx,
      estimated: true,
      attach: "open",
      providerTurnId,
    },
  ]);
}

export async function readSse(
  response: Response,
  onData: (value: unknown) => void,
  signal: AbortSignal,
): Promise<void> {
  if (!response.body) throw new Error("DwarfStar returned an empty streaming body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawDone = false;
  const consume = (line: string) => {
    if (sawDone) return;
    if (!line.startsWith("data:")) return;
    const value = line.slice(5).trim();
    if (!value) return;
    if (value === "[DONE]") {
      sawDone = true;
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error("DwarfStar returned malformed streaming JSON.");
    }
    onData(parsed);
  };
  try {
    for (;;) {
      if (signal.aborted) throw new Error("DwarfStar completion was cancelled.");
      const next = await reader.read();
      buffer += decoder.decode(next.value ?? new Uint8Array(), { stream: !next.done });
      const lines = buffer.split(/\r?\n/u);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        consume(line);
        if (sawDone) break;
      }
      if (sawDone || next.done) break;
    }
    if (!sawDone && buffer) consume(buffer);
    if (!sawDone) throw new Error("DwarfStar streaming response ended before [DONE].");
  } finally {
    if (!sawDone) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function streamCompletion(
  session: Session,
  cfg: ResolvedRunConfig,
  options: DwarfStarOptions,
  endpoint: { host: string; port: number },
  turn: TurnState,
  providerTurnId: string,
  signal: AbortSignal,
): Promise<CompletionResult> {
  const model = resolvedDwarfStarModelId(cfg.modelPath) ?? CONFIGURED_DWARFSTAR_MODEL_ID;
  const hasImages = session.messages.some((message) =>
    Array.isArray(message.content) && message.content.some((part) => part.type === "image_url"),
  );
  if (hasImages) {
    if (!isDwarfStarVisionModel(model) || !cfg.visionPath) {
      throw new Error("Image input requires a DeepSeek V4 Flash Vision Experimental or GLM 5.3 Flash model with a configured vision encoder.");
    }
  }
  const tools = openAiTools(session, options);
  const messages = [
    ...(options.promptMode === "plan"
      ? [{ role: "system" as const, content: PLAN_INSTRUCTION }]
      : []),
    ...(options.instructions && options.instructions !== session.instructions
      ? [{ role: "system" as const, content: options.instructions }]
      : []),
    ...session.messages,
  ];
  const request: Record<string, unknown> = {
    model: wireDwarfStarModelId(model),
    messages,
    max_tokens: cfg.maxTokens > 0 ? cfg.maxTokens : 16_384,
    stream: true,
    stream_options: { include_usage: true },
    ...(options.reasoningLevel ? reasoningFields(options.reasoningLevel) : {}),
    ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
  };
  const body = JSON.stringify(request);
  const bodyError = completionRequestBodySizeError(body);
  if (bodyError) throw new Error(bodyError);
  const response = await fetch(endpointUrl(endpoint, "/chat/completions"), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer dsv4-local" },
    body,
    signal: combinedSignal(signal, COMPLETION_TIMEOUT_MS),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`DwarfStar returned HTTP ${response.status}: ${body.slice(0, 500)}`);
  }
  const messageKey = { providerItemId: `${providerTurnId}-message` };
  const reasoningKey = { providerItemId: `${providerTurnId}-reasoning` };
  let messageText = "";
  let reasoningText = "";
  let messageOpen = false;
  let reasoningOpen = false;
  const toolCalls = new Map<number, DwarfStarToolCall>();
  let usage: TokenUsage | null = null;
  const openMessage = () => {
    if (messageOpen) return;
    messageOpen = true;
    turn.openItems.set(messageKey.providerItemId, {
      key: messageKey,
      channel: "agentMessage",
      text: () => messageText,
      item: () => ({ type: "agentMessage", text: messageText }),
    });
    sendDeltas(session.threadId, [{
      kind: "item.open",
      key: messageKey,
      item: { type: "agentMessage", text: "" },
      providerTurnId,
    }]);
  };
  const openReasoning = () => {
    if (reasoningOpen) return;
    reasoningOpen = true;
    turn.openItems.set(reasoningKey.providerItemId, {
      key: reasoningKey,
      channel: "reasoningText",
      text: () => reasoningText,
      item: () => ({ type: "reasoning", summary: [], content: [reasoningText] }),
    });
    sendDeltas(session.threadId, [{
      kind: "item.open",
      key: reasoningKey,
      item: { type: "reasoning", summary: [], content: [] },
      providerTurnId,
    }]);
  };
  let streamCompleted = false;
  try {
    await readSse(response, (raw) => {
      if (signal.aborted) throw new Error("DwarfStar completion was cancelled.");
      if (raw === null || typeof raw !== "object") return;
      const chunk = raw as Record<string, unknown>;
      const error = chunk.error;
      if (error !== undefined) {
        const message = optionRecord(error).message;
        throw new Error(
          typeof message === "string" ? message : "DwarfStar returned a streaming error.",
        );
      }
      usage = usageFromResponse(chunk.usage) ?? usage;
      const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
      const choice = choices[0];
      if (choice === null || typeof choice !== "object") return;
      const delta = (choice as Record<string, unknown>).delta;
      if (delta === null || typeof delta !== "object") return;
      const deltaRecord = delta as Record<string, unknown>;
      if (typeof deltaRecord.reasoning_content === "string") {
        openReasoning();
        reasoningText += deltaRecord.reasoning_content;
        deltaText(session.threadId, reasoningKey, "reasoningText", deltaRecord.reasoning_content, providerTurnId);
      }
      if (typeof deltaRecord.content === "string") {
        openMessage();
        messageText += deltaRecord.content;
        deltaText(session.threadId, messageKey, "agentMessage", deltaRecord.content, providerTurnId);
      }
      if (Array.isArray(deltaRecord.tool_calls)) {
        for (const rawCall of deltaRecord.tool_calls) {
          if (rawCall === null || typeof rawCall !== "object") continue;
          const call = rawCall as Record<string, unknown>;
          const index = typeof call.index === "number" ? call.index : toolCalls.size;
          const current = toolCalls.get(index) ?? {
            id: typeof call.id === "string" ? call.id : `call-${providerTurnId}-${index}`,
            type: "function" as const,
            function: { name: "", arguments: "" },
          };
          if (typeof call.id === "string") current.id = call.id;
          const fn = call.function;
          if (fn !== null && typeof fn === "object") {
            const functionRecord = fn as Record<string, unknown>;
            if (typeof functionRecord.name === "string") current.function.name += functionRecord.name;
            if (typeof functionRecord.arguments === "string") current.function.arguments += functionRecord.arguments;
          }
          toolCalls.set(index, current);
        }
      }
    }, signal);
    streamCompleted = true;
  } finally {
    const status = signal.aborted ? "interrupted" : streamCompleted ? "completed" : "failed";
    const canEmit = !session.closed && session.turn === turn;
    if (reasoningOpen && canEmit) {
      sendDeltas(session.threadId, [{
        kind: "item.close",
        key: reasoningKey,
        status,
        item: { type: "reasoning", summary: [], content: [reasoningText] },
        providerTurnId,
      }]);
    }
    turn.openItems.delete(reasoningKey.providerItemId);
    if (messageOpen && canEmit) {
      sendDeltas(session.threadId, [{
        kind: "item.close",
        key: messageKey,
        status,
        item: { type: "agentMessage", text: messageText },
        providerTurnId,
      }]);
    }
    turn.openItems.delete(messageKey.providerItemId);
  }
  const orderedToolCalls = [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
  return {
    assistant: {
      role: "assistant",
      content: messageText || null,
      ...(reasoningText ? { reasoning_content: reasoningText } : {}),
      ...(orderedToolCalls.length > 0 ? { tool_calls: orderedToolCalls } : {}),
    },
    toolCalls: orderedToolCalls,
    usage,
  };
}

function parseToolArguments(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function limitToolResult(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= MAX_TOOL_RESULT_BYTES) return value;
  return `${Buffer.from(value, "utf8").subarray(0, MAX_TOOL_RESULT_BYTES).toString("utf8")}\n[tool output truncated]`;
}

function emitToolOpen(session: Session, turnId: string, call: DwarfStarToolCall, args: Record<string, unknown>): { providerItemId: string } {
  const key = { providerItemId: `${turnId}-${call.id}` };
  const tool = session.tools.get(call.function.name);
  sendDeltas(session.threadId, [{
    kind: "item.open",
    key,
    item: { type: "tool", tool: call.function.name, server: "bb", args },
    ...(tool?.presentation ? { presentation: tool.presentation } : { presentation: experimental_toolPresentation(call.function.name) }),
    providerTurnId: turnId,
  }]);
  return key;
}

function emitToolClose(
  session: Session,
  turnId: string,
  key: { providerItemId: string },
  call: DwarfStarToolCall,
  args: Record<string, unknown>,
  result: ToolCallResult,
): void {
  sendDeltas(session.threadId, [{
    kind: "item.close",
    key,
    status: result.isError ? "failed" : "completed",
    item: {
      type: "tool",
      tool: call.function.name,
      server: "bb",
      args,
      ...(result.isError ? { error: result.content } : { result: result.content }),
    },
    resultText: result.content,
    ...(session.tools.get(call.function.name)?.presentation ? { presentation: session.tools.get(call.function.name)?.presentation } : { presentation: experimental_toolPresentation(call.function.name) }),
    providerTurnId: turnId,
  }]);
}

function closeOpenStreamItems(session: Session, turn: TurnState, status: "failed" | "interrupted"): void {
  if (session.closed) return;
  closeDwarfStarStartupNotice(
    session,
    turn,
    status,
    status === "interrupted"
      ? "DwarfStar startup was interrupted."
      : "DwarfStar startup failed.",
  );
  for (const item of turn.openItems.values()) {
    sendDeltas(session.threadId, [{
      kind: "item.close",
      key: item.key,
      status,
      item: item.item(),
      providerTurnId: turn.id,
    }]);
  }
  turn.openItems.clear();
}

function forwardToolCall(
  session: Session,
  turn: TurnState,
  call: DwarfStarToolCall,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  requestCounter += 1;
  const requestId = `ds4-tool-${requestCounter}`;
  turn.pendingToolCalls.add(requestId);
  return new Promise<ToolCallResult>((resolve) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      turn.controller.signal.removeEventListener("abort", onAbort);
    };
    const settle = (result: ToolCallResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      pendingToolCalls.delete(requestId);
      turn.pendingToolCalls.delete(requestId);
      resolve(result);
    };
    const onAbort = () => settle({
      content: "Tool call interrupted.",
      images: [],
      isError: true,
    });
    const timer = setTimeout(() => settle({
      content: "Tool call timed out while waiting for BB.",
      images: [],
      isError: true,
    }), TOOL_CALL_TIMEOUT_MS);
    timer.unref?.();
    pendingToolCalls.set(requestId, { resolve: settle, session, turn });
    turn.controller.signal.addEventListener("abort", onAbort, { once: true });
    if (turn.controller.signal.aborted) {
      onAbort();
      return;
    }
    io.send({
      jsonrpc: "2.0",
      id: requestId,
      method: BRIDGE_INBOUND_REQUEST_METHODS.toolCall,
      params: {
        providerThreadId: session.providerThreadId,
        threadId: session.threadId,
        turnId: turn.id,
        callId: call.id,
        tool: call.function.name,
        arguments: args,
        providerNativeIds: true,
      },
    });
  });
}

function isMutatingToolName(name: string): boolean {
  return /(?:^|[-_])(apply|bash|command|delete|edit|exec|move|patch|remove|rename|shell|write)(?:$|[-_])/iu.test(name);
}

export function dwarfStarToolAllowed(
  availableToolNames: Iterable<string>,
  disallowedToolNames: Iterable<string>,
  name: string,
  planMode = false,
): boolean {
  const available = new Set(availableToolNames);
  const disallowed = new Set(disallowedToolNames);
  if (!available.has(name) || disallowed.has(name)) return false;
  return !planMode || !isMutatingToolName(name);
}

function toolIsAllowed(
  session: Session,
  options: DwarfStarOptions,
  name: string,
): boolean {
  return dwarfStarToolAllowed(
    session.tools.keys(),
    session.disallowedTools,
    name,
    options.promptMode === "plan",
  );
}

export function normalizeDwarfStarToolImages(
  images: readonly { data: string; mimeType: string }[],
): { images: string[]; error: string | null } {
  if (images.length > MAX_IMAGE_COUNT) {
    return {
      images: [],
      error: `DwarfStar accepts at most ${MAX_IMAGE_COUNT} images per tool result.`,
    };
  }
  const urls: string[] = [];
  for (const image of images) {
    if (image.data.length > MAX_IMAGE_BYTES) {
      return { images: [], error: "A tool result image is too large for DwarfStar." };
    }
    const mime = image.mimeType.trim().toLowerCase();
    if (!/^image\/(?:png|jpeg|jpg)$/u.test(mime)) {
      return { images: [], error: "Only PNG and JPEG tool result images are supported." };
    }
    const url = `data:${mime};base64,${image.data}`;
    try {
      // Tool results are capped by encoded payload bytes first. Allow the
      // expected base64 expansion here; the aggregate and serialized request
      // budgets below remain the final HTTP-boundary guard.
      validateDataUri(url, MAX_IMAGE_BYTES * 2);
    } catch (error) {
      return { images: [], error: error instanceof Error ? error.message : "Invalid tool result image." };
    }
    urls.push(url);
  }
  const sizeError = completionPayloadSizeError("", undefined, urls);
  return sizeError ? { images: [], error: sizeError } : { images: urls, error: null };
}

interface PendingToolCall {
  resolve: (result: ToolCallResult) => void;
  session: Session;
  turn: TurnState;
}

const pendingToolCalls = new Map<string, PendingToolCall>();

function resolvePendingToolCalls(turn: TurnState): void {
  for (const requestId of turn.pendingToolCalls) {
    const pending = pendingToolCalls.get(requestId);
    pending?.resolve({ content: "Tool call interrupted.", images: [], isError: true });
    pendingToolCalls.delete(requestId);
  }
  turn.pendingToolCalls.clear();
}

async function runTurn(
  session: Session,
  options: DwarfStarOptions,
  cfg: ResolvedRunConfig,
  endpoint: { host: string; port: number },
  clientRequestId: ClientTurnRequestId | undefined,
  turn: TurnState,
  started = false,
): Promise<void> {
  if (session.closed || session.turn !== turn) return;
  if (!started) {
    sendDeltas(session.threadId, [
      ...(clientRequestId ? [{ kind: "input.accepted" as const, clientRequestId }] : []),
      { kind: "turn.open", providerTurnId: turn.id },
    ]);
  }
  try {
    for (;;) {
      if (session.closed || session.turn !== turn) throw new Error("DwarfStar turn was interrupted.");
      const completion = await streamCompletion(
        session,
        cfg,
        options,
        endpoint,
        turn,
        turn.id,
        turn.controller.signal,
      );
      if (session.closed || session.turn !== turn || turn.settled || turn.controller.signal.aborted) {
        throw new Error("DwarfStar turn was interrupted.");
      }
      if (completion.usage) emitUsage(session, completion.usage, cfg, turn.id);
      session.messages.push(completion.assistant);
      persistSessionAndUpdate(session);
      if (completion.toolCalls.length === 0) break;
      for (const call of completion.toolCalls) {
        if (session.closed || session.turn !== turn) throw new Error("DwarfStar turn was interrupted.");
        const args = parseToolArguments(call.function.arguments);
        const key = emitToolOpen(session, turn.id, call, args);
        const result = toolIsAllowed(session, options, call.function.name)
          ? await forwardToolCall(session, turn, call, args)
          : {
              content: session.disallowedTools.has(call.function.name)
                ? `Tool "${call.function.name}" is disallowed for this DwarfStar session.`
                : options.promptMode === "plan" && isMutatingToolName(call.function.name)
                  ? `Tool "${call.function.name}" is unavailable in plan mode.`
                  : `Tool "${call.function.name}" is not available to this DwarfStar session.`,
              images: [],
              isError: true,
            };
        if (session.closed || session.turn !== turn) throw new Error("DwarfStar turn was interrupted.");
        emitToolClose(session, turn.id, key, call, args, result);
        const toolContent: Array<DwarfStarTextPart | DwarfStarImagePart> = [{ type: "text", text: limitToolResult(result.content) }];
        for (const image of result.images) toolContent.push({ type: "image_url", image_url: { url: image } });
        session.messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: toolContent.length === 1 && toolContent[0]?.type === "text" ? toolContent[0].text : toolContent,
        });
        persistSessionAndUpdate(session);
      }
    }
    if (!session.closed && session.turn === turn) {
      sendDeltas(session.threadId, [{ kind: "turn.boundary", status: "completed", providerTurnId: turn.id }]);
      turn.boundarySent = true;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const interrupted = turn.controller.signal.aborted;
    if (!session.closed && session.turn === turn) {
      closeOpenStreamItems(session, turn, interrupted ? "interrupted" : "failed");
      sendDeltas(session.threadId, [{
        kind: "provider.error",
        message,
        category: interrupted ? "stream-disconnected" : "connection-failed",
        settlesTurn: true,
        providerTurnId: turn.id,
      }, { kind: "turn.boundary", status: interrupted ? "interrupted" : "failed", error: { message }, providerTurnId: turn.id }]);
      turn.boundarySent = true;
    }
  } finally {
    turn.settled = true;
    if (session.turn === turn) session.turn = null;
    scheduleIdleStop(options);
    turn.resolveDone();
  }
}

function createTurn(): TurnState {
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  return {
    id: `ds4-turn-${randomUUID()}`,
    controller: new AbortController(),
    pendingToolCalls: new Set(),
    openItems: new Map(),
    startupNotice: null,
    done,
    resolveDone,
    boundarySent: false,
    settled: false,
  };
}

function waitForTurnStop(turn: TurnState): Promise<void> {
  if (turn.settled) return Promise.resolve();
  return new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, STOP_WAIT_TIMEOUT_MS);
    timer.unref?.();
    void turn.done.then(finish, finish);
  });
}

async function stopTurn(session: Session, turn: TurnState): Promise<void> {
  turn.controller.abort();
  resolvePendingToolCalls(turn);
  await waitForTurnStop(turn);
  if (turn.settled) return;
  closeOpenStreamItems(session, turn, "interrupted");
  if (!turn.boundarySent && !session.closed) {
    sendDeltas(session.threadId, [{
      kind: "turn.boundary",
      status: "interrupted",
      error: { message: "DwarfStar turn interrupted while stopping the session." },
      providerTurnId: turn.id,
    }]);
    turn.boundarySent = true;
  }
  turn.settled = true;
  if (session.turn === turn) session.turn = null;
  turn.resolveDone();
}

async function runInitialTurn(
  session: Session,
  options: DwarfStarOptions,
  model: string | undefined,
  user: DwarfStarMessage,
): Promise<void> {
  if (session.closed || sessions.get(session.threadId) !== session) return;
  const turn = createTurn();
  session.turn = turn;
  session.messages.push(user);
  persistSessionAndUpdate(session);
  sendDeltas(session.threadId, [{ kind: "turn.open", providerTurnId: turn.id }]);
  let lease: ReadyLease | null = null;
  const providerTurnLease = acquireProviderTurnLease();
  try {
    lease = await ensureReady(
      options,
      model,
      turn.controller.signal,
      messageHasImages(user),
      (message) => emitDwarfStarStartupNotice(session, turn, model, message),
    );
    if (session.closed || session.turn !== turn) return;
    closeDwarfStarStartupNotice(session, turn, "completed", "The configured model is ready.");
    await runTurn(session, options, lease.cfg, lease.endpoint, undefined, turn, true);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!session.closed && session.turn === turn) {
      closeDwarfStarStartupNotice(session, turn, turn.controller.signal.aborted ? "interrupted" : "failed", message);
      sendDeltas(session.threadId, [{
        kind: "provider.error",
        message,
        category: turn.controller.signal.aborted ? "stream-disconnected" : "connection-failed",
        settlesTurn: true,
        providerTurnId: turn.id,
      }, { kind: "turn.boundary", status: turn.controller.signal.aborted ? "interrupted" : "failed", error: { message }, providerTurnId: turn.id }]);
      turn.boundarySent = true;
    }
  } finally {
    providerTurnLease();
    lease?.release();
    if (!turn.settled) {
      turn.settled = true;
      if (session.turn === turn) session.turn = null;
      scheduleIdleStop(options);
    }
    turn.resolveDone();
    scheduleIdleStop(options);
    void startNextQueuedTurn(session);
  }
}

async function runTurnAfterReady(
  session: Session,
  options: DwarfStarOptions,
  model: string | undefined,
  clientRequestId: ClientTurnRequestId,
  turn: TurnState,
): Promise<void> {
  if (session.closed || session.turn !== turn) return;
  sendDeltas(session.threadId, [
    { kind: "input.accepted", clientRequestId },
    { kind: "turn.open", providerTurnId: turn.id },
  ]);
  let lease: ReadyLease | null = null;
  const providerTurnLease = acquireProviderTurnLease();
  try {
    lease = await ensureReady(
      options,
      model,
      turn.controller.signal,
      sessionHasImages(session),
      (message) => emitDwarfStarStartupNotice(session, turn, model, message),
    );
    if (session.closed || session.turn !== turn) return;
    closeDwarfStarStartupNotice(session, turn, "completed", "The configured model is ready.");
    await runTurn(session, options, lease.cfg, lease.endpoint, clientRequestId, turn, true);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const interrupted = turn.controller.signal.aborted;
    if (!session.closed && session.turn === turn) {
      closeDwarfStarStartupNotice(session, turn, interrupted ? "interrupted" : "failed", message);
      closeOpenStreamItems(session, turn, interrupted ? "interrupted" : "failed");
      if (!turn.boundarySent) {
        sendDeltas(session.threadId, [{
          kind: "provider.error",
          message,
          category: interrupted ? "stream-disconnected" : "connection-failed",
          settlesTurn: true,
          providerTurnId: turn.id,
        }, { kind: "turn.boundary", status: interrupted ? "interrupted" : "failed", error: { message }, providerTurnId: turn.id }]);
        turn.boundarySent = true;
      }
    }
  } finally {
    providerTurnLease();
    lease?.release();
    if (!turn.settled) {
      turn.settled = true;
      if (session.turn === turn) session.turn = null;
      scheduleIdleStop(options);
    }
    turn.resolveDone();
    scheduleIdleStop(options);
    void startNextQueuedTurn(session);
  }
}

async function startNextQueuedTurn(session: Session): Promise<void> {
  if (session.closed || session.turn || session.queuedTurns.length === 0) return;
  const queued = session.queuedTurns.shift();
  if (!queued) return;
  const turn = createTurn();
  session.turn = turn;
  session.messages.push(queued.input);
  persistSessionAndUpdate(session);
  sendDeltas(session.threadId, [{ kind: "turn.open", providerTurnId: turn.id }]);
  let lease: ReadyLease | null = null;
  const providerTurnLease = acquireProviderTurnLease();
  try {
    lease = await ensureReady(
      queued.options,
      queued.model,
      turn.controller.signal,
      sessionHasImages(session),
      (message) => emitDwarfStarStartupNotice(session, turn, queued.model, message),
    );
    if (session.closed || session.turn !== turn) return;
    closeDwarfStarStartupNotice(session, turn, "completed", "The configured model is ready.");
    await runTurn(
      session,
      queued.options,
      lease.cfg,
      lease.endpoint,
      queued.clientRequestId,
      turn,
      true,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const interrupted = turn.controller.signal.aborted;
    if (!session.closed && session.turn === turn) {
      closeDwarfStarStartupNotice(session, turn, interrupted ? "interrupted" : "failed", message);
      closeOpenStreamItems(session, turn, interrupted ? "interrupted" : "failed");
      if (!turn.boundarySent) {
        sendDeltas(session.threadId, [{
          kind: "provider.error",
          message,
          category: interrupted ? "stream-disconnected" : "connection-failed",
          settlesTurn: true,
          providerTurnId: turn.id,
        }, {
          kind: "turn.boundary",
          status: interrupted ? "interrupted" : "failed",
          error: { message },
          providerTurnId: turn.id,
        }]);
        turn.boundarySent = true;
      }
    }
  } finally {
    providerTurnLease();
    lease?.release();
    if (!turn.settled) {
      turn.settled = true;
      if (session.turn === turn) session.turn = null;
    }
    turn.resolveDone();
    scheduleIdleStop(idleStopOptions(session));
    void startNextQueuedTurn(session);
  }
}

function openSession(args: {
  threadId: string;
  providerThreadId: string;
  cwd: string;
  options: unknown;
  dynamicTools: readonly DynamicTool[] | undefined;
  disallowedTools: readonly string[] | undefined;
  instructionMode: "append" | "replace";
  restore?: boolean;
}): Session {
  const sessionOptions = parseExecutionOptions(args.options);
  const instructions = sessionOptions.instructions;
  const restored = args.restore ? loadPersistedSession(args.threadId, args.providerThreadId) : null;
  const session: Session = {
    threadId: args.threadId,
    providerThreadId: args.providerThreadId,
    cwd: restored?.cwd ?? args.cwd,
    instructions: restored?.instructions ?? instructions,
    instructionMode: restored?.instructionMode ?? args.instructionMode,
    tools: new Map((args.dynamicTools ?? []).map((tool) => [tool.name, tool])),
    disallowedTools: new Set(args.disallowedTools ?? []),
    messages: restored?.messages ?? (instructions ? [{ role: "system", content: instructions }] : []),
    usageTotal: restored?.usageTotal ?? { ...ZERO_USAGE },
    idleTimeoutSeconds: sessionOptions.idleTimeoutSeconds,
    queuedTurns: restored?.queuedTurns ?? [],
    turn: null,
    closed: false,
    restorable: restored !== null,
  };
  if (!restored && !args.restore) session.restorable = persistSession(session);
  sessions.set(args.threadId, session);
  notify(BRIDGE_NOTIFICATION_METHODS.threadIdentity, {
    threadId: args.threadId,
    providerThreadId: args.providerThreadId,
    sessionRestorable: session.restorable,
  });
  sendDeltas(args.threadId, [{ kind: "session.reset" }]);
  return session;
}

function modelReasoningEfforts(): AvailableModel["supportedReasoningEfforts"] {
  return [
    { reasoningEffort: "none", description: "No reasoning" },
    { reasoningEffort: "low", description: "Low" },
    { reasoningEffort: "medium", description: "Medium" },
    { reasoningEffort: "high", description: "High" },
    { reasoningEffort: "max", description: "Maximum" },
  ];
}

function modelDisplayName(id: string): string {
  switch (id) {
    case "deepseek-v4-flash": return "DeepSeek V4 Flash";
    case "deepseek-v4-flash-vision-exp": return "DeepSeek V4 Flash Vision Experimental";
    case "deepseek-v4-pro": return "DeepSeek V4 Pro";
    case "glm-5.2": return "GLM 5.2";
    case "glm-5.3-flash": return "GLM 5.3 Flash";
    default: return "DwarfStar (configured model)";
  }
}

export function mapDwarfStarModels(
  cwd = globalThis.process.cwd(),
  configuredModelId?: string,
  configuredModelPath?: string,
): AvailableModel[] {
  // The provider registration passes the settings-derived identity through
  // static bridge options. Resolve the path again so a DS4-style symlink such
  // as ds4flash.gguf follows the model currently configured on disk.
  const id =
    (configuredModelPath && resolvedDwarfStarModelId(configuredModelPath)) ??
    canonicalModelId(configuredModelId ?? "") ??
    (configuredModelId?.trim() || CONFIGURED_DWARFSTAR_MODEL_ID);
  const displayName = modelDisplayName(id);
  const location = configuredModelPath ? ` (${basename(configuredModelPath)})` : "";
  return [{
    id,
    model: id,
    displayName,
    description: `${displayName} configured in DwarfStar settings${location}${cwd ? `; served by local DwarfStar on ${basename(cwd)}` : ""}.`,
    supportedReasoningEfforts: modelReasoningEfforts(),
    defaultReasoningEffort: id.startsWith("glm-") ? "high" : "none",
    isDefault: true,
  }];
}

function healthResult(options: DwarfStarOptions | null = null): ProviderHealthResult {
  const effectiveOptions = options ?? parseOptions(undefined, undefined);
  const cfg = resolveBridgeConfig(effectiveOptions, effectiveOptions.model);
  const installed = Boolean(cfg.bin && cfg.ds4Dir && existsSync(cfg.bin));
  const configErrorMessage = installed
    ? configError(cfg, effectiveOptions.model)
    : null;
  const ready = installed && configErrorMessage === null;
  return {
    supported: true,
    health: {
      status: ready ? "ready" : installed ? "unknown" : "not_installed",
      statusMessage: ready
        ? null
        : configErrorMessage ?? "Set the DS4 checkout directory or install ds4-server.",
      accountEmail: null,
      planLabel: "Local DwarfStar",
      installedVersion: null,
      minimumSupportedVersion: null,
      canInstall: false,
      canUpdate: false,
      loginCommand: null,
    },
  };
}

function handleResponse(raw: unknown): void {
  if (raw === null || typeof raw !== "object") return;
  const message = raw as Record<string, unknown>;
  const id = message.id;
  if (typeof id !== "string") return;
  const pending = pendingToolCalls.get(id);
  if (!pending) return;
  pendingToolCalls.delete(id);
  pending.turn.pendingToolCalls.delete(id);
  if (message.error !== undefined) {
    const error = optionRecord(message.error);
    pending.resolve({
      content: limitToolResult(typeof error.message === "string" ? error.message : "Tool call failed."),
      images: [],
      isError: true,
    });
    return;
  }
  try {
    const result = decodeToolCallResponsePayload(message.result);
    const normalizedImages = normalizeDwarfStarToolImages(result.images);
    const content = limitToolResult(result.content || "(no output)");
    pending.resolve({
      content: normalizedImages.error ?? content,
      images: normalizedImages.images,
      isError: result.isError || normalizedImages.error !== null,
    });
  } catch (error) {
    pending.resolve({
      content: error instanceof Error ? error.message : "Malformed tool response.",
      images: [],
      isError: true,
    });
  }
}

async function handleRequest(id: JsonRpcId, method: string, params: unknown): Promise<void> {
  switch (method) {
    case BRIDGE_REQUEST_METHODS.initialize: {
      const parsed = initializeParamsSchema.safeParse(params ?? {});
      if (!parsed.success) return invalidParams(id, method, parsed.error.issues);
      io.sendResult(id, {
        protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
        capabilities: {
          grammarVersions: [THREAD_DELTA_GRAMMAR_V3, THREAD_DELTA_GRAMMAR_V3],
          sessionRestore: true,
          threadArchive: false,
          threadRename: false,
          threadGoalClear: false,
          fork: "none",
          approvalEnforcedBy: "provider",
          steerMode: "queue",
        },
      });
      return;
    }
    case BRIDGE_REQUEST_METHODS.modelList: {
      const parsed = modelListParamsSchema.safeParse(params ?? {});
      if (!parsed.success) return invalidParams(id, method, parsed.error.issues);
      const providerOptions = optionRecord(parsed.data.providerOptions);
      io.sendResult(id, {
        models: mapDwarfStarModels(
          parsed.data.cwd,
          typeof providerOptions.configuredModelId === "string"
            ? providerOptions.configuredModelId
            : undefined,
          typeof providerOptions.configuredModelPath === "string"
            ? providerOptions.configuredModelPath
            : undefined,
        ),
        selectedOnlyModels: [],
      });
      return;
    }
    case BRIDGE_REQUEST_METHODS.providerHealth: {
      const parsed = providerMaintenanceParamsSchema.safeParse(params ?? {});
      if (!parsed.success) return invalidParams(id, method, parsed.error.issues);
      const options = optionRecord(parsed.data.providerOptions);
      io.sendResult(id, healthResult(dwarfStarOptionsSchema.safeParse(options).success ? dwarfStarOptionsSchema.parse(options) : null));
      return;
    }
    case BRIDGE_REQUEST_METHODS.threadStart: {
      const parsed = threadStartParamsSchema.safeParse(params ?? {});
      if (!parsed.success) return invalidParams(id, method, parsed.error.issues);
      threadCounter += 1;
      const providerThreadId = `ds4_${ds4Process.pid ?? "bridge"}_${threadCounter}`;
      const session = openSession({
        threadId: parsed.data.threadId,
        providerThreadId,
        cwd: parsed.data.cwd,
        options: parsed.data.options,
        dynamicTools: parsed.data.dynamicTools,
        disallowedTools: parsed.data.disallowedTools,
        instructionMode: parsed.data.instructionMode,
      });
      let initialUser: DwarfStarMessage | null = null;
      if (parsed.data.input?.length) {
        try {
          initialUser = await promptToMessages(parsed.data.input);
        } catch (error) {
          session.closed = true;
          sessions.delete(session.threadId);
          return io.sendError(id, BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS, error instanceof Error ? error.message : String(error));
        }
      }
      if (session.closed || sessions.get(session.threadId) !== session) {
        return io.sendError(id, BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR, "The DwarfStar thread ended before startup completed.");
      }
      io.sendResult(id, { providerThreadId, sessionRestorable: session.restorable });
      if (initialUser) {
        const options = parseExecutionOptions(parsed.data.options);
        void runInitialTurn(session, options, parsed.data.options.model, initialUser);
      }
      return;
    }
    case BRIDGE_REQUEST_METHODS.threadResume: {
      const parsed = threadResumeParamsSchema.safeParse(params ?? {});
      if (!parsed.success) return invalidParams(id, method, parsed.error.issues);
      const session = openSession({
        threadId: parsed.data.threadId,
        providerThreadId: parsed.data.providerThreadId,
        cwd: parsed.data.cwd,
        options: parsed.data.options,
        dynamicTools: parsed.data.dynamicTools,
        disallowedTools: parsed.data.disallowedTools,
        instructionMode: parsed.data.instructionMode,
        restore: true,
      });
      if (!session.restorable) {
        sessions.delete(parsed.data.threadId);
        return io.sendError(id, BRIDGE_JSON_RPC_ERRORS.SESSION_NOT_RESTORABLE, "The DwarfStar session snapshot is unavailable; start a new thread.");
      }
      io.sendResult(id, { providerThreadId: parsed.data.providerThreadId, sessionRestorable: true });
      void startNextQueuedTurn(session);
      return;
    }
    case BRIDGE_REQUEST_METHODS.turnStart: {
      const parsed = turnStartParamsSchema.safeParse(params ?? {});
      if (!parsed.success) return invalidParams(id, method, parsed.error.issues);
      const session = sessions.get(parsed.data.threadId);
      if (!session || session.closed) {
        return io.sendError(id, BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS, "No active DwarfStar session. Start or resume the thread first.");
      }
      if (session.providerThreadId !== parsed.data.providerThreadId) {
        return io.sendError(id, BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS, "The provider thread identity does not match.");
      }
      if (session.turn) return io.sendError(id, BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS, "A DwarfStar turn is already active.");
      const options = parseExecutionOptions(parsed.data.options);
      const turn = createTurn();
      session.turn = turn;
      try {
        const user = await promptToMessages(parsed.data.input);
        if (session.closed || session.turn !== turn) {
          return io.sendError(id, BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR, "DwarfStar turn was interrupted before startup completed.");
        }
        session.messages.push(user);
        persistSessionAndUpdate(session);
        io.sendResult(id, { threadId: parsed.data.threadId });
        // A model load can take longer than the bridge request timeout. Ack the
        // accepted turn promptly, keep it visibly open, and let the turn task
        // wait for /v1/models before it sends the completion request.
        void runTurnAfterReady(session, options, parsed.data.options.model, parsed.data.clientRequestId, turn);
      } catch (error) {
        if (session.turn === turn) session.turn = null;
        turn.settled = true;
        const message = error instanceof Error ? error.message : String(error);
        io.sendError(id, BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR, message);
        scheduleIdleStop(options);
        turn.resolveDone();
      }
      return;
    }
    case BRIDGE_REQUEST_METHODS.turnSteer: {
      const parsed = turnSteerParamsSchema.safeParse(params ?? {});
      if (!parsed.success) return invalidParams(id, method, parsed.error.issues);
      const session = sessions.get(parsed.data.threadId);
      const turn = session?.turn;
      if (
        !session ||
        session.closed ||
        !turn ||
        session.providerThreadId !== parsed.data.providerThreadId ||
        turn.id !== parsed.data.expectedTurnId
      ) {
        return io.sendError(id, BRIDGE_JSON_RPC_ERRORS.NO_ACTIVE_TURN, "No matching active DwarfStar turn.");
      }
      let input: DwarfStarMessage;
      try {
        input = await promptToMessages(parsed.data.input);
      } catch (error) {
        return io.sendError(id, BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS, error instanceof Error ? error.message : String(error));
      }
      if (session.closed || session.turn !== turn) {
        return io.sendError(id, BRIDGE_JSON_RPC_ERRORS.NO_ACTIVE_TURN, "The DwarfStar turn ended before steering was queued.");
      }
      const options = parseExecutionOptions(parsed.data.options);
      const queued: QueuedTurn = {
        input,
        options,
        model: parsed.data.options.model,
        clientRequestId: parsed.data.clientRequestId,
      };
      session.queuedTurns.push(queued);
      if (!persistSessionAndUpdate(session)) {
        session.queuedTurns.pop();
        return io.sendError(id, BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR, "The steered DwarfStar input could not be persisted.");
      }
      sendDeltas(session.threadId, [{ kind: "input.accepted", clientRequestId: parsed.data.clientRequestId }]);
      io.sendResult(id, { threadId: parsed.data.threadId });
      return;
    }
    case BRIDGE_REQUEST_METHODS.threadStop: {
      const parsed = threadStopParamsSchema.safeParse(params ?? {});
      if (!parsed.success) return invalidParams(id, method, parsed.error.issues);
      const session = sessions.get(parsed.data.threadId);
      const turn = session?.turn;
      if (session && session.providerThreadId !== parsed.data.providerThreadId) {
        return io.sendError(id, BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS, "The provider thread identity does not match.");
      }
      if (
        session &&
        turn &&
        parsed.data.intent === "interrupt" &&
        parsed.data.activeTurnId !== turn.id
      ) {
        // A delayed interrupt for an older turn must not close or cancel the
        // newer turn that is now active. It is safe to acknowledge it because
        // the caller's requested turn has already ended.
        io.sendResult(id, { ok: true, providerCheckpointId: null });
        return;
      }
      if (session && turn && parsed.data.intent === "interrupt") await stopTurn(session, turn);
      // `release` is a lifecycle notification, not an interruption request.
      // If a turn is still active, leave it alive and let its normal boundary
      // release the session resources later.
      if (session && turn && parsed.data.intent === "release") {
        io.sendResult(id, { ok: true, providerCheckpointId: null });
        return;
      }
      if (session) session.closed = true;
      sessions.delete(parsed.data.threadId);
      if (parsed.data.intent === "interrupt") sendDeltas(parsed.data.threadId, [{ kind: "session.ended" }]);
      io.sendResult(id, { ok: true, providerCheckpointId: null });
      scheduleIdleStop(idleStopOptions(session));
      return;
    }
    case BRIDGE_REQUEST_METHODS.threadDiscard: {
      const parsed = threadDiscardParamsSchema.safeParse(params ?? {});
      if (!parsed.success) return invalidParams(id, method, parsed.error.issues);
      const session = sessions.get(parsed.data.threadId);
      if (session && session.providerThreadId !== parsed.data.providerThreadId) {
        return io.sendError(id, BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS, "The provider thread identity does not match.");
      }
      if (session && session.providerThreadId === parsed.data.providerThreadId && session.turn) {
        await stopTurn(session, session.turn);
      }
      if (session) session.closed = true;
      sessions.delete(parsed.data.threadId);
      try {
        unlinkSync(sessionFilePath(parsed.data.threadId));
      } catch {
        // Discard is idempotent when no snapshot exists.
      }
      io.sendResult(id, { ok: true });
      scheduleIdleStop(idleStopOptions(session));
      return;
    }
    case BRIDGE_REQUEST_METHODS.threadArchive: {
      const parsed = threadArchiveParamsSchema.safeParse(params ?? {});
      if (!parsed.success) return invalidParams(id, method, parsed.error.issues);
      io.sendResult(id, {});
      return;
    }
    case BRIDGE_REQUEST_METHODS.threadUnarchive: {
      const parsed = threadUnarchiveParamsSchema.safeParse(params ?? {});
      if (!parsed.success) return invalidParams(id, method, parsed.error.issues);
      io.sendResult(id, {});
      return;
    }
    case BRIDGE_REQUEST_METHODS.threadGoalClear: {
      const parsed = threadGoalClearParamsSchema.safeParse(params ?? {});
      if (!parsed.success) return invalidParams(id, method, parsed.error.issues);
      io.sendResult(id, {});
      return;
    }
    case BRIDGE_REQUEST_METHODS.threadNameSet: {
      const parsed = threadNameSetParamsSchema.safeParse(params ?? {});
      if (!parsed.success) return invalidParams(id, method, parsed.error.issues);
      io.sendResult(id, {});
      return;
    }
    default:
      io.sendError(id, BRIDGE_JSON_RPC_ERRORS.METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

function handleParsedMessage(raw: unknown): void {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return;
  const message = raw as Record<string, unknown>;
  if (message.method === undefined) return handleResponse(raw);
  const id = message.id;
  if (typeof id !== "string" && typeof id !== "number") return;
  runBridgeRequest({
    request: { id, method: typeof message.method === "string" ? message.method : "", params: message.params },
    sendError: io.sendError,
    handleRequest: async (request) => handleRequest(request.id, request.method, request.params),
  });
}

const lineHandler = createBridgeLineHandler({ handleParsedMessage });

export function handleLine(line: string): void {
  lineHandler(line);
}

async function shutdown(): Promise<void> {
  if (disposed) return;
  disposed = true;
  readinessController?.abort();
  const activeTurns = [...sessions.values()]
    .map((session) => session.turn)
    .filter((turn): turn is TurnState => turn !== null);
  for (const session of sessions.values()) session.closed = true;
  for (const turn of activeTurns) {
    turn.controller.abort();
    resolvePendingToolCalls(turn);
  }
  await Promise.all(activeTurns.map((turn) => waitForTurnStop(turn)));
  sessions.clear();
  if (providerTurnLeaseTimer) {
    clearInterval(providerTurnLeaseTimer);
    providerTurnLeaseTimer = null;
  }
  if (providerTurnLeaseReleaseTimer) {
    clearTimeout(providerTurnLeaseReleaseTimer);
    providerTurnLeaseReleaseTimer = null;
  }
  providerTurnLeaseCount = 0;
  clearProviderTurnLease(BRIDGE_PLUGIN_ID, providerTurnLeaseId);
  await stopProcess(true);
}

export const experimental_providerBridge = experimental_defineProviderBridge({
  handleLine,
  start(context) {
    bridgeDataDir = context.dataDir;
    if (!bridgeDataDir) bridgeDataDir = join(homedir(), ".bb", "plugins", BRIDGE_PLUGIN_ID);
  },
  onClose() {
    void shutdown();
  },
  onSigterm() {
    void shutdown();
  },
  onSigint() {
    void shutdown();
  },
});

export function normalizeDwarfStarSseLine(line: string): string | null {
  return line.startsWith("data:") ? line.slice(5).trim() || null : null;
}

export function dwarfStarModelSupportsVision(model: string): boolean {
  return isDwarfStarVisionModel(model) || inferDwarfStarModelId(model) === "glm-5.3-flash";
}
