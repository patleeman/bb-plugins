import test from "node:test";
import assert from "node:assert/strict";
import { channelResponseFailures } from "../channel-work";
import { jobSchema } from "../contract";

test("failure notices show the newest unresolved attempts", () => {
  const job = (id: string, updatedAt: number, overrides: Record<string, unknown> = {}) =>
    jobSchema.parse({
      id,
      botId: "bot_0123456789abcdef",
      conversationKey: "group:room",
      threadId: null,
      text: "Review",
      status: "error",
      reply: null,
      error: "Provider unavailable",
      createdAt: updatedAt,
      updatedAt,
      startedAt: null,
      roomId: null,
      runId: null,
      ...overrides,
    });
  const jobs = [
    job("old", 1),
    job("replaced", 2),
    job("latest", 4),
    job("retry", 3, { status: "queued", error: null, retryOf: "replaced" }),
  ];
  assert.deepEqual(channelResponseFailures(jobs, 1).map((entry) => entry.id), ["latest"]);
  assert.deepEqual(channelResponseFailures(jobs).map((entry) => entry.id), ["old", "latest"]);
});
