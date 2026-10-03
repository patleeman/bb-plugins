import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { afterEach, expect, it } from "vitest";
import { createHermesBridge } from "./hermes-bridge.js";

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); });
it("runs a BB session, routes approval, steers, stops, and resumes the same Hermes session", async () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  let events: ServerResponse | undefined;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    calls.push({ url: req.url!, body: body ? JSON.parse(body) : {} });
    if (req.url === "/v1/models") { res.setHeader("Content-Type", "application/json"); res.end('{"data":[{"id":"model-1"}]}'); }
    else if (req.url === "/v1/runs") { res.setHeader("Content-Type", "application/json"); res.end('{"run_id":"run-1"}'); }
    else if (req.url?.endsWith("/events")) { events = res; res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write(': heartbeat\n\n'); }
    else { res.setHeader("Content-Type", "application/json"); res.end('{}'); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  cleanups.push(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Missing fixture port");
  const old = process.env.RED4_HERMES_TEST_TOKEN;
  process.env.RED4_HERMES_TEST_TOKEN = "fixture-token";
  cleanups.push(() => { if (old === undefined) delete process.env.RED4_HERMES_TEST_TOKEN; else process.env.RED4_HERMES_TEST_TOKEN = old; });
  const messages: Record<string, any>[] = [];
  const bridge = createHermesBridge(line => messages.push(JSON.parse(line)));
  cleanups.push(() => bridge.onClose?.());
  const options = { permissionMode: "full", permissionScope: "full", approvalReviewer: null, permissionEscalation: null, providerOptions: { baseUrl: `http://127.0.0.1:${address.port}`, tokenEnv: "RED4_HERMES_TEST_TOKEN", enabled: true } };
  const send = (id: number, method: string, params: unknown) => bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  const reply = async (id: number) => { await expect.poll(() => messages.find(m => m.id === id)).toBeDefined(); const found = messages.find(m => m.id === id)!; expect(found.error).toBeUndefined(); return found.result; };
  send(1, "initialize", { protocolVersion: 2, client: { name: "test", version: "1" } }); await reply(1);
  send(2, "thread/start", { threadId: "bb-thread", cwd: "/tmp", instructionMode: "append", options });
  const { providerThreadId } = await reply(2);
  send(3, "turn/start", { threadId: "bb-thread", providerThreadId, clientRequestId: "creq_23456789ab", input: [{ type: "text", text: "Reply with ok" }], options });
  await reply(3);
  await expect.poll(() => events).toBeDefined();
  expect(calls.find(c => c.url === "/v1/runs")!.body.session_id).toBe(providerThreadId);
  events!.write(`data: ${JSON.stringify({ event: "approval.request", request_id: "request-1", command: "echo ok", choices: ["once", "deny"] })}\n\n`);
  await expect.poll(() => messages.find(m => m.method === "interaction/request")).toBeDefined();
  const approval = messages.find(m => m.method === "interaction/request")!;
  expect(approval.params).toMatchObject({ turnId: "run-1", providerNativeIds: true });
  bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id: approval.id, result: { decision: "allow_once" } }));
  await expect.poll(() => calls.find(c => c.url.endsWith("/approval"))?.body).toEqual({ request_id: "request-1", choice: "once" });
  send(4, "turn/steer", { threadId: "bb-thread", providerThreadId, clientRequestId: "creq_23456789ac", input: [{ type: "text", text: "Use uppercase" }], options, expectedTurnId: "turn-1" });
  await reply(4);
  expect(calls.find(c => c.url.endsWith("/steer"))!.body).toEqual({ input: "Use uppercase" });
  send(5, "thread/stop", { threadId: "bb-thread", intent: "interrupt", providerThreadId, activeTurnId: "turn-1" }); await reply(5);
  expect(calls.some(c => c.url.endsWith("/stop"))).toBe(true);
  send(6, "thread/resume", { threadId: "bb-thread", providerThreadId, cwd: "/tmp", instructionMode: "append", options });
  expect((await reply(6)).providerThreadId).toBe(providerThreadId);
  send(7, "turn/start", { threadId: "bb-thread", providerThreadId, clientRequestId: "creq_23456789ad", input: [{ type: "text", text: "Continue" }], options });
  await reply(7);
  const beforeRelease = messages.length;
  send(8, "thread/stop", { threadId: "bb-thread", providerThreadId, activeTurnId: "turn-2", intent: "release" });
  await reply(8);
  expect(calls.filter(c => c.url.endsWith("/stop"))).toHaveLength(2);
  expect(messages.slice(beforeRelease).flatMap(m => m.params?.deltas ?? []).some(d => d.kind === "turn.boundary")).toBe(false);
});
it("rejects unknown methods and invalid parameters", async () => {
  const messages: Record<string, any>[] = [];
  const bridge = createHermesBridge(line => messages.push(JSON.parse(line)));
  bridge.handleLine('{"jsonrpc":"2.0","id":1,"method":"made/up","params":{}}');
  bridge.handleLine('{"jsonrpc":"2.0","id":2,"method":"thread/start","params":{}}');
  await expect.poll(() => messages.length).toBe(2);
  expect(messages.map(m => m.error.code)).toEqual([-32601, -32602]);
});
