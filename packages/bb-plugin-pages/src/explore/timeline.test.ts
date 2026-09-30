import { describe, expect, it } from "vitest";
import { countReads, findMessage, olderCursor, turnHints } from "./timeline";

const work = (turnId: string, workKind: string, extra: Record<string, unknown>, createdAt = 1) => ({ kind: "work", turnId, workKind, createdAt, ...extra });

const rows = [
  { kind: "conversation", id: "msg_user", role: "user", turnId: "turn_1", text: "Why is billing slow?", sourceSeqEnd: 3 },
  {
    kind: "turn",
    turnId: "turn_1",
    children: [
      work("turn_1", "file-read", { path: "src/billing.ts" }),
      work("turn_1", "file-read", { path: "src/queue.ts" }),
      work("turn_1", "file-read", { path: "src/billing.ts" }),
      work("turn_1", "file-change", { change: { path: "src/queue.ts" } }),
      work("turn_1", "search", { query: "backoff", path: "src" }),
      { kind: "conversation", id: "msg_answer", role: "assistant", text: "Because…", sourceSeqEnd: 42 },
    ],
  },
  { kind: "turn", turnId: "turn_2", children: [work("turn_2", "file-read", { path: "README.md" }, 50)] },
];

describe("reading the timeline", () => {
  it("finds a nested message, its fork point and its turn", () => {
    expect(findMessage(rows, "msg_answer")).toEqual({ sourceSeqEnd: 42, turnId: "turn_1", text: "Because…" });
    expect(findMessage(rows, "missing")).toBeNull();
  });

  it("collects the turn's files once each, changed ones apart", () => {
    expect(turnHints(rows, "turn_1")).toEqual({ read: ["src/billing.ts"], changed: ["src/queue.ts"], searched: ["backoff in src"] });
    expect(turnHints(rows, "turn_2").read).toEqual(["README.md"]);
    expect(turnHints(rows, null)).toEqual({ read: [], changed: [], searched: [] });
  });

  it("counts a worker's reads since it started", () => {
    expect(countReads(rows)).toBe(5);
    expect(countReads(rows, 10)).toBe(1);
  });

  it("reads the older-page cursor", () => {
    expect(olderCursor({ timelinePage: { olderCursor: { anchorId: "row_1", anchorSeq: 7 } } })).toEqual({ beforeAnchorId: "row_1", beforeAnchorSeq: "7" });
    expect(olderCursor({ timelinePage: { olderCursor: null } })).toBeNull();
  });
});
