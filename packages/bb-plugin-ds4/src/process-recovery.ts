// Best-effort helpers for recovering a ds4-server that survived the plugin
// worker which spawned it. The process record is only used to reclaim
// processes the plugin can positively identify; an unknown server is adopted
// for use but is never terminated automatically.

import {
  existsSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const PROCESS_PATH_FLAGS = new Set([
  "-m",
  "--model",
  "--vision",
  "--mtp",
  "--mtp-model",
  "--kv-disk-dir",
  "--dir-steering-file",
  "--trace",
  "--chdir",
]);

export const PROVIDER_TURN_LEASE_RELEASE_RETENTION_MS = 10_000;

export interface Ds4ProcessRecord {
  pid: number;
  fingerprint: string;
  bin: string;
  args: string[];
  cwd: string;
  startedAt: number;
  host?: string;
  port?: number;
  ownership?: "managed" | "external";
  processStartedAt?: string;
}

export interface Ds4ProviderTurnLease {
  leaseId: string;
  pid: number;
  expiresAt: number;
  processStartedAt?: string;
  releasedAt?: number;
}

export function providerTurnLeaseIsActive(
  lease: Ds4ProviderTurnLease,
  now = Date.now(),
  observedProcessStartedAt: string | null = null,
): boolean {
  return (
    lease.expiresAt > now &&
    (!lease.processStartedAt ||
      !observedProcessStartedAt ||
      lease.processStartedAt === observedProcessStartedAt)
  );
}

export function processRecordPath(pluginId: string): string {
  return join(homedir(), ".bb", "plugins", pluginId, "server.json");
}

export function providerTurnLeasePath(pluginId: string): string {
  return join(homedir(), ".bb", "plugins", pluginId, "provider-lease.json");
}

export function readProviderTurnLease(pluginId: string): Ds4ProviderTurnLease | null {
  try {
    const path = providerTurnLeasePath(pluginId);
    if (!existsSync(path)) return null;
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<Ds4ProviderTurnLease>;
    if (
      typeof value.leaseId !== "string" ||
      value.leaseId.length === 0 ||
      typeof value.pid !== "number" ||
      !Number.isInteger(value.pid) ||
      value.pid <= 0 ||
      typeof value.expiresAt !== "number" ||
      !Number.isFinite(value.expiresAt)
    ) {
      return null;
    }
    return {
      leaseId: value.leaseId,
      pid: value.pid,
      expiresAt: value.expiresAt,
      ...(typeof value.processStartedAt === "string"
        ? { processStartedAt: value.processStartedAt }
        : {}),
      ...(typeof value.releasedAt === "number" && Number.isFinite(value.releasedAt)
        ? { releasedAt: value.releasedAt }
        : {}),
    };
  } catch {
    return null;
  }
}

export function writeProviderTurnLease(
  pluginId: string,
  lease: Ds4ProviderTurnLease,
): void {
  try {
    const path = providerTurnLeasePath(pluginId);
    const directory = join(homedir(), ".bb", "plugins", pluginId);
    mkdirSync(directory, { recursive: true });
    const temporaryPath = join(directory, `provider-lease.json.tmp-${process.pid}`);
    writeFileSync(temporaryPath, `${JSON.stringify(lease)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporaryPath, path);
  } catch {
    // The lease is defensive coordination metadata and must never block a turn.
  }
}

export function clearProviderTurnLease(pluginId: string, leaseId?: string): void {
  const path = providerTurnLeasePath(pluginId);
  try {
    if (leaseId !== undefined) {
      const lease = readProviderTurnLease(pluginId);
      if (lease && lease.leaseId !== leaseId) return;
    }
    unlinkSync(path);
  } catch {
    // The lease may already be gone or expired.
  }
}

export function readProcessRecord(pluginId: string): Ds4ProcessRecord | null {
  const path = processRecordPath(pluginId);
  try {
    if (!existsSync(path)) return null;
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<Ds4ProcessRecord>;
    const pid = value.pid;
    if (
      typeof pid !== "number" ||
      !Number.isInteger(pid) ||
      pid <= 0 ||
      typeof value.fingerprint !== "string" ||
      typeof value.bin !== "string" ||
      !Array.isArray(value.args) ||
      !value.args.every((arg) => typeof arg === "string") ||
      typeof value.cwd !== "string" ||
      typeof value.startedAt !== "number"
    ) {
      return null;
    }
    return {
      pid,
      fingerprint: value.fingerprint,
      bin: value.bin,
      args: value.args,
      cwd: value.cwd,
      startedAt: value.startedAt,
      ...(typeof value.host === "string" ? { host: value.host } : {}),
      ...(typeof value.port === "number" && Number.isInteger(value.port)
        ? { port: value.port }
        : {}),
      ...(value.ownership === "managed" || value.ownership === "external"
        ? { ownership: value.ownership }
        : {}),
      ...(typeof value.processStartedAt === "string"
        ? { processStartedAt: value.processStartedAt }
        : {}),
    };
  } catch {
    return null;
  }
}

export function writeProcessRecord(pluginId: string, record: Ds4ProcessRecord): void {
  try {
    const path = processRecordPath(pluginId);
    const directory = join(homedir(), ".bb", "plugins", pluginId);
    mkdirSync(directory, { recursive: true });
    const temporaryPath = join(directory, `server.json.tmp-${process.pid}`);
    writeFileSync(temporaryPath, `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporaryPath, path);
  } catch {
    // Recovery metadata is best-effort and must never prevent startup.
  }
}

export function clearProcessRecord(pluginId: string, pid?: number | null): void {
  const path = processRecordPath(pluginId);
  try {
    if (pid !== undefined) {
      const record = readProcessRecord(pluginId);
      if (record && record.pid !== pid) return;
    }
    unlinkSync(path);
  } catch {
    // The record may already be gone.
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Return the command line for a PID on macOS/Linux, or null if unavailable. */
export function processCommand(pid: number): string | null {
  try {
    const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return command || null;
  } catch {
    return null;
  }
}

/** Return the operating-system working directory for a process when available. */
export function processWorkingDirectory(pid: number): string | null {
  try {
    const output = execFileSync(
      "lsof",
      ["-a", "-p", String(pid), "-d", "cwd", "-Fn"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const match = output.match(/^n(.+)$/m);
    if (match?.[1]) return match[1];
  } catch {
    // Fall through to pwdx on Linux and other systems that provide it.
  }
  try {
    const output = execFileSync("pwdx", [String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const match = output.match(/^\d+:\s+(.+)$/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Return the operating-system start signature for a PID when available. */
export function processStartTime(pid: number): string | null {
  try {
    const startedAt = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return startedAt || null;
  } catch {
    return null;
  }
}

/** Find a listening TCP process without invoking a shell. */
export function listeningPid(port: number): number | null {
  try {
    const output = execFileSync(
      "lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const match = output.match(/^p(\d+)$/m);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

export function parseExistingDs4Pid(text: string): number | null {
  const match = text.match(/another ds4 process is already running \(pid (\d+)\)/i);
  return match ? Number(match[1]) : null;
}

export function processMatchesCommand(
  pid: number,
  bin: string,
  args: string[],
  expectedCwd: string | null = null,
): boolean {
  const command = processCommand(pid);
  if (!command) return false;
  const tokens = tokenizeProcessCommand(command);
  if (tokens.length !== args.length + 1) return false;
  const executable = tokens[0];
  const exactArgs = args.every((arg, index) => tokens[index + 1] === arg);
  const hasRelativePathArg = args.some(
    (arg, index) => isProcessPathArg(args, index) && !isAbsolute(arg),
  );
  if (executable === bin && exactArgs && (!expectedCwd || !hasRelativePathArg)) {
    return true;
  }

  const processCwd = processWorkingDirectory(pid);
  if (!processExecutableValuesMatch(executable, bin, processCwd, expectedCwd)) return false;
  return args.every((arg, index) =>
    processPathValuesMatch(
      tokens[index + 1],
      arg,
      processCwd,
      expectedCwd,
      isProcessPathArg(args, index),
    ),
  );
}

function processExecutableValuesMatch(
  actual: string,
  expected: string,
  actualCwd: string | null,
  expectedCwd: string | null,
): boolean {
  if (actual === expected) return true;
  const actualPath = canonicalProcessPath(actual, actualCwd);
  const expectedPath = canonicalProcessPath(expected, expectedCwd);
  return actualPath !== null && expectedPath !== null && actualPath === expectedPath;
}

function processPathValuesMatch(
  actual: string,
  expected: string,
  actualCwd: string | null,
  expectedCwd: string | null,
  forcePath = false,
): boolean {
  if (actual === expected && !forcePath) return true;
  if (!forcePath && !looksLikeProcessPath(actual) && !looksLikeProcessPath(expected)) {
    return false;
  }
  const actualPath = canonicalProcessPath(actual, actualCwd);
  const expectedPath = canonicalProcessPath(expected, expectedCwd);
  return actualPath !== null && expectedPath !== null && actualPath === expectedPath;
}

function isProcessPathArg(args: readonly string[], index: number): boolean {
  return index > 0 && PROCESS_PATH_FLAGS.has(args[index - 1]);
}

function looksLikeProcessPath(value: string): boolean {
  return (
    isAbsolute(value) ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.includes("/") ||
    /\.gguf(?:\.part)?$/i.test(value)
  );
}

function canonicalProcessPath(value: string, cwd: string | null): string | null {
  const path = isAbsolute(value) ? value : cwd ? resolve(cwd, value) : null;
  if (!path) return null;
  try {
    return realpathSync(path);
  } catch {
    if (!isAbsolute(value) && cwd) {
      try {
        return resolve(realpathSync(cwd), value);
      } catch {
        // Keep the resolved path when neither the target nor cwd exists.
      }
    }
    return path;
  }
}

/** Parse the argv-shaped output returned by `ps -o command=` without a shell. */
function tokenizeProcessCommand(command: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let started = false;

  for (const char of command.trim()) {
    if (escaped) {
      token += char;
      started = true;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else token += char;
      started = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        tokens.push(token);
        token = "";
        started = false;
      }
      continue;
    }
    token += char;
    started = true;
  }
  if (escaped) token += "\\";
  if (started) tokens.push(token);
  return tokens;
}
