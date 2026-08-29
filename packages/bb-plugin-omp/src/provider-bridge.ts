/**
 * OhMyPi provider bridge.
 *
 * OMP is Pi-derived and its `--mode rpc` process speaks the AgentSessionEvent
 * JSON-lines dialect. One RPC child is kept per BB thread, so the bridge can
 * preserve conversation state while forwarding model/thinking selections at
 * process construction time. The child owns OMP's native tools; this bridge
 * translates their lifecycle into BB's v3 delta grammar.
 */

import { execFile } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  BRIDGE_JSON_RPC_ERRORS,
  BRIDGE_NOTIFICATION_METHODS,
  BRIDGE_REQUEST_METHODS,
  PROVIDER_BRIDGE_PROTOCOL_VERSION,
  THREAD_DELTA_GRAMMAR_V3,
  THREAD_DELTA_NOTIFICATION_METHOD,
  buildShellEnvOverrides,
  bridgeRequestEnvelopeSchema,
  createBridgeIo,
  createBridgeLineHandler,
  experimental_defineProviderBridge,
  initializeParamsSchema,
  isStandaloneBuiltinCompactCommand,
  mimeTypeFromExtension,
  modelListParamsSchema,
  providerMaintenanceParamsSchema,
  runBridgeRequest,
  threadDiscardParamsSchema,
  threadResumeParamsSchema,
  threadStartParamsSchema,
  threadStopParamsSchema,
  turnStartParamsSchema,
  turnSteerParamsSchema,
  type AvailableModel,
  type ThreadDelta,
} from "@get-bb/plugin-sdk/provider-bridge";
import {
  buildOmpChildEnv,
  resolveOmpLaunch,
  type OmpRpcChildExitInfo,
  type OmpRpcResponse,
} from "./omp-rpc-child.js";
import { OmpRpcSession, type OmpSessionOptions } from "./omp-session.js";
import { createOmpEventTranslator } from "./omp-events.js";

type ThreadStartParams = z.infer<typeof threadStartParamsSchema>;
type ThreadResumeParams = z.infer<typeof threadResumeParamsSchema>;
type TurnStartParams = z.infer<typeof turnStartParamsSchema>;
type TurnSteerParams = z.infer<typeof turnSteerParamsSchema>;
type ThreadStopParams = z.infer<typeof threadStopParamsSchema>;
type ThreadDiscardParams = z.infer<typeof threadDiscardParamsSchema>;

interface OmpBuildConfig {
  cwd: string;
  model?: string;
  thinkingLevel?: string;
  instructions?: string;
  instructionMode: "append" | "replace";
  envVars: Record<string, string>;
  autoApprove: boolean;
}

interface ThreadSession {
  session: OmpRpcSession;
  serial: number;
  threadId: string;
  providerThreadId: string;
  cwd: string;
  config: OmpBuildConfig;
  closing: boolean;
}

interface PendingStart {
  session: OmpRpcSession;
  serial: number;
}

const io = createBridgeIo<any>();
const translator = createOmpEventTranslator();
const sessions = new Map<string, ThreadSession>();
const pendingStarts = new Map<string, PendingStart>();
const threadOperationTails = new Map<string, Promise<unknown>>();
let sessionSerial = 0;
let bridgeDataDir: string | undefined;
let bridgeTempDir: string | undefined;

const REASONING_TO_OMP: Record<string, string> = {
  none: "off",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  // BB has no `auto` level. xhigh is OMP's highest explicit effort.
  max: "xhigh",
  ultracode: "xhigh",
  ultra: "xhigh",
};

const OMP_TO_REASONING: Record<string, string> = {
  off: "none",
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
};

const REASONING_ORDER = ["none", "low", "medium", "high", "xhigh"];

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

function invalidParams(id: string | number, method: string, issues: unknown): void {
  const detail = typeof issues === "string" ? issues : JSON.stringify(issues);
  io.sendError(
    id,
    BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
    `Invalid params for ${method}${detail ? `: ${detail}` : ""}`,
  );
}

function ensureBridgeDirs(): { dataDir: string; tempDir: string; sessionDir: string } {
  if (!bridgeDataDir) {
    bridgeDataDir = join(tmpdir(), `bb-omp-${process.pid}`);
  }
  if (!bridgeTempDir) {
    bridgeTempDir = join(bridgeDataDir, "tmp");
  }
  const sessionDir = join(bridgeDataDir, "sessions");
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(bridgeTempDir, { recursive: true });
  return { dataDir: bridgeDataDir, tempDir: bridgeTempDir, sessionDir };
}

