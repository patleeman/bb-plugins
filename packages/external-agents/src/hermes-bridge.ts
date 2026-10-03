import { randomUUID } from "node:crypto";
import {
  createBridgeIo, experimental_defineProviderBridge, initializeParamsSchema,
  threadStartParamsSchema, threadResumeParamsSchema, turnStartParamsSchema,
  turnSteerParamsSchema, threadStopParamsSchema, threadDiscardParamsSchema,
  PROVIDER_BRIDGE_PROTOCOL_VERSION, THREAD_DELTA_GRAMMAR_V3,
  type ThreadDelta, type AvailableModel,
} from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";
import { HermesClient, connectionSchema, AgentConnectionError, type Connection, type HermesEvent } from "./hermes-client.js";
import { HermesEventMapper, approvalPayload, approvalResponse } from "./hermes-events.js";

type Session = {
  threadId: string; providerThreadId: string; cwd: string; client: HermesClient;
  model?: string; instructions?: string; active?: { id?: string; abort: AbortController; mapper: HermesEventMapper };
};
export function modelCatalog(value: unknown): AvailableModel[] {
  const parsed = z.object({ data: z.array(z.object({ id: z.string().min(1) }).passthrough()) }).safeParse(value);
  if (!parsed.success) throw new AgentConnectionError("Hermes returned an invalid model catalog.");
  return parsed.data.data.map((m, i) => ({ id: m.id, model: m.id, displayName: m.id, description: "Hermes model", isDefault: i === 0, defaultReasoningEffort: "none", supportedReasoningEfforts: [{ reasoningEffort: "none", description: "Agent default" }] }));
}
export async function hermesHealth(connection: Connection) {
  try {
    await new HermesClient(connection).models();
    return { online: true, status: "ready" as const, message: "Hermes API is reachable." };
  } catch (error) {
    return { online: false, status: error instanceof AgentConnectionError && [401,403].includes(error.status ?? 0) ? "unauthenticated" as const : "unknown" as const, message: error instanceof AgentConnectionError ? error.message : "Hermes configuration is invalid." };
  }
}
function prompt(input: readonly { type: string; text?: string }[]): string {
  if (input.some(part => part.type !== "text")) throw new AgentConnectionError("Hermes currently accepts text messages only.");
  return input.map(part => part.text || "").join("\n");
}
function connection(options: unknown): Connection {
  return connectionSchema.parse(options);
}

