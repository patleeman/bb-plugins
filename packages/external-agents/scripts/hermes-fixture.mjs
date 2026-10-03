#!/usr/bin/env node
// Deterministic local Hermes API fixture for staged BB approval verification.
// No commands run. Every turn waits for a BB approval, then returns "ok".
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
const runs = new Map();
const server = createServer(async (req, res) => {
  if (req.headers.authorization !== 'Bearer bb-hermes-fixture') { res.writeHead(401); res.end(); return; }
  let data = '';
  for await (const chunk of req) data += chunk;
  const body = data ? JSON.parse(data) : {};
  const json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
  if (req.url === '/v1/models') return json({ data: [{ id: 'hermes-fixture' }] });
  if (req.url === '/v1/runs' && req.method === 'POST') {
    const runId = randomUUID();
    runs.set(runId, { requestId: randomUUID(), sessionId: body.session_id });
    res.statusCode = 202; return json({ run_id: runId, status: 'started', replayed: false });
  }
  const [, runId, action] = /^\/v1\/runs\/([^/]+)\/(events|approval|stop|steer)$/.exec(req.url) ?? [];
  const run = runs.get(runId);
  if (!run) { res.statusCode = 404; return json({ error: 'not found' }); }
  const emit = event => run.stream?.write(`data: ${JSON.stringify({ run_id: runId, timestamp: Date.now() / 1000, ...event })}\n\n`);
  if (action === 'events') {
    run.stream = res;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    emit({ event: 'approval.request', request_id: run.requestId, command: 'echo ok (fixture: no command is executed)', reason: 'Staged BB approval round-trip', choices: ['once', 'deny'] });
    return;
  }
  if (action === 'approval') {
    if (body.request_id !== run.requestId) { res.statusCode = 400; return json({ error: 'wrong approval request' }); }
    emit({ event: 'message.delta', delta: body.choice === 'once' ? 'ok' : 'denied' });
    emit({ event: 'run.completed', output: body.choice === 'once' ? 'ok' : 'denied' });
    run.stream?.end(': stream closed\n\n'); runs.delete(runId);
    console.log(JSON.stringify({ action: 'approval', choice: body.choice, matchedRequest: true }));
  }
  if (action === 'stop') { emit({ event: 'run.cancelled' }); run.stream?.end(); runs.delete(runId); }
  json({ ok: true });
});
server.listen(Number(process.env.HERMES_FIXTURE_PORT || 49389), '127.0.0.1', () => console.log('Hermes fixture ready on loopback'));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { server.closeAllConnections(); server.close(); });
