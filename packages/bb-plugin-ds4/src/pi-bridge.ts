// Pi-bridge for DwarfStar: transparent proxy to BB's stock provider-pi bridge.
//
// This is byte-for-byte stock Pi behavior (pi --mode rpc + BB_PI_EXTENSION,
// dynamicTools/MCP, skills, fork, compaction) with one addition: a DS4
// lifecycle gate. Before a session-affecting request reaches the stock bridge,
// we ensure ds4-server is up and serving the configured GGUF. Everything else
// (all methods, all deltas, all inbound tool calls) passes through untouched.
//
// Server-side (server.ts) keeps owning ds4-server start/stop/idle/health.

import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  BRIDGE_JSON_RPC_ERRORS,
  THREAD_DELTA_NOTIFICATION_METHOD,
  createBridgeIo,
  createBridgeLineHandler,
  experimental_defineProviderBridge,
} from "@get-bb/plugin-sdk/provider-bridge";
import {
  resolveConfig,
  type ResolvedRunConfig,
  type RunSettings,
  DEFAULT_DWARFSTAR_CONTEXT_TOKENS,
} from "./run-config.ts";
import { isDwarfStarModel } from "./model-selection.ts";
import { isUsableModelFile } from "./model-download.ts";
import { Ds4Process } from "./ds4-process.ts";
import {
  isProcessAlive,
  processMatchesCommand,
  processStartTime,
  readProcessRecord,
  writeProcessRecord,
  writeProviderTurnLease,
  clearProviderTurnLease,
} from "./process-recovery.ts";

const BRIDGE_PLUGIN_ID = "ds4";
const BRIDGE_PROCESS_RECORD_ID = "ds4-provider-bridge";
const STARTUP_TIMEOUT_MS = 10 * 60 * 1000;
const STARTUP_POLL_MS = 500;
const PROVIDER_TURN_LEASE_TTL_MS = 15_000;
const PROVIDER_TURN_LEASE_HEARTBEAT_MS = 5_000;

type JsonRpcId = string | number;