function isWithinRoot(candidate: string, root: string, allowRoot = false): boolean {
  if (allowRoot && candidate === root) return true;
  const child = relative(root, candidate);
  return child.length > 0 && child !== ".." && !child.startsWith(`..${sep}`) &&
    !child.startsWith(sep);
}

function rejectSymlinkComponents(candidate: string, root: string): void {
  const child = relative(root, candidate);
  if (!isWithinRoot(candidate, root)) {
    throw new Error("OMP session file resolves outside the bridge session directory");
  }
  let current = root;
  for (const component of child.split(sep).filter(Boolean)) {
    current = join(current, component);
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error("OMP session file symlinks are not allowed");
    }
  }
}

/**
 * Only OMP session files created below the bridge's private session directory
 * may be used for resume/discard. Lexical checks alone are insufficient when
 * a path component is a symlink, so existing paths are checked after
 * realpath(2) resolution and the leaf symlink is rejected outright.
 */
export function validateOwnedSessionPath(value: string, requireExisting = true): string {
  if (!value || !value.includes(sep)) {
    throw new Error("OMP providerThreadId is not a bridge-owned session file");
  }
  const root = realpathSync(ensureBridgeDirs().sessionDir);
  const candidate = resolve(value);
  const parent = dirname(candidate);
  const resolvedParent = realpathSync(parent);
  if (!isWithinRoot(resolvedParent, root, true)) {
    throw new Error("OMP session file is outside the bridge session directory");
  }
  let candidateStat: ReturnType<typeof lstatSync>;
  try {
    candidateStat = lstatSync(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (requireExisting) {
      throw new Error("OMP session file does not exist");
    }
    if (lstatSync(parent).isSymbolicLink()) {
      throw new Error("OMP session file resolves outside the bridge session directory");
    }
    return candidate;
  }
  if (candidateStat.isSymbolicLink()) {
    throw new Error("OMP session file symlinks are not allowed");
  }
  const resolved = realpathSync(candidate);
  if (!isWithinRoot(resolved, root)) {
    throw new Error("OMP session file is outside the bridge session directory");
  }
  rejectSymlinkComponents(resolved, root);
  if (!candidateStat.isFile()) {
    throw new Error("OMP session file is not a bridge-owned regular file");
  }
  return candidate;
}

function isOwnedSessionFile(value: string | undefined): boolean {
  if (!value || !value.includes(sep)) return false;
  try {
    validateOwnedSessionPath(value, true);
    return true;
  } catch {
    return false;
  }
}

function enqueueThreadOperation<T>(threadId: string, operation: () => Promise<T>): Promise<T> {
  const previous = threadOperationTails.get(threadId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  const tracked = current.then(() => undefined, () => undefined).finally(() => {
    if (threadOperationTails.get(threadId) === tracked) threadOperationTails.delete(threadId);
  });
  threadOperationTails.set(threadId, tracked);
  return current;
}

function optionRecord(options: unknown): Record<string, unknown> {
  return typeof options === "object" && options !== null
    ? (options as Record<string, unknown>)
    : {};
}

function stringRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] =>
      typeof entry[0] === "string" && typeof entry[1] === "string",
    ),
  );
}

function toBuildConfig(
  params: ThreadStartParams | ThreadResumeParams,
  overrides: Partial<Pick<OmpBuildConfig, "model" | "thinkingLevel">> = {},
): OmpBuildConfig {
  const options = optionRecord(params.options);
  const requestedModel = typeof options.model === "string" && options.model.length > 0
    ? options.model
    : undefined;
  const requestedReasoning = typeof options.reasoningLevel === "string"
    ? options.reasoningLevel
    : undefined;
  const permissionMode = options.permissionMode;
  return {
    cwd: params.cwd,
    ...(overrides.model !== undefined
      ? { model: overrides.model }
      : requestedModel === undefined ? {} : { model: requestedModel }),
    ...(overrides.thinkingLevel !== undefined
      ? { thinkingLevel: overrides.thinkingLevel }
      : requestedReasoning === undefined
        ? {}
        : { thinkingLevel: REASONING_TO_OMP[requestedReasoning] ?? requestedReasoning }),
    ...(typeof options.instructions === "string"
      ? { instructions: options.instructions }
      : {}),
    instructionMode: params.instructionMode,
    envVars: stringRecord(options.envVars),
    // This provider intentionally exposes only `full`; in that mode OMP's
    // native tool runner must not pause on its terminal UI approval prompt.
    autoApprove: permissionMode === undefined || permissionMode === "full",
  };
}

