import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { request as httpsRequest } from "node:https";
import { createInterface } from "node:readline";
import { z } from "zod";

export class DotError extends Error {
  constructor(message: string, readonly status?: number) { super(message); this.name = "DotError"; }
}
const tokensSchema = z.object({ access_token: z.string().min(1), account_id: z.string().min(1) });
export type DotTokens = z.infer<typeof tokensSchema>;
export interface DotAuth { read(): Promise<DotTokens>; refresh(): Promise<void>; }

// Delegate refresh and persistence to Codex, including its managed-auth recovery.
// https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/json/v2/GetAccountParams.json
export function refreshCodexAuth(codexHome = join(homedir(), ".codex")): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", ["app-server"], { env: { ...process.env, CODEX_HOME: codexHome }, stdio: ["pipe", "pipe", "ignore"] });
    const lines = createInterface({ input: child.stdout });
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true; clearTimeout(timer); lines.close(); child.stdin.end(); child.kill();
      ok ? resolve() : reject(new DotError("Dot authentication refresh failed. Sign in with Codex on this BB host.", 401));
    };
    const timer = setTimeout(() => finish(false), 30_000);
    const send = (value: unknown) => child.stdin.write(JSON.stringify(value) + "\n");
    child.on("error", () => finish(false)); child.on("exit", () => finish(false));
    child.stdin.on("error", () => finish(false));
    lines.on("line", line => {
      let message; try { message = JSON.parse(line); } catch { return; }
      if (message.id === 1) {
        if (message.error) return finish(false);
        send({ method: "initialized" });
        send({ id: 2, method: "account/read", params: { refreshToken: true } });
      } else if (message.id === 2) finish(!message.error && message.result?.account?.type === "chatgpt");
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "bb_external_agents_dot", version: "0.1.0" } } });
  });
}
export function codexAuth(codexHome = join(homedir(), ".codex")): DotAuth {
  let refreshing: Promise<void> | undefined;
  return {
    async read() {
      try { return tokensSchema.parse(JSON.parse(await readFile(join(codexHome, "auth.json"), "utf8")).tokens); }
      catch { throw new DotError("Dot needs an existing Codex ChatGPT sign-in on this BB host.", 401); }
    },
    refresh() { return refreshing ??= refreshCodexAuth(codexHome).finally(() => { refreshing = undefined; }); },
  };
}
const profileSchema = z.object({ id: z.string().min(1), messaging_room_id: z.string().min(1), active_root_thread_id: z.string().min(1), is_paused: z.boolean() });
export type DotRoom = { agentId: string; roomId: string; rootId: string; memberId: string; paused: boolean };
export const dotMessageSchema = z.object({
  id: z.string().min(1), created_at: z.string().optional(), account_user_id: z.string().nullable().optional(),
  request_id: z.string().nullable().optional(), deleted_at: z.string().nullable().optional(),
  content: z.object({ text: z.string().nullable().optional() }),
  reply_to: z.object({ message_id: z.string() }).nullable().optional(),
});
export type DotMessage = z.infer<typeof dotMessageSchema>;
export function isDotReply(message: DotMessage, room: DotRoom, requestId: string, submittedMessageId: string): boolean {
  return !message.deleted_at && message.id !== submittedMessageId && message.account_user_id === room.memberId
    && (message.reply_to ? message.reply_to.message_id === submittedMessageId : message.request_id === requestId);
}

// Live discovery succeeds with native HTTPS; Node fetch returned HTTP 403.
// Keep transport explicit rather than relying on browser-style fetch behavior.
export const dotHttpRequest: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.origin !== "https://chatgpt.com") throw new DotError("Invalid Dot API origin.");
  return new Promise<Response>((resolve, reject) => {
    const headers = Object.fromEntries(new Headers(init?.headers));
    if (typeof init?.body === "string") headers["content-length"] = String(Buffer.byteLength(init.body));
    const request = httpsRequest(url, { method: init?.method, headers, signal: init?.signal ?? undefined }, response => {
      const chunks: Buffer[] = []; let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) { response.destroy(); reject(new DotError("Dot response exceeded the size limit.")); return; }
        chunks.push(chunk);
      });
      response.on("error", () => reject(new DotError("Dot response was interrupted.")));
      response.on("end", () => resolve(new Response([204, 205, 304].includes(response.statusCode ?? 0) ? null : Buffer.concat(chunks), { status: response.statusCode ?? 502 })));
    });
    request.on("error", () => reject(new DotError("Dot connection failed.")));
    request.end(typeof init?.body === "string" ? init.body : undefined);
  });
};

