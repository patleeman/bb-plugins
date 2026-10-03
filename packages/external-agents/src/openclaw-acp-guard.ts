// Runs between the CLI and the SDK ACP bridge. Keeping this at the wire boundary
// preserves upstream error text before the generic bridge normalizes stop reasons.
export const openclawAcpGuard = String.raw`
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
const child = spawn('openclaw', process.argv.slice(2), { stdio: ['pipe', 'pipe', 'inherit'] });
const prompts = new Map();
const sessions = new Map();
const input = createInterface({ input: process.stdin });
const output = createInterface({ input: child.stdout });
const errorText = value => typeof value === 'string' ? value : typeof value?.message === 'string' ? value.message : undefined;
input.on('line', line => {
  try {
    const frame = JSON.parse(line);
    if (frame.method === 'session/prompt' && frame.id !== undefined) {
      const state = { output: false, error: undefined };
      prompts.set(frame.id, { sessionId: frame.params.sessionId, state });
      sessions.set(frame.params.sessionId, state);
    }
  } catch {}
  child.stdin.write(line + '\n');
});
output.on('line', line => {
  try {
    const frame = JSON.parse(line);
    if (frame.method === 'session/update') {
      const update = frame.params?.update;
      const state = sessions.get(frame.params?.sessionId);
      if (state && update) {
        if (update.sessionUpdate === 'agent_message_chunk') {
          const content = update.content;
          if (content?.type === 'text' ? Boolean(content.text?.trim()) : Boolean(content)) state.output = true;
        }
        const error = errorText(update.error) || errorText(update.errorMessage)
          || (['error', 'agent_error'].includes(update.sessionUpdate) ? errorText(update.message) || errorText(update.content?.text) : undefined);
        if (error) state.error = error;
      }
    }
    const prompt = prompts.get(frame.id);
    if (prompt && ('result' in frame || 'error' in frame)) {
      prompts.delete(frame.id);
      if (sessions.get(prompt.sessionId) === prompt.state) sessions.delete(prompt.sessionId);
      if (!frame.error) {
        const reason = frame.result?.stopReason;
        const error = prompt.state.error || errorText(frame.result?.error) || errorText(frame.result?.errorMessage)
          || (reason && !['end_turn', 'cancelled'].includes(reason) ? 'OpenClaw stopped: ' + reason : undefined)
          || (reason !== 'cancelled' && !prompt.state.output ? 'OpenClaw completed without assistant output. Check the Gateway upstream model authentication and run logs.' : undefined);
        if (error) { delete frame.result; frame.error = { code: -32000, message: error }; }
      }
      line = JSON.stringify(frame);
    }
  } catch {}
  process.stdout.write(line + '\n');
});
input.on('close', () => child.stdin.end());
child.stdin.on('error', () => {});
child.on('error', () => { process.stderr.write('OpenClaw CLI could not start.\n'); process.exitCode = 1; input.close(); });
child.on('close', code => { input.close(); process.exit(code ?? 1); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
`;