function sessionOptions(
  config: OmpBuildConfig,
  providerThreadId: string | undefined,
  threadId: string,
  serial: number,
  resumePath: string | undefined,
): OmpSessionOptions {
  const launch = resolveOmpLaunch(process.env);
  const dirs = ensureBridgeDirs();
  return {
    command: launch.command,
    baseArgs: launch.args,
    cwd: config.cwd,
    env: buildOmpChildEnv(buildShellEnvOverrides(config.envVars)),
    sessionDir: dirs.sessionDir,
    tempDir: dirs.tempDir,
    recordThreadId: threadId,
    ...(providerThreadId ? { providerThreadId } : {}),
    ...(resumePath ? { resumePath } : {}),
    ...(config.model ? { model: config.model } : {}),
    ...(config.thinkingLevel ? { thinkingLevel: config.thinkingLevel } : {}),
    ...(config.instructions !== undefined ? { instructions: config.instructions } : {}),
    instructionMode: config.instructionMode,
    autoApprove: config.autoApprove,
    onEvent: (event) => handleOmpEvent(threadId, serial, event),
    onUnmatchedResponse: (response) => handleOmpResponse(threadId, serial, response),
    onExit: (info) => handleOmpExit(threadId, serial, info),
  };
}

async function constructSession(
  threadId: string,
  providerThreadId: string | undefined,
  config: OmpBuildConfig,
): Promise<ThreadSession> {
  sessionSerial += 1;
  const serial = sessionSerial;
  const resumePath = providerThreadId && providerThreadId.includes(sep)
    ? validateOwnedSessionPath(providerThreadId, true)
    : undefined;
  const session = new OmpRpcSession(
    sessionOptions(config, providerThreadId, threadId, serial, resumePath),
  );
  pendingStarts.set(threadId, { session, serial });
  try {
    await session.start();
  } catch (error) {
    session.kill();
    throw error;
  } finally {
    const pending = pendingStarts.get(threadId);
    if (pending?.session === session) pendingStarts.delete(threadId);
  }
  const reportedProviderThreadId = session.providerThreadId;
  const candidateProviderThreadId = reportedProviderThreadId ?? providerThreadId;
  const safeProviderThreadId = candidateProviderThreadId &&
    (!candidateProviderThreadId.includes(sep) || isOwnedSessionFile(candidateProviderThreadId))
    ? candidateProviderThreadId
    : `omp-${randomUUID()}`;
  return {
    session,
    serial,
    threadId,
    providerThreadId: safeProviderThreadId,
    cwd: config.cwd,
    config,
    closing: false,
  };
}

function currentSession(threadId: string): ThreadSession | undefined {
  const session = sessions.get(threadId);
  return session && !session.closing ? session : undefined;
}

function handleOmpEvent(threadId: string, serial: number, event: Record<string, unknown>): void {
  const session = currentSession(threadId);
  if (!session || session.serial !== serial) return;
  const deltas = translator.translate(event, {
    threadId,
    cwd: session.cwd,
    modelContextWindow: session.session.modelContextWindow,
  });
  sendDeltas(threadId, deltas);
  if (
    event.type === "agent_end" ||
    event.type === "compaction_end" ||
    event.type === "auto_compaction_end"
  ) {
    void refreshContextWindow(session);
  }
}

async function refreshContextWindow(session: ThreadSession): Promise<void> {
  const current = sessions.get(session.threadId);
  if (current !== session || session.closing) return;
  try {
    const state = await session.session.getState();
    const usage = state.contextUsage;
    const used = usage?.tokens;
    const size = usage?.contextWindow ?? session.session.modelContextWindow;
    if (
      (typeof used !== "number" && used !== null && used !== undefined) ||
      (typeof size !== "number" && size !== null && size !== undefined)
    ) {
      return;
    }
    if (used === undefined && size === undefined) return;
    sendDeltas(session.threadId, [{
      kind: "contextWindow",
      used: typeof used === "number" ? used : null,
      size: typeof size === "number" && size > 0 ? size : null,
      estimated: true,
      attach: "currentOrLast",
    }]);
  } catch {
    // A provider that exits immediately after agent_end has no stats to read.
  }
}

