import { z } from "zod";

export const connectionSchema = z.object({
  baseUrl: z.string().url().refine(value => {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  }, "Use an HTTP URL without credentials, query, or fragment"),
  tokenEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
  enabled: z.boolean(),
});
export type Connection = z.infer<typeof connectionSchema>;
export type HermesEvent = Record<string, unknown> & { event: string };
const eventSchema = z.object({ event: z.string() }).passthrough();

export class AgentConnectionError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}

/** No response bodies or underlying network errors enter diagnostics: either can contain credentials. */
export class HermesClient {
  readonly connection: Connection;
  private readonly token: string;
  constructor(connection: Connection, secret?: string, env: NodeJS.ProcessEnv = process.env) {
    this.connection = connectionSchema.parse(connection);
    this.token = secret || env[connection.tokenEnv] || "";
  }
  private async request(path: string, body?: unknown, signal?: AbortSignal, stream = false): Promise<Response> {
    if (!this.connection.enabled) throw new AgentConnectionError("Hermes is disabled in External Agents settings.");
    if (!this.token) throw new AgentConnectionError(`Hermes token is missing. Configure its secret or ${this.connection.tokenEnv} on the BB host.`);
    const timeout = AbortSignal.timeout(15_000);
    const requestSignal = stream ? signal : signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetch(`${this.connection.baseUrl.replace(/\/$/, "")}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: requestSignal,
        redirect: "error",
      });
    } catch {
      throw new AgentConnectionError(signal?.aborted ? "Hermes request was cancelled." : "Hermes is unreachable. Check its base URL, Tailscale, and the remote API server.");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new AgentConnectionError(response.status === 401 || response.status === 403
        ? "Hermes rejected its credentials. Check the configured token."
        : `Hermes API returned HTTP ${response.status}.`, response.status);
    }
    return response;
  }
  async json(path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    const response = await this.request(path, body, signal);
    try { return await response.json(); } catch { throw new AgentConnectionError("Hermes returned invalid JSON."); }
  }
  async models(): Promise<unknown> { return this.json("/v1/models"); }
  async start(input: string, sessionId: string, model?: string, instructions?: string): Promise<string> {
    const value = await this.json("/v1/runs", { input, session_id: sessionId, ...(model ? { model } : {}), ...(instructions ? { instructions } : {}) });
    const result = z.object({ run_id: z.string().min(1) }).safeParse(value);
    if (!result.success) throw new AgentConnectionError("Hermes did not return a run ID.");
    return result.data.run_id;
  }
  control(runId: string, action: "steer" | "stop" | "approval", body: unknown = {}): Promise<unknown> {
    return this.json(`/v1/runs/${encodeURIComponent(runId)}/${action}`, body);
  }
  async *events(runId: string, signal: AbortSignal): AsyncGenerator<HermesEvent> {
    // The stream has its own inactivity timeout, reset for every keepalive/data chunk.
    // Do not apply the JSON request deadline to an entire agent turn.
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => { clearTimeout(timer); timer = setTimeout(abort, 90_000); };
    try {
      arm();
      const response = await this.request(`/v1/runs/${encodeURIComponent(runId)}/events`, undefined, controller.signal, true);
      if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
        throw new AgentConnectionError("Hermes returned an invalid event stream.");
      }
      yield* parseSse(response.body, arm);
    } catch (error) {
      if (error instanceof AgentConnectionError) throw error;
      throw new AgentConnectionError(signal.aborted ? "Hermes stream was cancelled." : "Hermes event stream disconnected or timed out.");
    } finally {
      clearTimeout(timer);
      controller.abort();
      signal.removeEventListener("abort", abort);
    }
  }
}

export async function* parseSse(stream: ReadableStream<Uint8Array>, onChunk = () => {}): AsyncGenerator<HermesEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      onChunk();
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
        if (!data) continue;
        if (data.length > 1_048_576) throw new AgentConnectionError("Hermes event exceeds the size limit.");
        let parsed: unknown;
        try { parsed = JSON.parse(data); } catch { throw new AgentConnectionError("Hermes sent malformed event JSON."); }
        const event = eventSchema.safeParse(parsed);
        if (!event.success) throw new AgentConnectionError("Hermes sent an event without a name.");
        yield event.data;
      }
      if (buffer.length > 1_048_576) throw new AgentConnectionError("Hermes event exceeds the size limit.");
    }
    if (buffer.trim() && !buffer.trim().startsWith(":")) throw new AgentConnectionError("Hermes event stream ended mid-frame.");
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
