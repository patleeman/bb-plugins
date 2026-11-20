// Who may change what an MCP server is trusted to do.
//
// bb's local server cannot tell a person from an agent: plugin RPC accepts any
// loopback caller (`bb plugin rpc call` reaches it from a shell), and plugin
// forms can be answered with `bb thread interactions respond`. So the plugin
// never trusts "the request came in on the RPC the page uses". A trust change
// (approve, enable, disable, keep approval across a code change) needs a
// one-time confirm token:
//
// - The page asks for one with `requestConfirmToken`. The server never returns
//   it in the RPC reply; it publishes it on the realtime channel
//   `agent-plugins-confirm`, which BB app windows receive. The `bb` CLI and
//   the node SDK cannot read realtime signals.
// - The token is single-use, expires after two minutes, and is bound to one
//   action on one server.
// - Calls from other plugins (the host marks them `kind: "plugin"`) are
//   refused outright.
//
// This raises the bar; it is not a sandbox. A process that writes its own
// WebSocket client can read the token, and any process running as the same OS
// user can edit the plugin's database directly.
//
// Agents and the CLI may only *request* approval (see `approval_requests`).
import * as crypto from "node:crypto";
import { CONFIRM_CHANNEL } from "./confirm-channel.js";

export { CONFIRM_CHANNEL };
export const CONFIRM_TOKEN_TTL_MS = 2 * 60_000;

export type GrantAction = "approve" | "enable" | "disable" | "update";

export interface GrantTarget {
  action: GrantAction;
  pluginId: string;
  /** Empty for plugin-wide actions such as `update`. */
  serverId: string;
}

/**
 * The part of a host's RPC handler context this plugin reads. Older hosts
 * pass no context; newer ones pass `{ kind: "client" | "plugin" }`.
 */
interface RpcCallerContext {
  experimental_caller?: { kind?: string };
}

export function isPluginCaller(ctx: unknown): boolean {
  return (ctx as RpcCallerContext | undefined)?.experimental_caller?.kind === "plugin";
}

export class GrantRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrantRefusedError";
  }
}

export const USER_ONLY_MESSAGE =
  "Only a person can approve or change an MCP server, from Agent Plugins in the BB app. " +
  "Agents and the CLI can ask for approval with `bb agent-plugins request-approval <id> <serverId>`.";

function targetKey(target: GrantTarget): string {
  return `${target.action}\u0000${target.pluginId}\u0000${target.serverId}`;
}

function tokenKey(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export class GrantGate {
  private readonly tokens = new Map<string, { target: string; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Mint a single-use token bound to one action on one server. */
  issue(target: GrantTarget): { token: string; expiresAt: number } {
    this.sweep();
    const token = crypto.randomBytes(32).toString("base64url");
    const expiresAt = this.now() + CONFIRM_TOKEN_TTL_MS;
    this.tokens.set(tokenKey(token), { target: targetKey(target), expiresAt });
    return { token, expiresAt };
  }

  /**
   * Throw unless this call carries a person's go-ahead for `target`. A token is
   * spent when presented, whether or not it matched.
   */
  assert(ctx: unknown, target: GrantTarget, confirmToken: string | undefined): void {
    if (isPluginCaller(ctx) || !confirmToken) throw new GrantRefusedError(USER_ONLY_MESSAGE);
    const key = tokenKey(confirmToken);
    const entry = this.tokens.get(key);
    this.tokens.delete(key);
    if (!entry || entry.expiresAt < this.now() || entry.target !== targetKey(target)) {
      throw new GrantRefusedError("This confirmation expired or does not match. Try again from Agent Plugins in BB.");
    }
  }

  private sweep(): void {
    const now = this.now();
    for (const [key, entry] of this.tokens) if (entry.expiresAt < now) this.tokens.delete(key);
  }
}
