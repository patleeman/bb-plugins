import test from "node:test";
import assert from "node:assert/strict";
import { liveChannelDms } from "../channel-dms";

const rows = [
  { threadId: "thr_alive", botId: "bot_a" },
  { threadId: "thr_gone", botId: "bot_b" },
  { threadId: "thr_also_gone", botId: "bot_c" },
];
const exists = async (threadId: string) => threadId === "thr_alive";

test("a DM whose thread is gone is dropped and reported for forgetting", async () => {
  const { live, stale } = await liveChannelDms(rows, exists);
  assert.deepEqual(
    live.map((row) => row.threadId),
    ["thr_alive"],
  );
  assert.deepEqual(stale, ["thr_gone", "thr_also_gone"]);
});

test("every DM surviving means nothing is forgotten", async () => {
  const { live, stale } = await liveChannelDms(rows, async () => true);
  assert.equal(live.length, rows.length);
  assert.deepEqual(stale, []);
});

test("a deleted project takes every DM with it", async () => {
  const { live, stale } = await liveChannelDms(rows, async () => false);
  assert.deepEqual(live, []);
  assert.equal(stale.length, rows.length);
});

test("order is preserved so the roster does not reshuffle", async () => {
  const { live } = await liveChannelDms(rows, async (id) => id !== "thr_gone");
  assert.deepEqual(
    live.map((row) => row.threadId),
    ["thr_alive", "thr_also_gone"],
  );
});

test("an existence check that throws is the caller's to handle, not swallowed", async () => {
  await assert.rejects(
    liveChannelDms(rows, async () => {
      throw new Error("host unreachable");
    }),
    /host unreachable/,
  );
});