export function createHermesBridge(write?: (line: string) => void) {
  const io = createBridgeIo<unknown>({ write });
  const sessions = new Map<string, Session>();
  const pending = new Map<string, { session: Session; event: HermesEvent; runId: string }>();
  const send = (method: string, params: unknown) => io.send({ jsonrpc: "2.0", method, params });
  const deltas = (threadId: string, value: ThreadDelta[]) => { if (value.length) send("thread/delta", { threadId, deltas: value }); };
  const fail = (session: Session, error: unknown) => deltas(session.threadId, [{ kind: "provider.error", message: error instanceof AgentConnectionError ? error.message : "Hermes bridge failed.", settlesTurn: true }]);
  function current(threadId: string) {
    const session = sessions.get(threadId);
    if (!session) throw new AgentConnectionError("Hermes session is not open. Resume the BB thread.");
    return session;
  }
  async function run(session: Session, input: string, clientRequestId?: string) {
    if (session.active) throw new AgentConnectionError("Hermes already has an active run for this thread.");
    const active = { id: undefined as string | undefined, abort: new AbortController(), mapper: new HermesEventMapper() };
    session.active = active;
    try {
      active.id = await session.client.start(input, session.providerThreadId, session.model, session.instructions);
      if (active.abort.signal.aborted) {
        await session.client.control(active.id, "stop");
        return;
      }
      if (clientRequestId) deltas(session.threadId, [{ kind: "input.accepted", clientRequestId }]);
      deltas(session.threadId, [{ kind: "turn.open" }]);
      void (async () => {
        try {
          for await (const event of session.client.events(active.id!, active.abort.signal)) {
            if (event.event === "approval.request") {
              const payload = approvalPayload(event, session.cwd);
              const id = `hermes-approval-${randomUUID()}`;
              pending.set(id, { session, event, runId: active.id! });
              io.send({ jsonrpc: "2.0", id, method: "interaction/request", params: { threadId: session.threadId, providerThreadId: session.providerThreadId, payload } });
            } else deltas(session.threadId, active.mapper.translate(event));
          }
          if (!active.mapper.terminal && !active.abort.signal.aborted) throw new AgentConnectionError("Hermes event stream ended before the run completed.");
        } catch (error) {
          if (!active.abort.signal.aborted) fail(session, error);
        } finally {
          for (const [id, request] of pending) if (request.session === session && request.runId === active.id) pending.delete(id);
          if (session.active === active) session.active = undefined;
        }
      })();
    } catch (error) { session.active = undefined; throw error; }
  }
  async function stop(session: Session, interrupt: boolean) {
    const active = session.active;
    if (!active) return;
    if (interrupt && active.id) await session.client.control(active.id, "stop");
    active.abort.abort();
    session.active = undefined;
    for (const [id, request] of pending) if (request.session === session) pending.delete(id);
    if (interrupt) deltas(session.threadId, [{ kind: "turn.boundary", status: "interrupted" }]);
  }
  async function handle(raw: Record<string, unknown>) {
    const id = raw.id;
    if (typeof id !== "number" && typeof id !== "string") return;
    if (typeof raw.method !== "string") {
      const approval = pending.get(String(id));
      if (!approval) return;
      pending.delete(String(id));
      const result = raw.result as { decision?: unknown } | undefined;
      const runId = approval.runId;
      if (runId === approval.session.active?.id) {
        try { await approval.session.client.control(runId, "approval", approvalResponse(approval.event, result?.decision)); }
        catch (error) { fail(approval.session, error); }
      }
      return;
    }
    try {
      const params = raw.params ?? {};
      switch (raw.method) {
        case "initialize":
          initializeParamsSchema.parse(params);
          io.sendResult(id, { protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION, capabilities: { grammarVersions: [THREAD_DELTA_GRAMMAR_V3, THREAD_DELTA_GRAMMAR_V3], sessionRestore: true, fork: "none", approvalEnforcedBy: "provider", steerMode: "inject" } });
          break;
        case "model/list": {
          const p = z.object({ providerOptions: connectionSchema }).parse(params);
          io.sendResult(id, { models: modelCatalog(await new HermesClient(p.providerOptions).models()), selectedOnlyModels: [] });
          break;
        }
        case "provider/health": {
          const p = z.object({ providerOptions: connectionSchema }).parse(params);
          const result = await hermesHealth(p.providerOptions);
          io.sendResult(id, { supported: true, health: { status: result.status, statusMessage: result.message, accountEmail: null, planLabel: null, installedVersion: null, minimumSupportedVersion: null, canInstall: false, canUpdate: false, loginCommand: null } });
          break;
        }
        case "thread/start":
        case "thread/resume": {
          const p = raw.method === "thread/start" ? threadStartParamsSchema.parse(params) : threadResumeParamsSchema.parse(params);
          if (sessions.has(p.threadId)) await stop(current(p.threadId), false);
          const client = new HermesClient(connection(p.options.providerOptions));
          await client.models();
          const providerThreadId = typeof p.providerThreadId === "string" ? p.providerThreadId : `bb-${randomUUID()}`;
          const session: Session = { threadId: p.threadId, providerThreadId, cwd: p.cwd, client, model: p.options.model, instructions: p.options.instructions };
          sessions.set(p.threadId, session);
          send("thread/identity", { threadId: p.threadId, providerThreadId, sessionRestorable: true });
          deltas(p.threadId, [{ kind: "session.reset" }]);
          io.sendResult(id, { providerThreadId, sessionRestorable: true });
          if (raw.method === "thread/start") {
            const input = threadStartParamsSchema.parse(params).input;
            if (input?.length) void run(session, prompt(input)).catch(error => fail(session, error));
          }
          break;
        }
        case "turn/start": {
          const p = turnStartParamsSchema.parse(params);
          const session = current(p.threadId);
          session.model = p.options.model;
          session.instructions = p.options.instructions;
          session.client = new HermesClient(connection(p.options.providerOptions));
          await run(session, prompt(p.input), p.clientRequestId);
          io.sendResult(id, {});
          break;
        }
        case "turn/steer": {
          const p = turnSteerParamsSchema.parse(params);
          const session = current(p.threadId);
          if (!session.active?.id) throw new AgentConnectionError("Hermes has no active run to steer.");
          await session.client.control(session.active.id, "steer", { input: prompt(p.input) });
          deltas(p.threadId, [{ kind: "input.accepted", clientRequestId: p.clientRequestId }]);
          io.sendResult(id, {});
          break;
        }
        case "thread/stop": {
          const p = threadStopParamsSchema.parse(params);
          const session = sessions.get(p.threadId);
          if (session) await stop(session, p.intent !== "release");
          io.sendResult(id, {});
          break;
        }
        case "thread/discard": {
          const p = threadDiscardParamsSchema.parse(params);
          const session = sessions.get(p.threadId);
          if (session) await stop(session, false);
          sessions.delete(p.threadId);
          io.sendResult(id, {});
          break;
        }
        default: io.sendError(id, -32601, `Method not found: ${raw.method}`);
      }
    } catch (error) {
      io.sendError(id, error instanceof z.ZodError ? -32602 : -32000, error instanceof z.ZodError ? `Invalid params for ${raw.method}` : error instanceof AgentConnectionError ? error.message : "Hermes bridge request failed.");
    }
  }
  function close() { for (const session of sessions.values()) void stop(session, false); sessions.clear(); }
  return experimental_defineProviderBridge({
    handleLine(line) { let raw: unknown; try { raw = JSON.parse(line); } catch { return; } if (raw && typeof raw === "object") void handle(raw as Record<string, unknown>); },
    onClose: close, onSigint: close, onSigterm: close,
  });
}
