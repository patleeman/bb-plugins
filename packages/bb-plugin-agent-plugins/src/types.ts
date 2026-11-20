export type JsonRecord = Record<string, unknown>;

export type SpecVersion = "1.0.0" | "1.1.0";
export type SourceType = "path" | "git" | "npm";

export interface PluginRecord {
  id: string;
  name: string;
  version: string | null;
  description: string | null;
  specVersion: SpecVersion;
  sourceType: SourceType;
  sourceIntent: string;
  sourceResolved: string | null;
  sourceRef: string | null;
  tagPrefix: string | null;
  pluginRoot: string;
  pluginData: string;
  activeGen: number;
  status: "active" | "error" | "needs-approval";
  approval: "pending" | "approved" | "disabled";
  lastError: string | null;
  contentHash: string | null;
  installedAt: number;
  updatedAt: number;
}

export interface PluginSkillRecord {
  pluginId: string;
  skillName: string;
  skillDir: string;
  frontmatterJson: string;
  bodyHash: string;
  materializedPath: string | null;
  status: "active" | "conflicted" | "skipped" | "error";
  lastError: string | null;
  enabled: number; // 0/1
}

export interface McpServerRecord {
  pluginId: string;
  serverId: string;
  type: "stdio" | "streamable-http" | "sse";
  configJson: string;
  status: "idle" | "ready" | "error" | "disabled" | "needs-approval" | "needs-auth";
  lastError: string | null;
  approved: number; // 0/1
  enabled: number; // 0/1
}

/** A pending ask, from an agent or the CLI, for a person to approve a server. */
export interface ApprovalRequestRecord {
  id: string;
  pluginId: string;
  serverId: string;
  /** What asked: the `bb` CLI, an agent tool, or an update that changed the server's code. */
  source: "cli" | "agent" | "update";
  threadId: string | null;
  reason: string | null;
  createdAt: number;
}

export interface AgentPluginSnapshot {
  plugins: PluginRecord[];
  skills: PluginSkillRecord[];
  mcpServers: McpServerRecord[];
}

export interface CatalogTool {
  opaqueId: string;
  pluginId: string;
  pluginName: string;
  serverId: string;
  serverType: string;
  name: string;
  description: string;
  inputSchema: JsonRecord;
  outputSchema?: JsonRecord;
  annotations?: JsonRecord;
  execution?: JsonRecord;
  icons?: JsonRecord[];
  _meta?: JsonRecord;
  status: "ready" | "error";
  error?: string;
}

export interface CatalogPrompt {
  opaqueId: string;
  pluginId: string;
  pluginName: string;
  serverId: string;
  serverType: string;
  name: string;
  title?: string;
  description?: string;
  arguments?: JsonRecord[];
  icons?: JsonRecord[];
  _meta?: JsonRecord;
  status: "ready" | "error";
  error?: string;
}

export interface CatalogResource {
  opaqueId: string;
  pluginId: string;
  pluginName: string;
  serverId: string;
  serverType: string;
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  icons?: JsonRecord[];
  _meta?: JsonRecord;
  status: "ready" | "error";
  error?: string;
}

export interface CatalogResourceTemplate {
  opaqueId: string;
  pluginId: string;
  pluginName: string;
  serverId: string;
  serverType: string;
  uriTemplate: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  icons?: JsonRecord[];
  _meta?: JsonRecord;
  status: "ready" | "error";
  error?: string;
}

export interface McpCallResult {
  content: JsonRecord[];
  isError?: boolean;
  structuredContent?: unknown;
  _meta?: JsonRecord;
}
