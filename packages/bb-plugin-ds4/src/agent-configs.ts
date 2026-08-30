// Agent integration: write provider configs so local coding agents (pi,
// opencode, Codex CLI) can talk to the running ds4-server. Every writer
// merges into the existing file (never clobbers unrelated config) and keeps
// a timestamped backup next to the file.

import { existsSync, mkdirSync, readFileSync, copyFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type AgentTargetId = "pi" | "opencode" | "codex";

export interface AgentTargetStatus {
  id: AgentTargetId;
  label: string;
  path: string;
  exists: boolean;
  configured: boolean;
  detail: string;
  error?: string;
}

export interface ApplyResult {
  id: AgentTargetId;
  ok: boolean;
  path?: string;
  backup?: string;
  message: string;
}

export interface AgentConfigOpts {
  port: number;
  ctx: number;
  maxTokens: number;
  /** Primary model id (kept for compatibility with existing callers). */
  modelId: string;
  /**
   * Every model id to advertise, primary first. When omitted, only modelId
   * is written (previous single-model behavior).
   */
  modelIds?: string[];
}

const home = homedir();

function targetPath(id: AgentTargetId): string {
  switch (id) {
    case "pi":
      return join(home, ".pi", "agent", "models.json");
    case "opencode":
      // Prefer whichever file already exists (opencode reads both).
      for (const name of ["opencode.json", "opencode.jsonc"]) {
        const p = join(home, ".config", "opencode", name);
        if (existsSync(p)) return p;
      }
      return join(home, ".config", "opencode", "opencode.json");
    case "codex":
      return join(home, ".codex", "config.toml");
  }
}

// --- Tolerant JSON (pi's models.json is JSONC: comments + trailing commas) ---

function stripJsonc(src: string): string {
  let out = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  let prev = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];
    if (inLineComment) {
      if (c === "\n") {
        inLineComment = false;
        out += c;
      }
      prev = c;
      continue;
    }
    if (inBlockComment) {
      if (c === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      prev = c;
      continue;
    }
    if (inString) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i++;
      } else if (c === '"') {
        inString = false;
      }
      prev = c;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && next === "/") {
      inLineComment = true;
      i++;
    } else if (c === "/" && next === "*") {
      inBlockComment = true;
      i++;
    } else {
      out += c;
    }
    prev = c;
  }
  // strip trailing commas
  return out.replace(/,\s*([}\]])/g, "$1");
}

function parseJsonc(src: string): unknown {
  return JSON.parse(stripJsonc(src));
}

// --- pi ---

function modelLabel(modelId: string): string {
  switch (modelId) {
    case "deepseek-v4-flash":
      return "DeepSeek V4 Flash";
    case "deepseek-v4-pro":
      return "DeepSeek V4 PRO";
    case "glm-5.2":
      return "GLM 5.2";
    case "glm-5.3-flash":
      return "GLM 5.3 Flash";
    default:
      return modelId;
  }
}

export function piCompatibilityForModel(modelId: string) {
  const isGlm = modelId.trim().toLowerCase().startsWith("glm-") ||
    modelId.trim().toLowerCase().startsWith("zai/glm-");
  return {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort: true,
    supportsUsageInStreaming: true,
    maxTokensField: "max_tokens",
    supportsStrictMode: false,
    thinkingFormat: isGlm ? "zai" : "deepseek",
    ...(isGlm ? {} : { requiresReasoningContentOnAssistantMessages: true }),
  };
}

function piModelEntry(modelId: string, port: number, ctx: number, maxTokens: number) {
  return {
    id: modelId,
    name: `${modelLabel(modelId)} (ds4.c local)`,
    api: "openai-completions",
    provider: "ds4",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    reasoning: true,
    input: ["text"],
    contextWindow: ctx,
    maxTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: piCompatibilityForModel(modelId),
    thinkingLevelMap: {
      off: null,
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
    },
  };
}

function writePi(opts: AgentConfigOpts): ApplyResult {
  const path = targetPath("pi");
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const data: Record<string, unknown> = existsSync(path)
    ? (parseJsonc(readFileSync(path, "utf8")) as Record<string, unknown>)
    : {};
  const providers = ((data.providers as Record<string, unknown>) ?? {});
  const ids = opts.modelIds?.length ? opts.modelIds : [opts.modelId];
  providers["ds4"] = {
    name: "ds4.c local",
    baseUrl: `http://127.0.0.1:${opts.port}/v1`,
    api: "openai-completions",
    apiKey: "dsv4-local",
    compat: piCompatibilityForModel(opts.modelId),
    models: ids.map((id) => piModelEntry(id, opts.port, opts.ctx, opts.maxTokens)),
  };
  data["providers"] = providers;
  const backup = writeWithBackup(path, JSON.stringify(data, null, 2) + "\n");
  return {
    id: "pi",
    ok: true,
    path,
    backup,
    message: `Wrote provider "ds4" to ${path}`,
  };
}

function statusPi(): AgentTargetStatus {
  const path = targetPath("pi");
  if (!existsSync(path)) {
    return {
      id: "pi",
      label: "Pi / BB agent",
      path,
      exists: false,
      configured: false,
      detail: "File missing — will be created",
    };
  }
  try {
    const data = parseJsonc(readFileSync(path, "utf8")) as {
      providers?: Record<string, unknown>;
    };
    const configured = Boolean(data.providers?.["ds4"]);
    return {
      id: "pi",
      label: "Pi / BB agent",
      path,
      exists: true,
      configured,
      detail: configured
        ? 'Provider "ds4" present'
        : 'No "ds4" provider yet',
    };
  } catch (err) {
    return {
      id: "pi",
      label: "Pi / BB agent",
      path,
      exists: true,
      configured: false,
      detail: "Unparseable file",
      error: String(err),
    };
  }
}

