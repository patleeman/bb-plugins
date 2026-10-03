import { createServer } from "node:http";
import { once } from "node:events";
import { expect, it } from "vitest";
import { experimental_runBridgeConformance, experimental_formatConformanceReport } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { createHermesBridge } from "./hermes-bridge.js";

it("passes the published BB bridge conformance suite with a Hermes HTTP fixture", async () => {
  let runNumber = 0;
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* Drain the request body. */ }
    if (req.url === "/v1/models") { res.setHeader("Content-Type", "application/json"); res.end('{"data":[{"id":"fixture"}]}'); }
    else if (req.url === "/v1/runs") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ run_id: `run-${++runNumber}` })); }
    else if (req.url?.endsWith("/events")) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end('data: {"event":"message.delta","delta":"ok"}\n\ndata: {"event":"run.completed","output":"ok"}\n\n: stream closed\n\n');
    } else { res.setHeader("Content-Type", "application/json"); res.end('{}'); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Missing fixture port");
  process.env.HERMES_CONFORMANCE_TOKEN = "fixture";
  const messages: any[] = [];
  const bridge = createHermesBridge(line => messages.push(JSON.parse(line)));
  try {
    const report = await experimental_runBridgeConformance({
      transport: { send: bridge.handleLine, takeMessages: () => messages.splice(0) },
      providerId: "hermes",
      session: {
        cwd: "/tmp", promptInput: [{ type: "text", text: "Reply with ok", mentions: [] }],
        options: { permissionMode: "full", permissionScope: "full", approvalReviewer: null, permissionEscalation: null, providerOptions: { baseUrl: `http://127.0.0.1:${address.port}`, enabled: true, tokenEnv: "HERMES_CONFORMANCE_TOKEN" } },
      }, timeoutMs: 2000,
    });
    expect(report.passed, experimental_formatConformanceReport(report)).toBe(true);
  } finally { bridge.onClose?.(); server.closeAllConnections(); server.close(); delete process.env.HERMES_CONFORMANCE_TOKEN; }
}, 20_000);
