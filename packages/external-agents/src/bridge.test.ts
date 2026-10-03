import { expect, it, vi } from "vitest";
import { experimental_defineProviderBridge } from "@get-bb/plugin-sdk/provider-bridge";
import { createProviderBridge } from "./bridge.js";
import { prepareOpenClaw } from "./openclaw.js";

function fixture(agents = async () => []) {
  const forwarded: Record<string, any>[] = [];
  const replies: Record<string, any>[] = [];
  const dispose = vi.fn(async () => {});
  const launch = vi.fn((thread: string, model: unknown) => ({ command: "fake-openclaw", displayName: "OpenClaw", args: [thread, String(model)], env: {} }));
  const client = { agents, dispose, launch };
  const bridge = createProviderBridge({
    acp: experimental_defineProviderBridge({ handleLine: line => forwarded.push(JSON.parse(line)) }),
    prepare: (async () => client) as typeof prepareOpenClaw,
    write: line => replies.push(JSON.parse(line)),
  });
  const start = { jsonrpc: "2.0", id: 1, method: "thread/start", params: { threadId: "thread-1", cwd: "/tmp", dynamicTools: [{ name: "local-tool" }], options: { model: "openclaw/main", providerOptions: { provider: "openclaw", baseUrl: "ws://127.0.0.1:1234", tokenEnv: "TEST_TOKEN", enabled: true } } } };
  return { forwarded, replies, dispose, launch, bridge, start };
}
it("delegates to the SDK ACP bridge without unsupported local MCP servers or LLM model selection", async () => {
  const f = fixture();
  f.bridge.handleLine(JSON.stringify(f.start));
  await expect.poll(() => f.forwarded.length).toBe(1);
  expect(f.forwarded[0]!.params.dynamicTools).toEqual([]);
  expect(f.forwarded[0]!.params.options.model).toBeUndefined();
  expect(f.launch).toHaveBeenCalledWith("thread-1", "openclaw/main");
  f.bridge.handleLine(JSON.stringify({ id: 2, method: "turn/start", params: { threadId: "thread-1", options: { model: "openclaw/other" } } }));
  await expect.poll(() => f.replies.length).toBe(1);
  expect(f.replies[0]!.error.message).toContain("different OpenClaw Gateway agent");
  expect(f.forwarded).toHaveLength(1);
  f.bridge.onClose?.();
});
it("does not launch a session after stop arrives during preflight", async () => {
  let resolveProbe!: (value: []) => void;
  const probe = new Promise<[]> (resolve => { resolveProbe = resolve; });
  const f = fixture(() => probe);
  f.bridge.handleLine(JSON.stringify(f.start));
  await new Promise(resolve => setTimeout(resolve, 0));
  f.bridge.handleLine(JSON.stringify({ id: 2, method: "thread/stop", params: { threadId: "thread-1", intent: "interrupt" } }));
  resolveProbe([]);
  await expect.poll(() => f.replies.length).toBe(1);
  expect(f.replies[0]!.error.message).toContain("cancelled");
  expect(f.forwarded.map(m => m.method)).toEqual(["thread/stop"]);
  expect(f.dispose).toHaveBeenCalled();
  f.bridge.onClose?.();
});
