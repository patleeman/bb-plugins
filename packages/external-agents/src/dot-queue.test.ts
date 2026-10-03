import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { DotQueue } from "./dot-queue.js";

it("serializes independent bridge instances for one room while allowing different rooms", async () => {
  const root = await mkdtemp(join(tmpdir(), "bb-dot-queue-"));
  try {
    const first = new DotQueue(root, 5), second = new DotQueue(root, 5);
    const signal = new AbortController().signal;
    const lease = await first.acquire("shared-room", signal);
    let admitted = false;
    const waiting = second.acquire("shared-room", signal).then(value => { admitted = true; return value; });
    const other = await second.acquire("other-room", signal);
    await delay(20); expect(admitted).toBe(false);
    await lease.release();
    const next = await waiting; expect(admitted).toBe(true);
    // A stale release cannot remove the next owner's lock.
    await lease.release();
    const cancel = new AbortController();
    const third = first.acquire("shared-room", cancel.signal);
    cancel.abort(); await expect(third).rejects.toThrow("cancelled");
    await next.release(); await other.release();
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("cancels a queued request without releasing or interrupting the active owner's turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "bb-dot-queue-"));
  try {
    const queue = new DotQueue(root, 5);
    const first = await queue.acquire("room", new AbortController().signal);
    const cancel = new AbortController(); const waiting = queue.acquire("room", cancel.signal);
    cancel.abort(); await expect(waiting).rejects.toThrow("cancelled");
    const nextCancel = new AbortController(); let admitted = false;
    const next = queue.acquire("room", nextCancel.signal).then(lease => { admitted = true; return lease; });
    await delay(15); expect(admitted).toBe(false);
    await first.release(); await (await next).release();
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("does not unlock an uncertain remote outcome for a later thread", async () => {
  const root = await mkdtemp(join(tmpdir(), "bb-dot-queue-"));
  try {
    const queue = new DotQueue(root, 5);
    const lease = await queue.acquire("room", new AbortController().signal);
    await lease.uncertain();
    await expect(new DotQueue(root).acquire("room", new AbortController().signal)).rejects.toThrow("unconfirmed outcome");
    await lease.release();
  } finally { await rm(root, { recursive: true, force: true }); }
});