// --- opencode ---

function writeOpencode(opts: AgentConfigOpts): ApplyResult {
  const path = targetPath("opencode");
  mkdirSync(dirname(path), { recursive: true });
  const data: Record<string, unknown> = existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)
    : { $schema: "https://opencode.ai/config.json" };
  const providers = ((data["provider"] as Record<string, unknown>) ?? {});
  const ids = opts.modelIds?.length ? opts.modelIds : [opts.modelId];
  const models: Record<string, unknown> = {};
  for (const id of ids) {
    models[id] = {
      name: `${modelLabel(id)} (ds4.c local)`,
      limit: { context: opts.ctx, output: opts.maxTokens },
    };
  }
  providers["ds4"] = {
    name: "ds4.c (local)",
    npm: "@ai-sdk/openai-compatible",
    options: {
      baseURL: `http://127.0.0.1:${opts.port}/v1`,
      apiKey: "dsv4-local",
    },
    models,
  };
  data["provider"] = providers;
  const agents = ((data["agent"] as Record<string, unknown>) ?? {});
  agents["ds4"] = {
    description: `${modelLabel(opts.modelId)} served by local ds4-server`,
    model: `ds4/${opts.modelId}`,
    temperature: 0,
  };
  data["agent"] = agents;
  const backup = writeWithBackup(path, JSON.stringify(data, null, 2) + "\n");
  return {
    id: "opencode",
    ok: true,
    path,
    backup,
    message: `Wrote provider "ds4" to ${path}`,
  };
}

function statusOpencode(): AgentTargetStatus {
  const path = targetPath("opencode");
  if (!existsSync(path)) {
    return {
      id: "opencode",
      label: "opencode",
      path,
      exists: false,
      configured: false,
      detail: "File missing — will be created",
    };
  }
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as {
      provider?: Record<string, unknown>;
      agent?: Record<string, unknown>;
    };
    const configured =
      Boolean(data.provider?.["ds4"]) && Boolean(data.agent?.["ds4"]);
    return {
      id: "opencode",
      label: "opencode",
      path,
      exists: true,
      configured,
      detail: configured
        ? 'Provider + agent "ds4" present'
        : 'No "ds4" provider/agent yet',
    };
  } catch (err) {
    return {
      id: "opencode",
      label: "opencode",
      path,
      exists: true,
      configured: false,
      detail: "Unparseable file",
      error: String(err),
    };
  }
}

// --- Codex CLI (TOML) ---

const CODEX_PROVIDER_BLOCK = (opts: AgentConfigOpts) => `\
[model_providers.ds4]
name = "ds4 local (DwarfStar)"
base_url = "http://127.0.0.1:${opts.port}/v1"
wire_api = "responses"
requires_openai_auth = false
`;

function writeCodex(opts: AgentConfigOpts): ApplyResult {
  const path = targetPath("codex");
  mkdirSync(dirname(path), { recursive: true });
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const block = CODEX_PROVIDER_BLOCK(opts);
  let next: string;
  if (/\[model_providers\.ds4\]/.test(existing)) {
    // Replace the existing ds4 block (up to the next top-level table or EOF).
    next = existing.replace(
      /\[model_providers\.ds4\][\s\S]*?(?=\n\[[^\]]+\]|$)/,
      block.replace(/\n$/, ""),
    );
  } else {
    next = existing.endsWith("\n") || existing === ""
      ? existing + block
      : existing + "\n" + block;
  }
  const backup = writeWithBackup(path, next);
  return {
    id: "codex",
    ok: true,
    path,
    backup,
    message: `Wrote [model_providers.ds4] to ${path}`,
  };
}

function statusCodex(): AgentTargetStatus {
  const path = targetPath("codex");
  if (!existsSync(path)) {
    return {
      id: "codex",
      label: "Codex CLI",
      path,
      exists: false,
      configured: false,
      detail: "File missing — will be created",
    };
  }
  const configured = /\[model_providers\.ds4\]/.test(readFileSync(path, "utf8"));
  return {
    id: "codex",
    label: "Codex CLI",
    path,
    exists: true,
    configured,
    detail: configured
      ? "[model_providers.ds4] present"
      : "No [model_providers.ds4] yet",
  };
}

// --- shared helpers ---

function writeWithBackup(path: string, content: string): string {
  if (existsSync(path)) {
    const backup = `${path}.ds4bak-${Date.now()}`;
    copyFileSync(path, backup);
    writeFileSync(path, content, "utf8");
    return backup;
  }
  writeFileSync(path, content, "utf8");
  return "";
}

const WRITERS: Record<AgentTargetId, (o: AgentConfigOpts) => ApplyResult> = {
  pi: writePi,
  opencode: writeOpencode,
  codex: writeCodex,
};

const STATUS: Record<AgentTargetId, () => AgentTargetStatus> = {
  pi: statusPi,
  opencode: statusOpencode,
  codex: statusCodex,
};

export function statusFor(id: AgentTargetId): AgentTargetStatus {
  return STATUS[id]();
}

export function allStatuses(): AgentTargetStatus[] {
  return (["pi", "opencode", "codex"] as AgentTargetId[]).map(statusFor);
}

export function applyTargets(
  targets: AgentTargetId[],
  opts: AgentConfigOpts,
): ApplyResult[] {
  const seen = new Set<AgentTargetId>();
  const results: ApplyResult[] = [];
  for (const t of targets) {
    if (seen.has(t)) continue;
    seen.add(t);
    try {
      results.push(WRITERS[t](opts));
    } catch (err) {
      results.push({
        id: t,
        ok: false,
        message: `Failed to write ${t} config: ${String(err)}`,
      });
    }
  }
  return results;
}
