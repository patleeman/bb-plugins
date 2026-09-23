import test from "node:test";
import assert from "node:assert/strict";
import type { NewThreadRequest } from "@get-bb/plugin-sdk";
import {
  createFakePluginHost,
  makeThreadResponse,
  makeMessageDispatchHookContext,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { botCreationPrompt } from "../bot-creation";

test("bot setup creates a visible thread with the composer's selections and input", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "bot-teams",
    agentSkillIds: ["bots"],
    sdk: {
      threads: { spawn: async () => makeThreadResponse({ id: "thr_setup" }) },
    },
  });
  await plugin(bb);
  try {
    const request: NewThreadRequest = {
      projectId: "proj_personal",
      providerId: "codex",
      model: "selected-model",
      reasoningLevel: "high",
      permissionMode: "auto",
      serviceTier: "fast",
      executionInputSources: {
        providerId: "explicit",
        model: "explicit",
        serviceTier: "explicit",
      },
      environment: {
        type: "provider",
        environmentProviderId: "environment-personal-workspace",
        inputs: null,
      },
      input: [
        {
          type: "text",
          text: botCreationPrompt({ id: "channel-a", name: "Research" }),
          mentions: [],
        },
        { type: "localFile", path: "/tmp/brief.md", name: "brief.md" },
      ],
    };
    const result = await harness.behavior.callRpc("createBotSetupThread", {
      ...request,
      visibility: "hidden",
      pluginMetadata: { botId: "not-a-bot-session" },
    });
    assert.deepEqual(result, { threadId: "thr_setup" });
    assert.deepEqual(harness.inspection.sdk.callsTo("threads.spawn"), [
      [
        {
          ...request,
          title: "Create a bot",
          origin: "app",
        },
      ],
    ]);
    const dispatch =
      harness.inspection.registrations.hooks["message.dispatch"]!;
    assert.deepEqual(
      await dispatch(
        makeMessageDispatchHookContext({
          thread: { id: "thr_setup", originPluginId: null },
        }),
      ),
      { action: "proceed" },
    );
    harness.inspection.sdk.stub("threads.spawn", async () => {
      throw new Error("Host unavailable");
    });
    await assert.rejects(
      harness.behavior.callRpc("createBotSetupThread", request),
      /Host unavailable/,
    );
  } finally {
    await harness.lifecycle.dispose();
  }
});