function handleOmpResponse(threadId: string, serial: number, response: OmpRpcResponse): void {
  const session = currentSession(threadId);
  if (!session || session.serial !== serial || response.success) return;
  const detail = response.error ?? "OMP rejected an asynchronous command";
  sendDeltas(threadId, [{
    kind: "provider.error",
    message: "OMP provider error",
    detail,
    ...(session.session.isActive ? { settlesTurn: true } : {}),
  }]);
}

function handleOmpExit(threadId: string, serial: number, info: OmpRpcChildExitInfo): void {
  const session = sessions.get(threadId);
  if (!session || session.serial !== serial || session.closing) return;
  const detail = info.stderrTail.trim() || "The OMP process exited unexpectedly.";
  sendDeltas(threadId, [{
    kind: "provider.error",
    message: "OMP process exited",
    detail,
    ...(session.session.isActive ? { settlesTurn: true } : {}),
    threadScoped: true,
  }]);
  session.closing = true;
  sessions.delete(threadId);
}

async function closeSession(threadId: string, reason: string): Promise<void> {
  const session = sessions.get(threadId);
  if (session) {
    session.closing = true;
    sessions.delete(threadId);
    await session.session.close(8_000).catch((error: unknown) => {
      process.stderr.write(`omp bridge: ${reason}: ${String(error)}\n`);
    });
    return;
  }
  const pending = pendingStarts.get(threadId);
  if (!pending) return;
  pending.session.kill();
  await pending.session.close(8_000).catch((error: unknown) => {
    process.stderr.write(`omp bridge: ${reason}: ${String(error)}\n`);
  });
}

function sendSessionStarted(id: string | number, session: ThreadSession): void {
  const restorable = isOwnedSessionFile(session.providerThreadId);
  notify(BRIDGE_NOTIFICATION_METHODS.threadIdentity, {
    threadId: session.threadId,
    providerThreadId: session.providerThreadId,
    sessionRestorable: restorable,
  });
  translator.resetThread(session.threadId);
  sendDeltas(session.threadId, [{ kind: "session.reset" }]);
  io.sendResult(id, {
    providerThreadId: session.providerThreadId,
    sessionRestorable: restorable,
  });
}

async function handleThreadStart(
  id: string | number,
  params: ThreadStartParams | ThreadResumeParams,
  resume: boolean,
): Promise<void> {
  const config = toBuildConfig(params);
  const providerThreadId = resume
    ? (params as ThreadResumeParams).providerThreadId
    : undefined;
  try {
    if (sessions.has(params.threadId) || pendingStarts.has(params.threadId)) {
      await closeSession(params.threadId, "replacing thread session");
    }
    const session = await constructSession(params.threadId, providerThreadId, config);
    sessions.set(params.threadId, session);
    sendSessionStarted(id, session);
    const initialInput = (params as { input?: readonly unknown[] }).input;
    if (initialInput && initialInput.length > 0) {
      const extracted = extractInput(initialInput);
      if (extracted.text || extracted.images.length > 0) {
        void session.session.prompt(extracted.text ?? "[image attachment]", extracted.images)
          .catch((error: unknown) => handleOmpResponse(params.threadId, session.serial, {
            type: "response",
            success: false,
            error: error instanceof Error ? error.message : String(error),
          }));
      }
    }
  } catch (error) {
    io.sendError(id, -32_000, error instanceof Error ? error.message : String(error));
  }
}

