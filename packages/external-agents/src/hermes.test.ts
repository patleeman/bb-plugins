import { describe, expect, it } from "vitest";
import { HermesClient, parseSse } from "./hermes-client.js";
import { HermesEventMapper, approvalPayload, approvalResponse } from "./hermes-events.js";
import { threadDeltaSchema } from "@get-bb/plugin-sdk/provider-bridge";

function stream(chunks: string[]) {
  return new ReadableStream<Uint8Array>({ start(controller) {
    chunks.forEach(chunk => controller.enqueue(new TextEncoder().encode(chunk)));
    controller.close();
  } });
}
async function collect(chunks: string[]) {
  const output = [];
  for await (const value of parseSse(stream(chunks))) output.push(value);
  return output;
}
describe("Hermes wire events", () => {
  it("decodes chunked SSE with comments and CRLF", async () => {
    expect(await collect([': keepalive\r\n\r', '\ndata: {"event":"message.', 'delta","delta":"ok"}\r\n\r\n'])).toEqual([{ event: "message.delta", delta: "ok" }]);
  });
  it("rejects malformed and truncated events", async () => {
    await expect(collect(['data: nope\n\n'])).rejects.toThrow("malformed");
    await expect(collect(['data: {"event":'])).rejects.toThrow("mid-frame");
    await expect(collect(['data: {}\n\n'])).rejects.toThrow("without a name");
  });
  it("maps text, commentary, same-name tools and final text into valid SDK deltas", () => {
    const mapper = new HermesEventMapper();
    const events = [
      { event: "message.delta", delta: "Checking" },
      { event: "message.interim", text: "Checking", already_streamed: true },
      { event: "tool.started", tool: "terminal", preview: "pwd" },
      { event: "tool.started", tool: "terminal", preview: "ls" },
      { event: "tool.completed", tool: "terminal", duration: 0.2, preview: "/workspace", error: false },
      { event: "tool.completed", tool: "terminal", duration: 0.3, preview: "error", error: true },
      { event: "message.delta", delta: "ok" },
      { event: "run.completed", output: "ok" },
    ];
    const deltas = events.flatMap(event => mapper.translate(event));
    deltas.forEach(delta => expect(threadDeltaSchema.safeParse(delta).success, JSON.stringify(delta)).toBe(true));
    expect(deltas.filter(d => d.kind === "item.textClose").map(d => d.text)).toEqual(["Checking", "ok"]);
    const closes = deltas.filter(d => d.kind === "item.close");
    expect(closes.map(d => d.key)).toEqual([{ providerItemId: "hermes-tool-1" }, { providerItemId: "hermes-tool-2" }]);
    expect(closes.map(d => d.status)).toEqual(["completed", "failed"]);
    expect(mapper.translate({ event: "run.completed", output: "duplicate" })).toEqual([]);
  });
  it("settles cancellations and errors without claiming success", () => {
    expect(new HermesEventMapper().translate({ event: "run.cancelled" })).toEqual([{ kind: "turn.boundary", status: "interrupted" }]);
    expect(new HermesEventMapper().translate({ event: "run.failed", error: "upstream failed" })).toEqual([{ kind: "provider.error", message: "Hermes run failed", detail: "upstream failed", settlesTurn: true }]);
  });
});
describe("Hermes approval", () => {
  const event = { event: "approval.request", request_id: "approval-1", command: "deploy", choices: ["once", "deny"] };
  it("preserves request identity and does not offer permanent approval", () => {
    expect(approvalPayload(event, "/remote").availableDecisions).toEqual(["allow_once", "deny"]);
    expect(approvalResponse(event, "allow_once")).toEqual({ request_id: "approval-1", choice: "once" });
    expect(approvalResponse(event, "allow_for_session").choice).toBe("deny");
    expect(approvalResponse(event, undefined).choice).toBe("deny");
  });
  it("supports session approval only when Hermes offers it", () => {
    expect(approvalResponse({ ...event, choices: ["once", "session", "always", "deny"] }, "allow_for_session").choice).toBe("session");
    expect(() => approvalPayload({ ...event, request_id: "" }, "/")).toThrow("request ID");
  });
});
describe("connection errors", () => {
  const connection = { enabled: true, baseUrl: "http://127.0.0.1:1", tokenEnv: "RED4_HERMES_TOKEN" };
  it("explains missing credentials and disabled providers", async () => {
    await expect(new HermesClient(connection, undefined, {}).models()).rejects.toThrow("token is missing");
    await expect(new HermesClient({ ...connection, enabled: false }, "secret").models()).rejects.toThrow("disabled");
  });
  it("reports unreachable hosts without leaking credentials", async () => {
    await expect(new HermesClient(connection, "private-value").models()).rejects.toThrow("Hermes is unreachable");
  });
  it("rejects credentials embedded in URLs", () => {
    expect(() => new HermesClient({ ...connection, baseUrl: "http://user:password@localhost" })).toThrow();
  });
});
