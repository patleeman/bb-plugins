import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PROVIDER_BRIDGE_PROTOCOL_VERSION,
  THREAD_DELTA_GRAMMAR_V3,
  threadDeltaSchema,
} from "@get-bb/plugin-sdk/provider-bridge";
import { experimental_createBridgeJsonRpcTestHarness } from "@get-bb/plugin-sdk/provider-bridge/testing";
import {
  dwarfStarModelSupportsVision,
  dwarfStarStartupNoticeDeltas,
  dwarfStarToolAllowed,
  effectiveDwarfStarEndpoint,
  experimental_providerBridge,
  handleLine,
  mapDwarfStarModels,
  modelsMatchRequest,
  normalizeDwarfStarModelIds,
  normalizeDwarfStarToolImages,
  normalizeDwarfStarSseLine,
  promptToMessages,
  readSse,
} from "./provider-bridge.ts";

test("normalizes DwarfStar SSE data lines", () => {
  assert.equal(normalizeDwarfStarSseLine("data: {\"ok\":true}"), '{"ok":true}');
  assert.equal(normalizeDwarfStarSseLine("data:"), null);
  assert.equal(normalizeDwarfStarSseLine("event: message"), null);
});

test("recognizes the GLM 5.3 vision model family", () => {
  assert.equal(dwarfStarModelSupportsVision("glm-5.3-flash"), true);
  assert.equal(dwarfStarModelSupportsVision("zai/glm-5.3-flash-reasoner"), true);
  assert.equal(dwarfStarModelSupportsVision("deepseek-v4-flash"), false);
});

test("shims DS4's legacy GLM 5.2 discovery aliases when named as GLM 5.3", () => {
  assert.deepEqual(
    normalizeDwarfStarModelIds([
      { id: "glm-5.2", name: "GLM 5.3 Flash" },
      { id: "glm-5.2-chat", name: "GLM 5.3 Flash" },
      { id: "glm-5.2-reasoner", name: "GLM 5.3 Flash" },
    ]),
    ["glm-5.3-flash", "glm-5.3-flash-chat", "glm-5.3-flash-reasoner"],
  );
  assert.deepEqual(
    normalizeDwarfStarModelIds([{ id: "glm-5.2", name: "GLM 5.2" }]),
    ["glm-5.2"],
  );
});

test("uses DS4 model names to reject the wrong DeepSeek engine", () => {
  const flashModels = [
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Flash" },
  ];
  assert.equal(modelsMatchRequest(flashModels, "deepseek-v4-flash"), true);
  assert.equal(modelsMatchRequest(flashModels, "deepseek-v4-pro"), false);
});

test("preserves text and image order in multimodal prompts", async () => {
  const message = await promptToMessages([
    { type: "text", text: "before", mentions: [] },
    { type: "image", url: "data:image/png;base64,AAAA" },
    { type: "text", text: "after", mentions: [] },
  ]);
  assert.deepEqual(message.content, [
    { type: "text", text: "before" },
    { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    { type: "text", text: "after" },
  ]);
});

test("rejects an SSE stream that ends before DONE", async () => {
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[]}\n\n'));
        controller.close();
      },
    }),
  );
  await assert.rejects(
    readSse(response, () => undefined, new AbortController().signal),
    /ended before \[DONE\]/i,
  );
});

test("only forwards tools that are available, allowed, and safe for the mode", () => {
  assert.equal(dwarfStarToolAllowed(["ds4_read", "ds4_edit"], [], "ds4_read"), true);
  assert.equal(dwarfStarToolAllowed(["ds4_read"], ["ds4_read"], "ds4_read"), false);
  assert.equal(dwarfStarToolAllowed(["ds4_read"], [], "ds4_search"), false);
  assert.equal(dwarfStarToolAllowed(["ds4_edit"], [], "ds4_edit", true), false);
});

test("uses the effective host and port after extra arguments are appended", () => {
  assert.deepEqual(
    effectiveDwarfStarEndpoint(
      ["--host", "127.0.0.1", "--port", "8000", "--port", "9000"],
      { host: "127.0.0.1", port: 8000 },
    ),
    { host: "127.0.0.1", port: 9000 },
  );
});