async function reconcileSession(
  params: TurnStartParams,
  session: ThreadSession,
): Promise<ThreadSession> {
  const options = optionRecord(params.options);
  const requestedModel = typeof options.model === "string" && options.model.length > 0
    ? options.model
    : session.config.model;
  const requestedReasoning = typeof options.reasoningLevel === "string"
    ? REASONING_TO_OMP[options.reasoningLevel] ?? options.reasoningLevel
    : session.config.thinkingLevel;
  if (
    requestedModel === session.config.model &&
    requestedReasoning === session.config.thinkingLevel
  ) {
    return session;
  }
  if (session.session.isActive) {
    throw new Error("Cannot change OMP model or thinking level while a turn is active");
  }
  const replacementConfig: OmpBuildConfig = {
    ...session.config,
    ...(requestedModel === undefined ? {} : { model: requestedModel }),
    ...(requestedReasoning === undefined ? {} : { thinkingLevel: requestedReasoning }),
  };
  session.closing = true;
  let replacement: ThreadSession;
  try {
    replacement = await constructSession(
      params.threadId,
      session.providerThreadId,
      replacementConfig,
    );
  } catch (error) {
    session.closing = false;
    throw error;
  }
  sessions.set(params.threadId, replacement);
  await session.session.close(8_000).catch((error: unknown) => {
    process.stderr.write(`omp bridge: replacing OMP session: ${String(error)}\n`);
  });
  translator.resetThread(params.threadId);
  const restorable = isOwnedSessionFile(replacement.providerThreadId);
  notify(BRIDGE_NOTIFICATION_METHODS.threadIdentity, {
    threadId: params.threadId,
    providerThreadId: replacement.providerThreadId,
    sessionRestorable: restorable,
  });
  sendDeltas(params.threadId, [{ kind: "session.reset" }]);
  notify(BRIDGE_NOTIFICATION_METHODS.sessionReplaced, {
    threadId: params.threadId,
    providerThreadId: replacement.providerThreadId,
    reason: "OMP model or thinking level changed; the session was rebuilt.",
    contextLost: !restorable,
  });
  return replacement;
}

async function handleTurnStart(id: string | number, params: TurnStartParams): Promise<void> {
  const live = currentSession(params.threadId);
  if (!live) {
    io.sendError(id, -32_000, "No active OMP session");
    return;
  }
  let session: ThreadSession;
  try {
    session = await reconcileSession(params, live);
  } catch (error) {
    io.sendError(id, -32_000, error instanceof Error ? error.message : String(error));
    return;
  }

  if (isStandaloneBuiltinCompactCommand(params.input)) {
    try {
      await session.session.compact();
      sendDeltas(params.threadId, [{ kind: "input.accepted", clientRequestId: params.clientRequestId }]);
      io.sendResult(id, { threadId: params.threadId });
    } catch (error) {
      io.sendError(id, -32_001, error instanceof Error ? error.message : String(error));
    }
    return;
  }

  const extracted = extractInput(params.input);
  if (!extracted.text && extracted.images.length === 0) {
    invalidParams(id, BRIDGE_REQUEST_METHODS.turnStart, "Missing input text");
    return;
  }
  try {
    await session.session.prompt(extracted.text ?? "[image attachment]", extracted.images);
    sendDeltas(params.threadId, [{ kind: "input.accepted", clientRequestId: params.clientRequestId }]);
    io.sendResult(id, { threadId: params.threadId });
  } catch (error) {
    io.sendError(id, -32_000, error instanceof Error ? error.message : String(error));
  }
}

async function handleTurnSteer(id: string | number, params: TurnSteerParams): Promise<void> {
  const session = currentSession(params.threadId);
  if (!session) {
    io.sendError(id, -32_000, "No active OMP session");
    return;
  }
  const extracted = extractInput(params.input);
  if (!extracted.text && extracted.images.length === 0) {
    invalidParams(id, BRIDGE_REQUEST_METHODS.turnSteer, "Missing input text");
    return;
  }
  if (!session.session.isActive) {
    io.sendError(id, -32_001, "No active OMP turn");
    return;
  }
  try {
    await session.session.steer(extracted.text ?? "[image attachment]", extracted.images);
    sendDeltas(params.threadId, [{ kind: "input.accepted", clientRequestId: params.clientRequestId }]);
    io.sendResult(id, { threadId: params.threadId });
  } catch (error) {
    io.sendError(id, -32_001, error instanceof Error ? error.message : String(error));
  }
}

async function handleThreadStop(id: string | number, params: ThreadStopParams): Promise<void> {
  const session = currentSession(params.threadId);
  if (params.intent === "interrupt" && session) {
    sendDeltas(params.threadId, [{ kind: "session.ended" }]);
  }
  await closeSession(params.threadId, "stopping thread");
  io.sendResult(id, { ok: true, providerCheckpointId: null });
}

function cancelPendingStart(threadId: string): void {
  pendingStarts.get(threadId)?.session.kill();
}

async function handleThreadDiscard(id: string | number, params: ThreadDiscardParams): Promise<void> {
  await closeSession(params.threadId, "discarding thread");
  if (params.providerThreadId.includes(sep)) {
    const candidate = validateOwnedSessionPath(params.providerThreadId, true);
    rmSync(candidate, { force: true });
  }
  io.sendResult(id, { ok: true });
}