export class DotClient {
  constructor(readonly auth: DotAuth = codexAuth(), private readonly request: typeof fetch = dotHttpRequest) {}
  async http(path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    if (!path.startsWith("/") || path.startsWith("//")) throw new DotError("Invalid Dot API route.");
    for (let attempt = 0; attempt < 2; attempt++) {
      const tokens = await this.auth.read(); // Read every request: another Codex client may have refreshed.
      let response: Response;
      try {
        response = await this.request(`https://chatgpt.com/backend-api${path}`, {
          method: body === undefined ? "GET" : "POST", redirect: "error",
          headers: { Authorization: `Bearer ${tokens.access_token}`, "ChatGPT-Account-Id": tokens.account_id, "Content-Type": "application/json", Accept: "application/json", "User-Agent": "codex-cli/0.159.0" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
        });
      } catch { throw new DotError(signal?.aborted ? "Dot request cancelled." : "Dot is unreachable. Check this host's network connection."); }
      if (response.status === 401 && attempt === 0) {
        await response.body?.cancel();
        // A concurrent client may already have rotated the token. Reuse that first.
        if ((await this.auth.read()).access_token === tokens.access_token) await this.auth.refresh();
        continue;
      }
      if (!response.ok) {
        let detail = "";
        if (response.status === 422) {
          try { const body = await response.json() as { detail?: { loc?: unknown[]; type?: string }[] }; if (Array.isArray(body.detail)) detail = body.detail.map(value => `${value.loc?.join(".")}: ${value.type}`).join("; "); } catch {}
        } else await response.body?.cancel();
        throw new DotError(`Dot API rejected the request (HTTP ${response.status}).${detail ? ` Validation: ${detail}` : ""}`, response.status);
      }
      try { return await response.json(); } catch { throw new DotError("Dot returned an invalid response."); }
    }
    throw new DotError("Dot authentication was rejected after refresh.", 401);
  }
  async discover(signal?: AbortSignal): Promise<DotRoom> {
    try {
      const primary = z.object({ selection: z.object({ thread_id: z.string().min(1), available: z.boolean() }) }).parse(await this.http("/tbo/primary", undefined, signal));
      if (!primary.selection.available) throw new DotError("The account's Dot is unavailable.");
      const profile = profileSchema.parse(await this.http(`/tbo/by-thread/${encodeURIComponent(primary.selection.thread_id)}`, undefined, signal));
      const room = z.object({ id: z.string(), aeon_id: z.string(), members: z.array(z.object({ account_user_id: z.string(), aeon_id: z.string().optional() })) }).parse(await this.http(`/messaging/rooms/${encodeURIComponent(profile.messaging_room_id)}`, undefined, signal));
      const members = room.members.filter(member => member.aeon_id === profile.id);
      if (room.id !== profile.messaging_room_id || room.aeon_id !== profile.id || members.length !== 1) throw new DotError("Could not verify the Dot's room membership.");
      return { agentId: profile.id, roomId: room.id, rootId: profile.active_root_thread_id, memberId: members[0]!.account_user_id, paused: profile.is_paused };
    } catch (error) { if (error instanceof DotError) throw error; throw new DotError("Dot discovery returned an unsupported response. Its private API may have changed."); }
  }
  async messages(room: DotRoom, signal?: AbortSignal): Promise<DotMessage[]> {
    try { return z.object({ items: z.array(dotMessageSchema) }).parse(await this.http(`/messaging/rooms/${encodeURIComponent(room.roomId)}/messages?limit=32`, undefined, signal)).items; }
    catch (error) { if (error instanceof DotError) throw error; throw new DotError("Dot returned an unsupported message list."); }
  }
  async submit(room: DotRoom, text: string, requestId: string, replyTo?: string, signal?: AbortSignal): Promise<DotMessage> {
    if (room.paused) throw new DotError("Dot is paused. Resume it in ChatGPT before sending a message.");
    try {
      return dotMessageSchema.parse(await this.http(`/messaging/rooms/${encodeURIComponent(room.roomId)}/messages`, {
        content: { text }, request_id: requestId, idempotency_token: requestId,
        ...(replyTo ? { reply_to: { message_id: replyTo } } : {}),
      }, signal));
    } catch (error) { if (error instanceof DotError) throw error; throw new DotError("Dot message acceptance could not be verified. Check the room before retrying."); }
  }
}
export async function dotHealth(client = new DotClient()) {
  try {
    const room = await client.discover();
    return { online: true, status: room.paused ? "paused" as const : "ready" as const, message: room.paused ? "Dot is paused in ChatGPT." : "Dot's messaging room is reachable." };
  } catch (error) {
    return { online: false, status: error instanceof DotError && [401,403].includes(error.status ?? 0) ? "unauthenticated" as const : "unknown" as const, message: error instanceof DotError ? error.message : "Dot health check failed." };
  }
}
