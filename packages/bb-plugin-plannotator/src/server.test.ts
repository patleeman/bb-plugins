import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import {
  PLANNOTATOR_REALTIME_CHANNEL,
  PLANNOTATOR_RELAY_PATH,
} from "./constants";
import plugin, {
  shouldUseRemotePlannotatorMode,
  upstreamOriginForProvider,
} from "../server";

const hosts: FakePluginHost[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.harness.lifecycle.dispose()));
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function fakePlannotatorBinary(
  options: { approveAfterMs?: number | null } = {},
): Promise<string> {
  const approveAfterMs = options.approveAfterMs === undefined ? 150 : options.approveAfterMs;
  const directory = await mkdtemp(join(tmpdir(), "bb-plannotator-fake-"));
  temporaryDirectories.push(directory);
  const binary = join(directory, "plannotator");
  await writeFile(
    binary,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const ready = process.env.PLANNOTATOR_READY_FILE;
fs.mkdirSync(path.dirname(ready), { recursive: true });
fs.appendFileSync(ready, JSON.stringify({ url: "http://127.0.0.1:43210", isRemote: false, port: 43210 }) + "\\n");
${approveAfterMs === null
  ? "setInterval(() => undefined, 1000);"
  : `setTimeout(() => process.stdout.write(JSON.stringify({ approved: true }) + "\\n"), ${approveAfterMs});`}
process.stdin.resume();
`,
    "utf8",
  );
  await chmod(binary, 0o755);
  return binary;
}

async function reviewPanelTab(host: FakePluginHost) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const update = [...host.harness.sdk.calls]
      .reverse()
      .find((call) => call.path === "threads.tabs.update") as
      | { args: [input: { tabs: Array<Record<string, unknown>> }] }
      | undefined;
    const panel = update?.args[0].tabs.find(
      (tab) => tab.kind === "plugin-panel" && tab.actionId === "plannotator-review",
    );
    if (panel) return panel;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Expected a persisted Plannotator review tab");
}

function wireInteractionSdk(
  host: FakePluginHost,
  options: { conflictOnce?: boolean } = {},
): void {
  let revision = 1;
  let tabs: Array<Record<string, unknown>> = [];
  let conflictPending = options.conflictOnce === true;

  host.harness.sdk.stub("threads.tabs.get", () => {
    return { revision, tabs };
  });
  host.harness.sdk.stub("threads.tabs.update", (args) => {
    const input = args as unknown as {
      expectedRevision: number;
      tabs: Array<Record<string, unknown>>;
    };
    if (input.expectedRevision !== revision) {
      throw new Error("tabs revision conflict");
    }
    if (conflictPending) {
      conflictPending = false;
      revision += 1;
      throw new Error("tabs revision conflict");
    }
    tabs = input.tabs;
    revision += 1;
    return { revision, tabs };
  });
  host.harness.sdk.stub("threads.send", () => ({ ok: true, delivery: "queued" }));
}

async function sentReview(host: FakePluginHost) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const sent = host.harness.sdk.callsTo("threads.send")[0];
    if (sent) return sent;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Expected a Plannotator decision message");
}

describe("BB upstream Plannotator bridge", () => {
  it("enables remote Plannotator mode only for remotely reachable BB configurations", () => {
    expect(shouldUseRemotePlannotatorMode("http://127.0.0.1:38886")).toBe(false);
    expect(shouldUseRemotePlannotatorMode("https://machine.example.ts.net")).toBe(true);
    expect(
      shouldUseRemotePlannotatorMode(undefined, { BB_SERVER_BIND_HOST: "0.0.0.0" }),
    ).toBe(true);
    expect(
      shouldUseRemotePlannotatorMode("http://127.0.0.1:38886", {
        BB_APP_URL: "https://machine.example.ts.net",
        BB_SERVER_BIND_HOST: "127.0.0.1",
      }),
    ).toBe(true);
  });

  it("maps BB provider ids to upstream display identities", () => {
    expect(upstreamOriginForProvider("codex")).toBe("codex");
    expect(upstreamOriginForProvider("opencode")).toBe("opencode");
    expect(upstreamOriginForProvider("acp-claude-code")).toBe("claude-code");
    expect(upstreamOriginForProvider("omp")).toBe("pi");
    expect(upstreamOriginForProvider("unknown-provider")).toBe("codex");
  });

  it("registers the optional control plane without selecting a skill", async () => {
    const binary = await fakePlannotatorBinary();
    const host = createFakePluginHost({
      pluginId: "plannotator",
      settings: { binaryPath: binary },
      agentSkillIds: ["plan-review"],
    });
    hosts.push(host);
    await plugin(host.bb);

    expect(host.harness.inspection.registrations.rpcMethods).toEqual([
      "status",
      "getActiveReview",
      "cancelReview",
    ]);
    expect(
      host.harness.inspection.registrations.httpRoutes.map((route) => route.method),
    ).toEqual(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
    expect(host.harness.inspection.registrations.agentTools.map((tool) => tool.name)).toEqual([
      "plannotator_review_plan",
      "plannotator_review_status",
    ]);
    expect(host.harness.inspection.registrations.agentTools[0]?.instructions).toContain(
      "Native Plan mode remains separate",
    );
    expect(host.harness.inspection.registrations.agentTools[0]?.instructions).toContain(
      "The tool returns a pending review ID promptly",
    );
    expect(host.harness.inspection.registrations.cli).toBeNull();

    const resolved = await host.harness.behavior.resolveAgentConfiguration({
      thread: {
        id: "thread-1",
        title: "Bridge test",
        parentThreadId: null,
        sourceThreadId: null,
      },
      project: {
        id: "project-1",
        kind: "standard" as const,
        name: "Test project",
        gitRemoteUrl: null,
      },
      environment: {
        id: "environment-1",
        name: "Local",
        path: "/workspace",
        workspaceProvisionType: "unmanaged" as const,
        branchName: null,
      },
      host: { id: "host-1", name: "Local host" },
      provider: { id: "codex", model: "test-model", capabilities: { supportsNativeUserQuestion: false } },
      origin: { kind: null, pluginId: null },
    });
    expect(resolved.skills).toEqual([]);
  });

  it("returns a review ID promptly and sends approval in a new thread message", async () => {
    const binary = await fakePlannotatorBinary({ approveAfterMs: 500 });
    const host = createFakePluginHost({
      pluginId: "plannotator",
      settings: { binaryPath: binary },
    });
    hosts.push(host);
    await plugin(host.bb);
    wireInteractionSdk(host, { conflictOnce: true });

    const toolCall = host.harness.behavior.callAgentTool(
      "plannotator_review_plan",
      { title: "Upstream UI", planMarkdown: "# Plan\n\n- Use the real app" },
      { threadId: "thread-1", projectId: "project-1" },
    );
    const panel = await reviewPanelTab(host);
    expect(panel).toMatchObject({
      kind: "plugin-panel",
      actionId: "plannotator-review",
    });
    expect(JSON.parse(String(panel.paramsJson))).toMatchObject({
      sessionUrl: "http://127.0.0.1:43210",
      threadId: "thread-1",
      relayPath: PLANNOTATOR_RELAY_PATH,
    });
    expect(host.harness.inspection.pendingInteractions).toHaveLength(0);
    expect(
      await host.harness.callRpc("getActiveReview", { threadId: "thread-1" }),
    ).toMatchObject({
      threadId: "thread-1",
      title: "Upstream UI",
      relayPath: PLANNOTATOR_RELAY_PATH,
    });
    expect(host.harness.realtimeSignals).toContainEqual({
      channel: PLANNOTATOR_REALTIME_CHANNEL,
      payload: {
        kind: "review-opened",
        payload: expect.objectContaining({
          sessionId: expect.any(String),
          threadId: "thread-1",
          relayPath: PLANNOTATOR_RELAY_PATH,
        }),
      },
    });

    const result = JSON.parse(String(await toolCall)) as { status: string; reviewId: string };
    expect(result).toMatchObject({ status: "pending", reviewId: expect.any(String) });
    expect(host.harness.sdk.callsTo("threads.send")).toHaveLength(0);
    expect(await host.harness.behavior.callAgentTool(
      "plannotator_review_status",
      { reviewId: result.reviewId },
      { threadId: "thread-1", projectId: "project-1" },
    )).toContain('"status":"pending"');
    const sent = await sentReview(host);
    expect(sent[0]).toMatchObject({
      threadId: "thread-1",
      mode: "queue-if-active",
      input: [{ type: "text", text: expect.stringContaining('"decision":"approved"') }],
    });
    expect(String((sent[0] as { input: Array<{ text: string }> }).input[0]!.text)).toContain(result.reviewId);
    expect(await host.harness.behavior.callAgentTool(
      "plannotator_review_status",
      { reviewId: result.reviewId },
      { threadId: "thread-1", projectId: "project-1" },
    )).toContain('"decision":"approved"');
    expect(host.harness.inspection.pendingInteractions).toHaveLength(0);
    expect(host.harness.sdk.callsTo("threads.interactions.respond")).toHaveLength(0);
    const finalTabUpdateCall = [...host.harness.sdk.calls]
      .reverse()
      .find((call) => call.path === "threads.tabs.update");
    expect(finalTabUpdateCall?.args[0]).toMatchObject({
      threadId: "thread-1",
      tabs: [],
    });
  });

  it("cancels the upstream process through the thread-owned panel RPC", async () => {
    const binary = await fakePlannotatorBinary({ approveAfterMs: null });
    const host = createFakePluginHost({
      pluginId: "plannotator",
      settings: { binaryPath: binary },
    });
    hosts.push(host);
    await plugin(host.bb);
    wireInteractionSdk(host);

    const toolCall = host.harness.behavior.callAgentTool(
      "plannotator_review_plan",
      { planMarkdown: "# Plan\n\n- Cancel me" },
      { threadId: "thread-1", projectId: "project-1" },
    );
    const panel = await reviewPanelTab(host);
    const payload = JSON.parse(String(panel.paramsJson)) as { sessionId: string };
    await expect(
      host.harness.callRpc("cancelReview", {
        threadId: "thread-1",
        sessionId: payload.sessionId,
      }),
    ).resolves.toEqual({ cancelled: true });

    const result = JSON.parse(String(await toolCall)) as { status: string };
    expect(result.status).toBe("pending");
    expect((await sentReview(host))[0]).toMatchObject({
      input: [{ text: expect.stringContaining('"decision":"cancelled"') }],
    });
    expect(host.harness.inspection.pendingInteractions).toHaveLength(0);
    const finalTabUpdateCall = [...host.harness.sdk.calls]
      .reverse()
      .find((call) => call.path === "threads.tabs.update");
    expect(finalTabUpdateCall?.args?.[0]).toMatchObject({
      tabs: [],
    });
  });

  it("rejects cancellation from another thread or session", async () => {
    const binary = await fakePlannotatorBinary();
    const host = createFakePluginHost({
      pluginId: "plannotator",
      settings: { binaryPath: binary },
    });
    hosts.push(host);
    await plugin(host.bb);

    await expect(
      host.harness.callRpc("cancelReview", {
        threadId: "thread-1",
        sessionId: "not-active",
      }),
    ).resolves.toEqual({ cancelled: false });
  });

  it("removes deleted reviews before asynchronous cleanup", async () => {
    const binary = await fakePlannotatorBinary({ approveAfterMs: null });
    const host = createFakePluginHost({
      pluginId: "plannotator",
      settings: { binaryPath: binary },
    });
    hosts.push(host);
    await plugin(host.bb);
    wireInteractionSdk(host);

    const toolCall = host.harness.behavior.callAgentTool(
      "plannotator_review_plan",
      { planMarkdown: "# Plan\n\n- Delete me" },
      { threadId: "thread-1", projectId: "project-1" },
    );
    const panel = await reviewPanelTab(host);
    const payload = JSON.parse(String(panel.paramsJson)) as {
      sessionId: string;
    };
    await expect(
      host.harness.callRpc("getActiveReview", { threadId: "thread-1" }),
    ).resolves.toMatchObject({ sessionId: payload.sessionId });

    await host.harness.behavior.emitThreadEvent("thread.deleted", {
      thread: makeThreadResponse({ id: "thread-1" }),
    });
    await expect(
      host.harness.callRpc("getActiveReview", { threadId: "thread-1" }),
    ).resolves.toBeNull();

    await toolCall;
    expect(host.harness.sdk.callsTo("threads.send")).toHaveLength(0);
  });

  it("recovers an interrupted review and retries a failed decision send", async () => {
    const host = createFakePluginHost({ pluginId: "plannotator" });
    hosts.push(host);
    await plugin(host.bb);
    wireInteractionSdk(host);
    const reviewId = "bb883ad4-4ff7-4183-96eb-6250ae380c3a";
    const key = `review:${reviewId}`;
    await host.bb.storage.kv.set(key, {
      id: reviewId,
      threadId: "thread-1",
      status: "pending",
      updatedAt: Date.now(),
    });
    let failSend = true;
    host.harness.sdk.stub("threads.send", () => {
      if (failSend) throw new Error("temporary send failure");
      return { ok: true, delivery: "queued" };
    });

    const first = host.harness.behavior.runService("review-delivery");
    await sentReview(host);
    first.controller.abort();
    await first.done;
    expect(await host.bb.storage.kv.get<{ status: string }>(key)).toMatchObject({
      status: "ready",
      result: { decision: "cancelled", error: expect.stringContaining("restarted") },
    });

    failSend = false;
    const second = host.harness.behavior.runService("review-delivery");
    for (let attempt = 0; attempt < 100 && host.harness.sdk.callsTo("threads.send").length < 2; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    expect(host.harness.sdk.callsTo("threads.send")).toHaveLength(2);
    second.controller.abort();
    await second.done;
    expect(await host.bb.storage.kv.get<{ status: string }>(key)).toMatchObject({
      status: "delivered",
    });
  });

  it("returns an actionable error when the official binary is missing", async () => {
    const host = createFakePluginHost({
      pluginId: "plannotator",
      settings: { binaryPath: "/definitely/missing/plannotator" },
    });
    hosts.push(host);
    await plugin(host.bb);

    const result = await host.harness.behavior.callAgentTool(
      "plannotator_review_plan",
      { planMarkdown: "# Plan" },
      { threadId: "thread-1", projectId: "project-1" },
    );
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain("bundled");
  });
});
