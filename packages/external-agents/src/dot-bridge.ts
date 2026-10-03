import { randomUUID } from "node:crypto";
import { createBridgeIo, experimental_defineProviderBridge, threadStartParamsSchema, threadResumeParamsSchema, turnStartParamsSchema, threadStopParamsSchema, type ThreadDelta } from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";
import { DotClient, DotError, dotHealth } from "./dot-client.js";
import { DotQueue } from "./dot-queue.js";
import { DotRun } from "./dot-run.js";

export const dotConnectionSchema = z.object({ enabled: z.boolean() });
export const dotModels = [{ id: "dot", model: "dot", displayName: "Dot (experimental)", description: "Your one persistent ChatGPT Dot conversation", isDefault: true, defaultReasoningEffort: "none" as const, supportedReasoningEfforts: [{ reasoningEffort: "none" as const, description: "Dot default" }] }];
export function createDotBridge(write?: (line: string) => void) {
  const io = createBridgeIo<unknown>({ write });
  const sessions = new Map<string, { run?: DotRun; done?: Promise<void> }>();
  const emit = (threadId: string, deltas: ThreadDelta[]) => io.send({ jsonrpc: "2.0", method: "thread/delta", params: { threadId, deltas } });
  const enabled = (options: unknown) => { if (!dotConnectionSchema.parse(options).enabled) throw new DotError("Dot is disabled in External Agents settings."); };
  const start = (threadId: string, input: readonly { type: string; text?: string }[], clientRequestId?: string) => {
    const session = sessions.get(threadId);
    if (!session) throw new DotError("Resume the Dot thread before sending a message.");
    if (session.run) throw new DotError("This BB thread already has a queued or running Dot turn.");
    if (input.some(part => part.type !== "text")) throw new DotError("Dot currently accepts text messages only.");
    const providerTurnId = randomUUID();
    const turnEmit = (deltas: ThreadDelta[]) => emit(threadId, deltas.map(delta => ({ ...delta, providerTurnId })));
    const run = new DotRun(new DotClient(), new DotQueue(), turnEmit);
    session.run = run;
    turnEmit([...(clientRequestId ? [{ kind: "input.accepted" as const, clientRequestId }] : []), { kind: "turn.open" }]);
    session.done = run.execute(input.map(part => part.text ?? "").join("\n")).catch(error => {
      turnEmit([{ kind: "provider.error", message: error instanceof DotError ? error.message : "Dot bridge failed.", settlesTurn: true }]);
    }).finally(() => { if (session.run === run) session.run = undefined; });
  };
  async function handle(line: string) {
    let request: any; try { request = JSON.parse(line); } catch { return; }
    if (!request?.method || request.id === undefined) return;
    try {
      const p = request.params ?? {};
      switch (request.method) {
        case "model/list": enabled(p.providerOptions); io.sendResult(request.id, { models: dotModels, selectedOnlyModels: [] }); break;
        case "provider/health": {
          enabled(p.providerOptions); const health = await dotHealth();
          io.sendResult(request.id, { supported: true, health: { status: health.online ? "ready" : health.status, statusMessage: health.message, accountEmail: null, planLabel: null, installedVersion: null, minimumSupportedVersion: null, canInstall: false, canUpdate: false, loginCommand: null } }); break;
        }
        case "thread/start": case "thread/resume": {
          const params = request.method === "thread/start" ? threadStartParamsSchema.parse(p) : threadResumeParamsSchema.parse(p);
          enabled(params.options.providerOptions);
          if (sessions.get(params.threadId)?.run) throw new DotError("Dot still has work in this BB thread.");
          const room = await new DotClient().discover();
          // BB requires exclusive local session ownership; the remote room stays shared.
          const providerThreadId = `dot:${room.roomId}:${params.threadId}`;
          sessions.set(params.threadId, {});
          io.send({ jsonrpc: "2.0", method: "thread/identity", params: { threadId: params.threadId, providerThreadId, sessionRestorable: true } });
          emit(params.threadId, [{ kind: "session.reset" }]);
          io.sendResult(request.id, { providerThreadId, sessionRestorable: true });
          if (request.method === "thread/start" && p.input?.length) start(params.threadId, p.input);
          break;
        }
        case "turn/start": {
          const params = turnStartParamsSchema.parse(p); enabled(params.options.providerOptions);
          start(params.threadId, params.input, params.clientRequestId); io.sendResult(request.id, {}); break;
        }
        case "thread/stop": case "thread/discard": {
          const params = request.method === "thread/stop" ? threadStopParamsSchema.parse(p) : z.object({ threadId: z.string() }).parse(p);
          const session = sessions.get(params.threadId); session?.run?.cancel();
          // Let the correlated cloud interrupt settle the BB turn before releasing its runtime.
          await session?.done;
          if (request.method === "thread/discard") sessions.delete(params.threadId);
          io.sendResult(request.id, {}); break;
        }
        default: throw new DotError("Dot does not support this action. Send the next message after the current turn finishes.");
      }
    } catch (error) { io.sendError(request.id, -32000, error instanceof DotError ? error.message : "Invalid Dot bridge request."); }
  }
  const close = () => { for (const session of sessions.values()) session.run?.cancel(); };
  return experimental_defineProviderBridge({ handleLine: line => { void handle(line); }, onClose: close, onSigint: close, onSigterm: close });
}
