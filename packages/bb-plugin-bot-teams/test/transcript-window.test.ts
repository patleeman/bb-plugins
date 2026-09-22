import test from "node:test";
import assert from "node:assert/strict";
import { extendTranscript, type TranscriptPage } from "../transcript-window";
import type { RoomMessage } from "../contract";

const message = (n: number): RoomMessage => ({
  id: `m:${n}`,
  roomId: "room",
  runId: "fixture",
  botId: null,
  speaker: "You",
  text: `${n}`,
  replyTo: null,
  attachments: [],
  createdAt: 1,
});
const page = (start: number, end: number): TranscriptPage => ({
  messages: Array.from({ length: end - start }, (_, i) => message(start + i)),
  parents: [],
  reactions: [],
  hasOlder: start > 0,
  hasNewer: end < 1000,
});

test("scrolling through a long transcript keeps a contiguous window in both directions", () => {
  let window = page(950, 1000);
  for (let n = 900; n >= 0; n -= 50) {
    window = extendTranscript(window, page(n, n + 50), "older");
    assert(window.messages.length <= 150);
    assert.equal(window.messages[0]!.id, `m:${n}`);
    assert.equal(window.messages.at(-1)!.id, `m:${Math.min(n + 149, 999)}`);
  }
  assert.equal(window.hasOlder, false);
  assert.equal(window.hasNewer, true);
  for (let n = 150; n < 1000; n += 50) {
    window = extendTranscript(window, page(n, n + 50), "newer");
    assert.equal(window.messages.length, 150);
    assert.equal(window.messages[0]!.id, `m:${n - 100}`);
    assert.equal(window.messages.at(-1)!.id, `m:${n + 49}`);
  }
  assert.equal(window.hasNewer, false);
  assert.equal(window.hasOlder, true);
});

test("eviction also bounds reply parents and reactions; refreshed pages remove stale reactions", () => {
  const current = page(100, 250);
  current.messages[0]!.replyTo = "m:1";
  current.messages.at(-1)!.replyTo = "m:2";
  current.parents = [message(1), message(2)];
  current.reactions = [100, 249].map((n) => ({
    messageId: `m:${n}`,
    emoji: "👍",
    actorId: "user",
    actorName: "You",
    createdAt: 1,
  }));
  const older = extendTranscript(current, page(50, 100), "older");
  assert.deepEqual(
    older.parents.map((m) => m.id),
    ["m:1"],
  );
  assert.deepEqual(
    older.reactions.map((r) => r.messageId),
    ["m:100"],
  );
  const refreshed = extendTranscript(current, page(200, 250), "newer");
  assert.deepEqual(
    refreshed.reactions.map((r) => r.messageId),
    ["m:100"],
  );
  assert.equal(new Set(refreshed.messages.map((m) => m.id)).size, 150);
});
