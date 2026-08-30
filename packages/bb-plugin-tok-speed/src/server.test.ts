import { describe, expect, it } from "vitest";
import { computeThreadRates } from "../server";
import type { EventRow } from "./rate";

function event(type: string, createdAt: number, seq: number, data: EventRow["data"]): EventRow {
  return {
    type,
    createdAt,
    seq,
    scope: { kind: "turn", turnId: "turn-1" },
    data,
  };
}

describe("computeThreadRates", () => {
  it("returns thread-qualified rate objects rather than Map entries", () => {
    const result = computeThreadRates("thread-1", [
      event("item/started", 0, 1, { item: { type: "reasoning", id: "item-1" } }),
      event("item/completed", 1_000, 2, { item: { type: "reasoning", id: "item-1" } }),
      event("thread/tokenUsage/updated", 1_001, 3, {
        tokenUsage: { last: { outputTokens: 100 } },
      }),
    ]);

    expect(result).toEqual([
      {
        threadId: "thread-1",
        turnId: "turn-1",
        rate: 100,
        totalOutputTokens: 100,
        responseCount: 1,
      },
    ]);
  });
});
