import test from "node:test";
import assert from "node:assert/strict";
import { SharedReads } from "../shared-read";

test("header and transcript share a pending read; later refreshes read current data", async () => {
  const reads = new SharedReads();
  let calls = 0;
  let resolve!: (n: number) => void;
  const fetch = () => {
    calls++;
    return new Promise<number>((r) => {
      resolve = r;
    });
  };
  const a = reads.read("room", fetch),
    b = reads.read("room", fetch);
  await Promise.resolve();
  assert.equal(calls, 1);
  resolve(1);
  assert.deepEqual(await Promise.all([a, b]), [1, 1]);
  assert.equal(await reads.read("room", async () => 2), 2);
});
test("a failed shared read does not poison reconnect", async () => {
  const reads = new SharedReads();
  await assert.rejects(
    reads.read("room", async () => {
      throw Error("offline");
    }),
  );
  assert.equal(await reads.read("room", async () => 3), 3);
});

test("a change arriving during an older read starts one fresh shared read", async () => {
  const reads = new SharedReads();
  let resolve!: (n: number) => void;
  const old = reads.read(
    "room",
    () =>
      new Promise<number>((r) => {
        resolve = r;
      }),
  );
  await Promise.resolve();
  reads.invalidate("change-1");
  const current = reads.read("room", async () => 2);
  reads.invalidate("change-1");
  assert.equal(
    reads.read("room", async () => 3),
    current,
  );
  resolve(1);
  assert.equal(await old, 1);
  assert.equal(await current, 2);
  assert.equal(await reads.read("room", async () => 4), 4);
});
