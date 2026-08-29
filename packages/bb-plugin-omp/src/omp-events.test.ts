import { describe, expect, it } from "vitest";
import {
  threadDeltaSchema,
  type ThreadDelta,
} from "@get-bb/plugin-sdk/provider-bridge";
import { createOmpEventTranslator } from "./omp-events.js";

const context = {
  threadId: "thr_test",
  cwd: "/tmp/project",
  modelContextWindow: 128_000,
};

function translate(event: Record<string, unknown>): ThreadDelta[] {
  return createOmpEventTranslator().translate(event, context);
}

function expectValid(deltas: readonly ThreadDelta[]): void {
  for (const delta of deltas) {
    expect(threadDeltaSchema.safeParse(delta).success, JSON.stringify(delta)).toBe(true);
  }
}

describe("OMP event translation", () => {
  it("maps streamed text and thinking to the v3 keyed text dialect", () => {
    const translator = createOmpEventTranslator();
    const text = translator.translate({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "hello" },
    }, context);
    const thinking = translator.translate({
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 1,
        delta: "first,",
      },
    }, context);
    expect(text[0]).toEqual({
      kind: "item.textDelta",
      key: { channel: "assistant" },
      channel: "agentMessage",
      text: "hello",
    });
    expect(thinking[0]).toEqual({
      kind: "item.textDelta",
      key: { channel: "thinking-1" },
      channel: "reasoningText",
      text: "first,",
    });
    expectValid([...text, ...thinking]);
  });

  it("maps native tool lifecycle and terminal output", () => {
    const translator = createOmpEventTranslator();
    const opened = translator.translate({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "pwd", cwd: "/tmp/project" },
    }, context);
    const closed = translator.translate({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "/tmp/project" }] },
      isError: false,
    }, context);
    expect(opened[0]).toMatchObject({
      kind: "item.open",
      key: { providerItemId: "call-1" },
      item: { type: "command", command: "pwd", cwd: "/tmp/project" },
    });
    expect(closed[0]).toMatchObject({
      kind: "item.close",
      status: "completed",
      resultText: "/tmp/project",
      item: { type: "command", command: "pwd", cwd: "/tmp/project" },
    });
    expectValid([...opened, ...closed]);
  });

  it("closes a successful run with usage and a context window", () => {
    const deltas = translate({
      type: "agent_end",
      messages: [{
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        stopReason: "stop",
        usage: { input: 10, output: 4, totalTokens: 14 },
      }],
    });
    expect(deltas).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "item.textClose", channel: "agentMessage" }),
      expect.objectContaining({
        kind: "usage",
        last: expect.objectContaining({ inputTokens: 10, outputTokens: 4, totalTokens: 14 }),
        modelContextWindow: 128_000,
      }),
      expect.objectContaining({ kind: "turn.boundary", status: "completed" }),
    ]));
    expectValid(deltas);
  });

  it("keeps the usage total across turns until the session resets", () => {
    const translator = createOmpEventTranslator();
    const run = (input: number, output: number) => translator.translate({
      type: "agent_end",
      messages: [{
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        stopReason: "stop",
        usage: { input, output, totalTokens: input + output },
      }],
    }, context);

    const first = run(10, 4).find((delta) => delta.kind === "usage");
    const second = run(3, 4).find((delta) => delta.kind === "usage");
    expect(first).toMatchObject({ total: { totalTokens: 14 } });
    expect(second).toMatchObject({ total: { totalTokens: 21 } });

    translator.resetThread(context.threadId);
    const afterReset = run(3, 4).find((delta) => delta.kind === "usage");
    expect(afterReset).toMatchObject({ total: { totalTokens: 7 } });
  });

  it("renders local-only command output and closes the turn without agent_end", () => {
    const translator = createOmpEventTranslator();
    const output = translator.translate({
      type: "command_output",
      text: "Available commands",
    }, context);
    const completed = translator.translate({
      type: "prompt_result",
      id: "prompt-1",
      agentInvoked: false,
    }, context);
    const duplicate = translator.translate({
      type: "prompt_result",
      id: "prompt-1",
      agentInvoked: false,
    }, context);

    expect(output).toEqual([
      { kind: "turn.open" },
      {
        kind: "item.textDelta",
        key: { channel: "local-command" },
        channel: "agentMessage",
        text: "Available commands",
      },
    ]);
    expect(completed).toEqual([
      {
        kind: "item.textClose",
        key: { channel: "local-command" },
        channel: "agentMessage",
      },
      { kind: "turn.boundary", status: "completed" },
    ]);
    expect(duplicate).toEqual([]);
    expectValid([...output, ...completed]);
  });

  it("closes automatic and manual compactions with terminal statuses", () => {
    const translator = createOmpEventTranslator();
    const automaticStart = translator.translate({
      type: "auto_compaction_start",
      reason: "threshold",
    }, context);
    const automaticEnd = translator.translate({
      type: "auto_compaction_end",
      reason: "threshold",
    }, context);
    const skippedStart = translator.translate({ type: "compaction_start" }, context);
    const skippedEnd = translator.translate({
      type: "compaction_end",
      errorMessage: "Compaction failed: Nothing to compact (session too small)",
    }, context);
    const failedStart = translator.translate({ type: "compaction_start" }, context);
    const failedEnd = translator.translate({
      type: "compaction_end",
      errorMessage: "Compaction failed: provider error",
    }, context);
    const abortedStart = translator.translate({ type: "compaction_start" }, context);
    const abortedEnd = translator.translate({ type: "compaction_end", aborted: true }, context);

    expect(automaticStart[0]).toMatchObject({
      kind: "item.open",
      key: { channel: "compaction" },
      item: { type: "compaction" },
    });
    expect(automaticEnd).toEqual([
      { kind: "item.close", key: { channel: "compaction" }, status: "completed", item: { type: "compaction" } },
      { kind: "context.compacted" },
    ]);
    expect(skippedEnd).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "item.close", status: "completed" }),
      expect.objectContaining({ kind: "provider.warning", category: "compaction-skipped" }),
      expect.objectContaining({ kind: "turn.boundary", status: "completed" }),
    ]));
    expect(failedEnd).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "item.close", status: "failed" }),
      expect.objectContaining({ kind: "turn.boundary", status: "failed" }),
    ]));
    expect(abortedEnd).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "item.close", status: "interrupted" }),
      expect.objectContaining({ kind: "turn.boundary", status: "interrupted" }),
    ]));
    expectValid([
      ...automaticStart,
      ...automaticEnd,
      ...skippedStart,
      ...skippedEnd,
      ...failedStart,
      ...failedEnd,
      ...abortedStart,
      ...abortedEnd,
    ]);
  });
});
