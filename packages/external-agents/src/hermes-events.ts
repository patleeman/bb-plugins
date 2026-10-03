import type { ApprovalPendingInteractionPayload, ThreadDelta } from "@get-bb/plugin-sdk/provider-bridge";
import { AgentConnectionError, type HermesEvent } from "./hermes-client.js";

const string = (value: unknown): string => typeof value === "string" ? value : "";

/** One mapper per run. Hermes's tool events have names, but no call IDs. */
export class HermesEventMapper {
  private segment = 0;
  private text = "";
  private toolSequence = 0;
  private tools = new Map<string, string[]>();
  terminal = false;

  private closeText(output = this.text): ThreadDelta[] {
    if (!output) return [];
    const result: ThreadDelta[] = [{ kind: "item.textClose", key: { channel: `assistant-${this.segment}` }, channel: "agentMessage", text: output }];
    this.segment++;
    this.text = "";
    return result;
  }
  translate(event: HermesEvent): ThreadDelta[] {
    if (this.terminal) return [];
    switch (event.event) {
      case "message.delta": {
        const text = string(event.delta);
        this.text += text;
        return text ? [{ kind: "item.textDelta", key: { channel: `assistant-${this.segment}` }, channel: "agentMessage", text }] : [];
      }
      case "message.interim":
        return this.closeText(event.already_streamed === true ? this.text : string(event.text));
      case "tool.started": {
        const tool = string(event.tool) || "tool";
        const id = `hermes-tool-${++this.toolSequence}`;
        this.tools.set(tool, [...this.tools.get(tool) ?? [], id]);
        return [...this.closeText(), { kind: "item.open", key: { providerItemId: id }, item: { type: "tool", tool, args: { preview: string(event.preview) } } }];
      }
      case "tool.completed": {
        const tool = string(event.tool) || "tool";
        const id = this.tools.get(tool)?.shift();
        if (!id) throw new AgentConnectionError("Hermes completed a tool without a matching start.");
        return [{ kind: "item.close", key: { providerItemId: id }, status: event.error === true ? "failed" : "completed", resultText: string(event.preview), item: { type: "tool", tool, durationMs: typeof event.duration === "number" ? event.duration * 1000 : undefined } }];
      }
      case "run.completed":
        this.terminal = true;
        return [...this.closeText(string(event.output) || this.text), { kind: "turn.boundary", status: "completed" }];
      case "run.cancelled":
      case "run.interrupted":
        this.terminal = true;
        return [...this.closeText(), { kind: "turn.boundary", status: "interrupted" }];
      case "run.failed":
      case "run.incomplete":
        this.terminal = true;
        return [...this.closeText(), { kind: "provider.error", message: "Hermes run failed", detail: string(event.error) || "Hermes could not finish this run.", settlesTurn: true }];
      default:
        return [];
    }
  }
}

export function approvalPayload(event: HermesEvent, cwd: string): ApprovalPendingInteractionPayload {
  if (event.event !== "approval.request" || !string(event.request_id)) {
    throw new AgentConnectionError("Hermes approval is missing its request ID.");
  }
  const choices = Array.isArray(event.choices) ? event.choices : [];
  return {
    kind: "approval",
    subject: { kind: "command", itemId: string(event.request_id), command: string(event.command) || "Hermes tool execution", cwd, actions: [], sessionGrant: null },
    reason: string(event.description) || string(event.reason) || "Hermes requests permission to continue.",
    availableDecisions: [ ...(choices.includes("once") ? ["allow_once" as const] : []), ...(choices.includes("session") ? ["allow_for_session" as const] : []), "deny" ],
  };
}

/** Never widen an approval beyond the choices offered by this exact request. */
export function approvalResponse(event: HermesEvent, decision: unknown): { request_id: string; choice: string } {
  approvalPayload(event, "");
  const choices = Array.isArray(event.choices) ? event.choices : [];
  const wanted = decision === "allow_once" ? "once" : decision === "allow_for_session" ? "session" : "deny";
  return { request_id: string(event.request_id), choice: choices.includes(wanted) ? wanted : "deny" };
}