test("shows cold DwarfStar startup as a separate transcript work item", () => {
  const open = dwarfStarStartupNoticeDeltas(
    "ds4-turn-1",
    "glm-5.3-flash",
    "open",
  )[0];
  const progress = dwarfStarStartupNoticeDeltas(
    "ds4-turn-1",
    "glm-5.3-flash",
    "progress",
    "Starting DwarfStar and loading the model. This can take a few minutes.",
  )[0];
  const close = dwarfStarStartupNoticeDeltas(
    "ds4-turn-1",
    "glm-5.3-flash",
    "close",
    "The selected model is ready.",
  )[0];

  assert.equal(threadDeltaSchema.safeParse(open).success, true);
  assert.equal(threadDeltaSchema.safeParse(progress).success, true);
  assert.equal(threadDeltaSchema.safeParse(close).success, true);
  assert.equal(open?.kind, "item.open");
  assert.equal(open?.item.type, "tool");
  assert.equal(open?.item.tool, "DwarfStar");
  assert.equal(open?.presentation?.label.pending, "Starting DwarfStar");
  assert.equal(progress?.kind, "item.progress");
  assert.equal(progress?.flush, true);
  assert.equal(close?.kind, "item.close");
  assert.equal(close?.status, "completed");
  assert.equal(close?.resultText, "The selected model is ready.");
  assert.deepEqual(open?.key, progress?.key);
  assert.deepEqual(progress?.key, close?.key);
});

test("bounds tool-result image count and aggregate payload size", () => {
  const small = { data: "AAAA", mimeType: "image/png" };
  assert.equal(normalizeDwarfStarToolImages(Array.from({ length: 17 }, () => small)).error !== null, true);

  const large = { data: "A".repeat(12 * 1024 * 1024), mimeType: "image/png" };
  const normalized = normalizeDwarfStarToolImages([large, large, large]);
  assert.match(normalized.error ?? "", /combined inline image data must be 32 MiB or smaller/i);
  assert.deepEqual(normalized.images, []);
});

test("publishes a provider-bridge handshake and a restorable thread", async () => {
  const dataDir = mkdtempSync(join("/tmp", "bb-ds4-bridge-test-"));
  const harness = experimental_createBridgeJsonRpcTestHarness(handleLine);
  const threadId = "thr_ds4_provider_bridge_test";
  const options = {
    model: "deepseek-v4-flash",
    reasoningLevel: "none",
    serviceTier: "default",
    providerOptions: {},
    permissionMode: "full",
    permissionScope: "full",
    approvalReviewer: null,
    permissionEscalation: null,
  };
  try {
    experimental_providerBridge.start?.({
      pluginId: "ds4",
      dataDir,
      tempDir: join(dataDir, "tmp"),
    });
    harness.sendRequest("initialize", "initialize", {
      protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
      grammarVersions: [THREAD_DELTA_GRAMMAR_V3, THREAD_DELTA_GRAMMAR_V3],
      client: { name: "ds4-test", version: "1" },
    });
    const initialize = await harness.waitForResponse("initialize");
    assert.equal(initialize.error, undefined);
    assert.equal((initialize.result as { protocolVersion: number }).protocolVersion, PROVIDER_BRIDGE_PROTOCOL_VERSION);

    harness.sendRequest("start", "thread/start", {
      threadId,
      cwd: dataDir,
      options,
      instructionMode: "append",
      dynamicTools: [],
      disallowedTools: [],
    });
    const start = await harness.waitForResponse("start");
    assert.deepEqual(start.result, { providerThreadId: "ds4_bridge_1", sessionRestorable: true });

    harness.sendRequest("stop", "thread/stop", {
      threadId,
      providerThreadId: "ds4_bridge_1",
      activeTurnId: null,
      intent: "release",
    });
    const stop = await harness.waitForResponse("stop");
    assert.deepEqual(stop.result, { ok: true, providerCheckpointId: null });
  } finally {
    harness.restore();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("lists canonical downloaded-model metadata", () => {
  const models = mapDwarfStarModels("/tmp/workspace");
  assert.ok(models.length > 0);
  assert.equal(models.filter((model) => model.isDefault).length, 1);
  assert.ok(models.every((model) => [
    "deepseek-v4-flash",
    "deepseek-v4-pro",
    "glm-5.2",
    "glm-5.3-flash",
  ].includes(model.id)));
});