function extractInput(input: readonly unknown[]): { text?: string; images: unknown[] } {
  const text: string[] = [];
  const images: unknown[] = [];
  for (const item of input) {
    if (typeof item !== "object" || item === null) continue;
    const value = item as Record<string, unknown>;
    if (value.type === "text" && typeof value.text === "string") {
      text.push(value.text);
      continue;
    }
    if (value.type === "localImage" && typeof value.path === "string") {
      try {
        images.push({
          type: "image",
          data: readFileSync(value.path).toString("base64"),
          mimeType: typeof value.mimeType === "string"
            ? value.mimeType
            : mimeTypeFromExtension(value.path),
        });
      } catch {
        // The runtime already owns attachment validation; skip unreadable files.
      }
      continue;
    }
    if (value.type === "image" && typeof value.url === "string") {
      text.push(`[Image attachment: ${value.url}]`);
      continue;
    }
    if (value.type === "localFile" && typeof value.path === "string") {
      text.push(`[Attached file: ${value.path}]`);
    }
  }
  return {
    ...(text.length > 0 ? { text: text.join("\n") } : {}),
    images,
  };
}

function modelReasoningLevels(model: Record<string, unknown>): {
  supportedReasoningEfforts: AvailableModel["supportedReasoningEfforts"];
  defaultReasoningEffort: string;
} {
  const rawThinking = Array.isArray(model.thinking)
    ? model.thinking.filter((value): value is string => typeof value === "string")
    : [];
  const values = rawThinking.length > 0
    ? rawThinking
    : model.reasoning === true ? ["low", "medium", "high"] : ["off"];
  const mapped = new Set<string>();
  for (const value of values) {
    const level = OMP_TO_REASONING[value] ?? value;
    if (REASONING_ORDER.includes(level)) mapped.add(level);
  }
  if (model.reasoning === true) mapped.add("none");
  if (mapped.size === 0) mapped.add("none");
  const levels = [...mapped].sort((a, b) => REASONING_ORDER.indexOf(a) - REASONING_ORDER.indexOf(b));
  return {
    supportedReasoningEfforts: levels.map((level) => ({
      reasoningEffort: level as AvailableModel["supportedReasoningEfforts"][number]["reasoningEffort"],
      description: level === "none" ? "None" : level[0].toUpperCase() + level.slice(1),
    })),
    defaultReasoningEffort: levels.includes("medium") ? "medium" : levels[0],
  };
}

export function mapOmpModels(value: unknown): AvailableModel[] {
  const models = typeof value === "object" && value !== null
    ? (value as Record<string, unknown>).models
    : undefined;
  if (!Array.isArray(models)) return [];
  const mapped: AvailableModel[] = [];
  for (const raw of models) {
    if (typeof raw !== "object" || raw === null) continue;
    const model = raw as Record<string, unknown>;
    const provider = typeof model.provider === "string" ? model.provider : "";
    const modelId = typeof model.id === "string" ? model.id : "";
    if (!provider || !modelId) continue;
    const selector = typeof model.selector === "string" && model.selector.length > 0
      ? model.selector
      : `${provider}/${modelId}`;
    const reasoning = modelReasoningLevels(model);
    mapped.push({
      id: selector,
      model: selector,
      displayName: typeof model.name === "string" ? model.name : modelId,
      description: `${provider} model via OhMyPi`,
      routeProviderId: provider,
      supportedReasoningEfforts: reasoning.supportedReasoningEfforts,
      defaultReasoningEffort: reasoning.defaultReasoningEffort as AvailableModel["defaultReasoningEffort"],
      isDefault: false,
    });
  }
  const preferred = mapped.find((model) => model.id === "openai-codex/gpt-5.6-sol") ?? mapped[0];
  return mapped.map((model) => ({ ...model, isDefault: model === preferred }));
}

export function execOmp(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    const child = execFile(
      command,
      [...args],
      {
        timeout: 15_000,
        maxBuffer: 10 * 1024 * 1024,
        ...(options.cwd ? { cwd: options.cwd } : {}),
        env: options.env ?? buildOmpChildEnv(),
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr ?? "").trim();
          reject(new Error(detail || error.message));
          return;
        }
        resolveOutput(String(stdout));
      },
    );
    // OMP's non-interactive catalog/version commands still observe stdin.
    // Leaving execFile's pipe open makes them wait forever when the bridge is
    // hosted by BB, which then turns a healthy catalog into the provider's
    // fallback model after the host timeout.
    child.stdin?.end();
  });
}