const dwarfStarOptionsSchema = z
  .object({
    model: z.string().optional(),
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

type DwarfStarOptions = z.infer<typeof dwarfStarOptionsSchema>;

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

function settingsForOptions(options: DwarfStarOptions): RunSettings {
  return {
    ds4Dir: options.ds4Dir,
    modelPath: options.modelPath,
    modelPreset: options.modelPreset,
    visionPath: options.visionPath,
    backend: options.backend as RunSettings["backend"],
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

function configError(cfg: ResolvedRunConfig): string | null {
  if (!cfg.bin || !cfg.ds4Dir) {
    return "DwarfStar is not installed. Set the DS4 checkout directory in Settings.";
  }
  if (!existsSync(cfg.bin)) return `ds4-server was not found at ${cfg.bin}.`;
  if (!cfg.modelPath) {
    return "No DwarfStar model GGUF was found. Set modelPath or download a supported model.";
  }
  if (!isUsableModelFile(cfg.modelPath)) return `Model not found: ${cfg.modelPath}.`;
  return null;
}

// --- Model id mapping: our picker uses dwarfstar/*, Pi's catalog uses ds4/* ---

function toPiModelId(id: string): string {
  if (id === "dwarfstar-configured" || id === "dwarfstar/dwarfstar-configured") {
    return "ds4/deepseek-v4-flash";
  }
  return id.replace(/^dwarfstar\//, "ds4/").replace(/^acp-dwarfstar\//, "ds4/");
}

function toDwarfStarModelId(id: string): string {
  return id.replace(/^ds4\//, "dwarfstar/");
}

function rewriteOutboundParams(params: unknown): void {
  if (params === null || typeof params !== "object" || Array.isArray(params)) return;
  const record = params as Record<string, unknown>;
  const options = record.options;
  if (options !== null && typeof options === "object" && !Array.isArray(options)) {
    const optRecord = options as Record<string, unknown>;
    if (typeof optRecord.model === "string") optRecord.model = toPiModelId(optRecord.model);
  }
}

// --- DS4 lifecycle (ensure ds4-server is serving before Pi starts) ---

const io = createBridgeIo<Record<string, unknown>>();
const ds4Process = new Ds4Process(2000);
let bridgeDataDir: string | null = null;

async function requestModels(
  endpoint: { host: string; port: number },
  signal: AbortSignal,
): Promise<string[]> {
  const res = await fetch(`http://${endpoint.host}:${endpoint.port}/v1/models`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(2500)]),
  });
  if (!res.ok) throw new Error(`health ${res.status}`);
  const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
  return (body.data ?? [])
    .map((d) => (typeof d.id === "string" ? d.id : ""))
    .filter(Boolean);
}

async function waitForReady(
  endpoint: { host: string; port: number },
  signal: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error("DwarfStar startup was cancelled.");
    if (!ds4Process.isRunning) throw new Error("ds4-server exited before becoming ready.");
    try {
      const models = await requestModels(endpoint, signal);
      if (models.length === 0 || models.some(isDwarfStarModel)) return;
    } catch {
      // Still loading; keep polling.
    }
    await new Promise((r) => setTimeout(r, STARTUP_POLL_MS));
  }
  throw new Error("DwarfStar did not become ready in time.");
}

async function ensureReady(options: DwarfStarOptions, signal: AbortSignal): Promise<void> {
  const cfg = resolveConfig(settingsForOptions(options));
  const error = configError(cfg);
  if (error) throw new Error(error);
  const endpoint = { host: cfg.host, port: cfg.port };
  const record = readProcessRecord(BRIDGE_PROCESS_RECORD_ID);
  if (
    record &&
    record.fingerprint === cfg.fingerprint &&
    isProcessAlive(record.pid) &&
    processMatchesCommand(record.pid, record.bin, record.args, record.cwd)
  ) {
    ds4Process.adopt(record.pid, {
      ownership: record.ownership as "managed" | "external",
      cmdline: [record.bin, ...record.args],
      cwd: record.cwd,
      startedAt: record.startedAt,
    });
    await waitForReady(
      { host: record.host as string, port: record.port as number },
      signal,
    );
    return;
  }
  try {
    const models = await requestModels(endpoint, signal);
    if (models.length > 0) return;
  } catch {
    // Not listening; start it below.
  }
  if (!ds4Process.isRunning) {
    ds4Process.start({
      bin: cfg.bin as string,
      args: cfg.args,
      cwd: cfg.ds4Dir as string,
      onExit: () => undefined,
    });
    if (ds4Process.pid) {
      writeProcessRecord(BRIDGE_PROCESS_RECORD_ID, {
        pid: ds4Process.pid,
        fingerprint: cfg.fingerprint,
        bin: cfg.bin as string,
        args: cfg.args,
        cwd: cfg.ds4Dir as string,
        startedAt: Date.now(),
        host: endpoint.host,
        port: endpoint.port,
        ownership: "managed",
        processStartedAt: processStartTime(ds4Process.pid) ?? undefined,
      });
    }
  }
  await waitForReady(endpoint, signal);
}

// --- Provider turn leases (lets the server supervisor veto idle-stop mid-turn) ---

let providerTurnLeaseCount = 0;
let providerTurnLeaseTimer: NodeJS.Timeout | null = null;
const providerTurnLeaseId = `${process.pid}-${randomUUID()}`;

function refreshLease(): void {
  writeProviderTurnLease(BRIDGE_PLUGIN_ID, {
    leaseId: providerTurnLeaseId,
    pid: process.pid,
    expiresAt: Date.now() + PROVIDER_TURN_LEASE_TTL_MS,
  });
}

function acquireLease(): () => void {
  providerTurnLeaseCount += 1;
  if (providerTurnLeaseCount === 1) {
    refreshLease();
    providerTurnLeaseTimer = setInterval(refreshLease, PROVIDER_TURN_LEASE_HEARTBEAT_MS);
    providerTurnLeaseTimer.unref?.();
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    providerTurnLeaseCount = Math.max(0, providerTurnLeaseCount - 1);
    if (providerTurnLeaseCount === 0 && providerTurnLeaseTimer) {
      clearInterval(providerTurnLeaseTimer);
      providerTurnLeaseTimer = null;
    }
  };
}

// One lease per thread with an open turn; released on turn.boundary.
const threadLeases = new Map<string, Array<() => void>>();

function leaseForTurn(threadId: string): void {
  const list = threadLeases.get(threadId) ?? [];
  list.push(acquireLease());
  threadLeases.set(threadId, list);
}

function releaseForBoundary(threadId: string): void {
  const list = threadLeases.get(threadId);
  const release = list?.shift();
  release?.();
  if (list && list.length === 0) threadLeases.delete(threadId);
}

function releaseAllLeases(): void {
  for (const list of threadLeases.values()) for (const release of list) release();
  threadLeases.clear();
  if (providerTurnLeaseTimer) {
    clearInterval(providerTurnLeaseTimer);
    providerTurnLeaseTimer = null;
  }
  providerTurnLeaseCount = 0;
  try {
    clearProviderTurnLease(BRIDGE_PLUGIN_ID, providerTurnLeaseId);
  } catch {
    // Best effort on shutdown.
  }
}

// --- Stock provider-pi bridge child ---

let piChild: ChildProcess | null = null;
let piChildDead = true;
const pendingModelLists = new Set<JsonRpcId>();

function discoverPiHost(): string | null {
  const artifacts = join(homedir(), ".bb", "plugin-host-artifacts", "provider-pi");
  try {
    const entries = readdirSync(artifacts);
    let best: { path: string; mtime: number } | null = null;
    for (const entry of entries) {
      const candidate = join(artifacts, entry, "host.mjs");
      try {
        const mtime = statSync(candidate).mtimeMs;
        if (!best || mtime > best.mtime) best = { path: candidate, mtime };
      } catch {
        // Skip entries without a staged host.
      }
    }
    if (best) return best.path;
  } catch {
    // Fall through to the bundled copy.
  }
  const bundled =
    "/Applications/bb Nightly.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/server/dist/builtin-plugins/provider-pi/dist/host.js";
  return existsSync(bundled) ? bundled : null;
}

function ensurePiChild(): ChildProcess {
  if (piChild && !piChildDead) return piChild;
  const harness = process.argv[1];
  const piHost = discoverPiHost();
  if (!piHost) throw new Error("Could not find the stock provider-pi bridge host.");
  const dataDir = join(
    bridgeDataDir ?? join(homedir(), ".bb", "plugins", BRIDGE_PLUGIN_ID),
    "pi-stock",
  );
  mkdirSync(dataDir, { recursive: true });
  const child = spawn(process.execPath, [harness, piHost, "ds4", dataDir], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  piChildDead = false;
  child.on("exit", () => {
    if (piChild === child) {
      piChild = null;
      piChildDead = true;
    }
  });
  let stderrTail = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrTail += chunk.toString("utf8").slice(-2000);
  });
  let stdoutBuffer = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutBuffer += chunk.toString("utf8");
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) forwardFromPi(line);
  });
  piChild = child;
  return child;
}

