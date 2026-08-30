import { describe, expect, it } from "vitest";
import {
  computeTurnRates,
  formatRate,
  turnIdFromRowId,
  type EventRow,
} from "./rate";

function started(
  seq: number,
  createdAt: number,
  turnId: string,
  kind = "reasoning",
  itemId = `item-${seq}`,
): EventRow {
  return {
    seq,
    createdAt,
    type: "item/started",
    scope: { kind: "turn", turnId },
    data: { item: { type: kind, id: itemId } },
  };
}

function completed(
  seq: number,
  createdAt: number,
  turnId: string,
  kind: string,
  itemId: string,
): EventRow {
  return {
    seq,
    createdAt,
    type: "item/completed",
    scope: { kind: "turn", turnId },
    data: { item: { type: kind, id: itemId } },
  };
}

function usage(
  seq: number,
  createdAt: number,
  turnId: string,
  outputTokens: number | null,
): EventRow {
  return {
    seq,
    createdAt,
    type: "thread/tokenUsage/updated",
    scope: { kind: "turn", turnId },
    data: { tokenUsage: { last: { outputTokens } } },
  };
}

function requested(seq: number, createdAt: number, expectedTurnId: string): EventRow {
  return {
    seq,
    createdAt,
    type: "client/turn/requested",
    scope: { kind: "thread" },
    data: { target: { expectedTurnId } },
  };
}

describe("computeTurnRates", () => {
  it("pools provider time and excludes host execution", () => {
    const result = computeTurnRates({
      turnIds: ["turn-1"],
      events: [
        started(1, 0, "turn-1", "reasoning", "response-1-reasoning"),
        completed(2, 600, "turn-1", "reasoning", "response-1-reasoning"),
        started(3, 600, "turn-1", "agentMessage", "response-1-message"),
        completed(4, 1_000, "turn-1", "agentMessage", "response-1-message"),
        // This host-executed interval must not be part of provider speed.
        started(5, 1_100, "turn-1", "commandExecution", "host-command-1"),
        completed(6, 1_900, "turn-1", "commandExecution", "host-command-1"),
        usage(7, 2_000, "turn-1", 100),
        started(8, 3_000, "turn-1", "reasoning", "response-2-reasoning"),
        completed(9, 3_300, "turn-1", "reasoning", "response-2-reasoning"),
        started(10, 3_300, "turn-1", "toolCall", "response-2-tool"),
        completed(11, 3_400, "turn-1", "toolCall", "response-2-tool"),
        started(12, 3_500, "turn-1", "commandExecution", "host-command-2"),
        completed(13, 4_500, "turn-1", "commandExecution", "host-command-2"),
        usage(14, 5_000, "turn-1", 200),
      ],
    });

    expect(result.get("turn-1")).toMatchObject({
      turnId: "turn-1",
      totalOutputTokens: 300,
      responseCount: 2,
    });
    expect(result.get("turn-1")?.rate).toBeCloseTo(214.2857142857143, 12);
  });

  it("measures a tool-only response when reasoning is omitted", () => {
    const result = computeTurnRates({
      turnIds: ["turn-1"],
      events: [
        started(1, 100, "turn-1", "toolCall", "tool-only"),
        completed(2, 1_100, "turn-1", "toolCall", "tool-only"),
        usage(3, 1_100, "turn-1", 50),
      ],
    });

    expect(result.get("turn-1")?.rate).toBe(50);
  });

  it("does not carry provider intervals across a same-turn steer", () => {
    const result = computeTurnRates({
      turnIds: ["turn-1"],
      events: [
        started(1, 0, "turn-1", "reasoning", "stale"),
        completed(2, 10_000, "turn-1", "reasoning", "stale"),
        requested(3, 10_100, "turn-1"),
        started(4, 10_200, "turn-1", "reasoning", "current"),
        completed(5, 10_700, "turn-1", "reasoning", "current"),
        usage(6, 10_800, "turn-1", 100),
      ],
    });

    expect(result.get("turn-1")).toMatchObject({
      rate: 200,
      totalOutputTokens: 100,
      responseCount: 1,
    });
  });

  it("keeps interleaved turns separate and ignores unusable samples", () => {
    const result = computeTurnRates({
      turnIds: ["turn-a", "turn-b"],
      events: [
        started(1, 0, "turn-a", "reasoning", "a-first"),
        completed(2, 100, "turn-a", "reasoning", "a-first"),
        started(3, 100, "turn-b", "reasoning", "b-first"),
        completed(4, 150, "turn-b", "reasoning", "b-first"),
        usage(5, 200, "turn-b", 10),
        usage(6, 300, "turn-a", 20),
        started(7, 400, "turn-a", "reasoning", "a-too-fast"),
        completed(8, 401, "turn-a", "reasoning", "a-too-fast"),
        usage(9, 402, "turn-a", 100),
        started(10, 500, "turn-b", "reasoning", "b-too-long"),
        usage(11, 2_300_001, "turn-b", 100),
        started(12, 2_000_000, "turn-a", "reasoning", "a-invalid"),
        completed(13, 2_000_100, "turn-a", "reasoning", "a-invalid"),
        usage(14, 2_001_000, "turn-a", null),
      ],
    });

    expect(result.get("turn-a")).toMatchObject({
      rate: 200,
      totalOutputTokens: 20,
      responseCount: 1,
    });
    expect(result.get("turn-b")).toMatchObject({
      rate: 200,
      totalOutputTokens: 10,
      responseCount: 1,
    });
  });
});

describe("rate display helpers", () => {
  it("extracts the turn marker from an assistant timeline row", () => {
    expect(
      turnIdFromRowId(
        "thr-1:assistant:kind:assistant|turn:turn-42|parent:root|item:item-1",
      ),
    ).toBe("turn-42");
    expect(turnIdFromRowId("thr-1:user:1")).toBeUndefined();
  });

  it("formats rates at readable precision", () => {
    expect(formatRate(42.34)).toBe("42.3");
    expect(formatRate(123.4)).toBe("123");
    expect(formatRate(1234.4)).toBe("1,234");
    expect(formatRate(null)).toBe("");
  });
});
