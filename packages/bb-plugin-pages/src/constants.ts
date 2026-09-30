// Shared by server and app. Keep runtime-free of server-only imports.

export const PLUGIN_ID = "pages";
export const REALTIME_CHANNEL = "pages";
export const SYNC_PATH = "/sync";
export const FILES_PATH = "/files";
export const UPLOAD_PATH = "/upload";
/** Mermaid's browser build, fetched the first time a page shows a diagram. */
export const MERMAID_PATH = "/mermaid.js";
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
export const HUMAN_USER_ID = "user";
/**
 * Who a `replaceMarkdown` RPC call edits as. RPC calls carry no caller
 * identity, and agent-style keys are what the rest of Pages shows as "an agent".
 */
export const PLUGIN_RPC_ACTOR = "agent:plugin";

export type RealtimeEvent =
  | { type: "tree"; projectId: string | null }
  | { type: "page"; pageId: string }
  | { type: "requests"; pageId: string }
  | { type: "deleted"; pageIds: string[] }
  /** An Explore explainer or its job changed. */
  | { type: "explainer"; explainerId: string; threadId: string; messageId: string; parentId: string | null };