const cachedModels = new Map<string, { models: AvailableModel[]; cachedAt: number }>();
const pendingModelLoads = new Map<string, Promise<AvailableModel[]>>();

interface ModelCatalogResult {
  models: AvailableModel[];
  error?: string;
}

async function queryModelCatalog(
  cwd: string,
  launch: ReturnType<typeof resolveOmpLaunch>,
  options: { refresh?: boolean } = {},
): Promise<ModelCatalogResult> {
  if (options.refresh) {
    try {
      // `omp models --json` reads OMP's persistent models.db. Refresh that
      // database first so newly loaded local models (LM Studio in particular)
      // are visible to the bridge instead of being masked by OMP's catalog
      // cache. Keep listing even when one remote provider makes refresh exit
      // non-zero; the refreshed local providers may still be usable.
      await execOmp(
        launch.command,
        [...launch.args, "models", "refresh"],
        { cwd },
      );
    } catch (error) {
      process.stderr.write(`omp bridge: unable to refresh model catalog: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  try {
    const stdout = await execOmp(
      launch.command,
      [...launch.args, "models", "--json"],
      { cwd },
    );
    return { models: mapOmpModels(JSON.parse(stdout)) };
  } catch (error) {
    return {
      models: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function loadOmpModels(cwd = process.cwd()): Promise<AvailableModel[]> {
  let launch: ReturnType<typeof resolveOmpLaunch>;
  try {
    launch = resolveOmpLaunch(process.env);
  } catch (error) {
    process.stderr.write(`omp bridge: ${String(error)}\n`);
    return [];
  }
  const cacheKey = `${cwd}\0${launch.command}\0${JSON.stringify(launch.args)}`;
  const cached = cachedModels.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < 60_000) return cached.models;
  const pending = pendingModelLoads.get(cacheKey);
  if (pending) return pending;

  const load = (async (): Promise<AvailableModel[]> => {
    const result = await queryModelCatalog(cwd, launch, { refresh: true });
    if (result.models.length > 0) {
      cachedModels.set(cacheKey, { models: result.models, cachedAt: Date.now() });
      return result.models;
    }
    if (result.error) {
      process.stderr.write(`omp bridge: unable to load model catalog: ${result.error}\n`);
    }
    return cached?.models ?? [];
  })();
  pendingModelLoads.set(cacheKey, load);
  try {
    return await load;
  } finally {
    if (pendingModelLoads.get(cacheKey) === load) pendingModelLoads.delete(cacheKey);
  }
}

async function handleProviderHealth(id: string | number, cwd = process.cwd()): Promise<void> {
  let launch: ReturnType<typeof resolveOmpLaunch>;
  try {
    launch = resolveOmpLaunch(process.env);
  } catch (error) {
    io.sendResult(id, {
      supported: true,
      health: {
        status: "unknown",
        statusMessage: String(error),
        accountEmail: null,
        planLabel: null,
        installedVersion: null,
        minimumSupportedVersion: null,
        canInstall: false,
        canUpdate: false,
        loginCommand: "omp",
      },
    });
    return;
  }
  let version: string;
  try {
    version = (await execOmp(launch.command, [...launch.args, "--version"], { cwd })).trim();
  } catch (error) {
    io.sendResult(id, {
      supported: true,
      health: {
        status: "not_installed",
        statusMessage: `Could not run the omp executable: ${error instanceof Error ? error.message : String(error)}`,
        accountEmail: null,
        planLabel: null,
        installedVersion: null,
        minimumSupportedVersion: null,
        canInstall: false,
        canUpdate: false,
        loginCommand: "omp",
      },
    });
    return;
  }
  const catalog = await queryModelCatalog(cwd, launch);
  const status = catalog.error
    ? "unknown"
    : catalog.models.length > 0 ? "ready" : "unauthenticated";
  const statusMessage = catalog.error
    ? `OMP model catalog failed: ${catalog.error}`
    : catalog.models.length > 0 ? null : "OMP has no model catalog available.";
  io.sendResult(id, {
    supported: true,
    health: {
      status,
      statusMessage,
      accountEmail: null,
      planLabel: null,
      installedVersion: version || null,
      minimumSupportedVersion: null,
      canInstall: false,
      canUpdate: false,
      loginCommand: "omp",
    },
  });
}

async function handleRequest(id: string | number, method: string, params: unknown): Promise<void> {
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
          steerMode: "inject",
        },
      });
      return;
    }
    case BRIDGE_REQUEST_METHODS.modelList: {
      const parsed = modelListParamsSchema.safeParse(params ?? {});
      if (!parsed.success) return invalidParams(id, method, parsed.error.issues);
      io.sendResult(id, { models: await loadOmpModels(parsed.data.cwd), selectedOnlyModels: [] });
      return;
    }
    case BRIDGE_REQUEST_METHODS.providerHealth: {
      const parsed = providerMaintenanceParamsSchema.safeParse(params ?? {});
      if (!parsed.success) return invalidParams(id, method, parsed.error.issues);
      await handleProviderHealth(id, parsed.data.cwd);
      return;
    }
    case BRIDGE_REQUEST_METHODS.threadStart: {
      const parsed = threadStartParamsSchema.safeParse(params ?? {});
      if (!parsed.success) return invalidParams(id, method, parsed.error.issues);
      await enqueueThreadOperation(parsed.data.threadId, () => handleThreadStart(id, parsed.data, false));
      return;
    }
    case BRIDGE_REQUEST_METHODS.threadResume: {
      const parsed = threadResumeParamsSchema.safeParse(params ?? {});
      if (!parsed.success) return invalidParams(id, method, parsed.error.issues);
      await enqueueThreadOperation(parsed.data.threadId, () => handleThreadStart(id, parsed.data, true));
      return;
    }
    case BRIDGE_REQUEST_METHODS.turnStart: {
      const parsed = turnStartParamsSchema.safeParse(params ?? {});
      if (!parsed.success) return invalidParams(id, method, parsed.error.issues);
      await enqueueThreadOperation(parsed.data.threadId, () => handleTurnStart(id, parsed.data));
      return;
    }
    case BRIDGE_REQUEST_METHODS.turnSteer: {
      const parsed = turnSteerParamsSchema.safeParse(params ?? {});
      if (!parsed.success) return invalidParams(id, method, parsed.error.issues);
      await enqueueThreadOperation(parsed.data.threadId, () => handleTurnSteer(id, parsed.data));
      return;
    }
    case BRIDGE_REQUEST_METHODS.threadStop: {
      const parsed = threadStopParamsSchema.safeParse(params ?? {});
      if (!parsed.success) return invalidParams(id, method, parsed.error.issues);
      cancelPendingStart(parsed.data.threadId);
      await enqueueThreadOperation(parsed.data.threadId, () => handleThreadStop(id, parsed.data));
      return;
    }
    case BRIDGE_REQUEST_METHODS.threadDiscard: {
      const parsed = threadDiscardParamsSchema.safeParse(params ?? {});
      if (!parsed.success) return invalidParams(id, method, parsed.error.issues);
      cancelPendingStart(parsed.data.threadId);
      await enqueueThreadOperation(parsed.data.threadId, () => handleThreadDiscard(id, parsed.data));
      return;
    }
    default:
      io.sendError(id, BRIDGE_JSON_RPC_ERRORS.METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

function handleParsedMessage(raw: unknown): void {
  const envelope = bridgeRequestEnvelopeSchema.safeParse(raw);
  if (!envelope.success) return;
  const request = envelope.data;
  runBridgeRequest({
    request,
    sendError: io.sendError,
    handleRequest: async (value) => {
      await handleRequest(value.id, request.method, request.params);
    },
  });
}

const lineHandler = createBridgeLineHandler({ handleParsedMessage });

export function handleLine(line: string): void {
  lineHandler(line);
}

async function shutdown(): Promise<void> {
  const threadIds = new Set([...sessions.keys(), ...pendingStarts.keys()]);
  for (const threadId of threadIds) cancelPendingStart(threadId);
  await Promise.all([...threadIds].map((threadId) => closeSession(threadId, "bridge shutdown")));
}

export const experimental_providerBridge = experimental_defineProviderBridge({
  handleLine,
  start(context) {
    bridgeDataDir = context.dataDir;
    bridgeTempDir = context.tempDir;
    ensureBridgeDirs();
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