function forwardFromPi(line: string): void {
  if (!line.trim()) return;
  try {
    const msg = JSON.parse(line) as Record<string, unknown>;
    // Stock Pi returns its whole catalog; this provider only serves the local
    // DS4 models, re-exposed as dwarfstar/*.
    if (msg.method === undefined && pendingModelLists.has(msg.id as JsonRpcId)) {
      pendingModelLists.delete(msg.id as JsonRpcId);
      const result = msg.result as { models?: Array<Record<string, unknown>> } | undefined;
      if (result && Array.isArray(result.models)) {
        result.models = result.models.filter(
          (model) =>
            (typeof model.id === "string" &&
              (model.id.startsWith("ds4/") || model.id.startsWith("dwarfstar/"))) ||
            (typeof model.model === "string" &&
              (model.model.startsWith("ds4/") || model.model.startsWith("dwarfstar/"))),
        );
        for (const model of result.models) {
          if (typeof model.id === "string") model.id = toDwarfStarModelId(model.id);
          if (typeof model.model === "string") model.model = toDwarfStarModelId(model.model);
        }
      }
      process.stdout.write(`${JSON.stringify({ ...msg, result })}\n`);
      return;
    }
    // Release the turn lease when a turn settles.
    if (msg.method === THREAD_DELTA_NOTIFICATION_METHOD) {
      const params = msg.params as { threadId?: unknown; deltas?: unknown } | undefined;
      if (typeof params?.threadId === "string" && Array.isArray(params.deltas)) {
        for (const delta of params.deltas) {
          if (
            delta !== null &&
            typeof delta === "object" &&
            (delta as { kind?: unknown }).kind === "turn.boundary"
          ) {
            releaseForBoundary(params.threadId);
          }
        }
      }
    }
  } catch {
    // Non-JSON plumbing; forward untouched.
  }
  process.stdout.write(`${line}\n`);
}

// --- Inbound dispatch: health + lifecycle gate locally, everything else proxied ---

const SESSION_METHODS = new Set(["thread/start", "turn/start", "thread/resume"]);

function providerOptionsOf(params: unknown): { options: unknown; model: string | undefined } {
  const record =
    params !== null && typeof params === "object" && !Array.isArray(params)
      ? (params as Record<string, unknown>)
      : {};
  const options = record.options;
  const optRecord =
    options !== null && typeof options === "object" && !Array.isArray(options)
      ? (options as Record<string, unknown>)
      : {};
  return {
    options,
    model: typeof optRecord.model === "string" ? optRecord.model : undefined,
  };
}

function threadIdOf(params: unknown): string | null {
  if (params === null || typeof params !== "object" || Array.isArray(params)) return null;
  const threadId = (params as Record<string, unknown>).threadId;
  return typeof threadId === "string" ? threadId : null;
}

async function handleBridgeRequest(
  id: JsonRpcId,
  method: string,
  params: unknown,
): Promise<void> {
  if (method === "provider/health") {
    const { options, model } = providerOptionsOf(params);
    const cfg = resolveConfig(settingsForOptions(parseOptions(options, model)));
    const message = configError(cfg);
    const installed = Boolean(cfg.bin && cfg.ds4Dir && existsSync(cfg.bin as string));
    io.sendResult(id, {
      supported: true,
      health: {
        status: !installed ? "not_installed" : message ? "unknown" : "ready",
        statusMessage: message ?? (installed ? null : "Set the DS4 checkout directory."),
        accountEmail: null,
        planLabel: "Local DwarfStar",
        installedVersion: null,
        minimumSupportedVersion: null,
        canInstall: false,
        canUpdate: false,
        loginCommand: null,
      },
    });
    return;
  }

  const child = ensurePiChild();
  if (method === "model/list") pendingModelLists.add(id);
  if (SESSION_METHODS.has(method)) {
    const { options, model } = providerOptionsOf(params);
    rewriteOutboundParams(params);
    const threadId = threadIdOf(params);
    const hasInput = (() => {
      if (params === null || typeof params !== "object" || Array.isArray(params)) return false;
      const input = (params as Record<string, unknown>).input;
      return Array.isArray(input) && input.length > 0;
    })();
    try {
      await ensureReady(
        parseOptions(options, model ? toPiModelId(model) : undefined),
        AbortSignal.timeout(STARTUP_TIMEOUT_MS),
      );
    } catch (error) {
      pendingModelLists.delete(id);
      io.sendError(
        id,
        BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR,
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
    // Lease the turn *before* forwarding so the supervisor cannot idle-stop
    // DS4 between readiness and the first pi LLM call. Released on boundary.
    if (threadId && (method !== "thread/start" || hasInput)) leaseForTurn(threadId);
    child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return;
  }
  rewriteOutboundParams(params);
  child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
}

function handleParsedMessage(raw: unknown): void {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return;
  const message = raw as Record<string, unknown>;
  if (message.method === undefined) {
    // Reply to a stock-bridge inbound request (e.g. toolCall): pass through.
    try {
      ensurePiChild().stdin?.write(`${JSON.stringify(message)}\n`);
    } catch {
      // Child gone; the caller already timed out.
    }
    return;
  }
  const id = message.id;
  if (typeof id !== "string" && typeof id !== "number") return;
  const method = typeof message.method === "string" ? message.method : "";
  void handleBridgeRequest(id, method, message.params).catch((error: unknown) => {
    io.sendError(
      id,
      BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR,
      error instanceof Error ? error.message : String(error),
    );
  });
}

const lineHandler = createBridgeLineHandler({ handleParsedMessage });

export function handleLine(line: string): void {
  lineHandler(line);
}

function shutdown(): void {
  try {
    piChild?.kill("SIGTERM");
  } catch {
    // Already gone.
  }
  piChild = null;
  piChildDead = true;
  pendingModelLists.clear();
  releaseAllLeases();
}

export const experimental_providerBridge = experimental_defineProviderBridge({
  handleLine,
  start(context) {
    bridgeDataDir = context.dataDir ?? join(homedir(), ".bb", "plugins", BRIDGE_PLUGIN_ID);
  },
  onClose() {
    shutdown();
  },
  onSigterm() {
    shutdown();
  },
  onSigint() {
    shutdown();
  },
});
