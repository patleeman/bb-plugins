import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { Store } from "../store";
import { jobSchema, roomSchema, runSchema, type Job } from "../contract";

function setup() {
  const db = new Database(":memory:");
  const store = new Store(db);
  const room = roomSchema.parse({
    id: randomUUID(),
    name: "Activity QA",
    memberIds: [],
    paused: false,
    createdAt: 1,
    updatedAt: 1,
  });
  store.putRoom(room);
  const job = (
    status: Job["status"] = "running",
    roomId: string | null = room.id,
  ) => {
    const j = jobSchema.parse({
      id: randomUUID(),
      botId: "bot_0123456789abcdef",
      conversationKey: "activity-qa",
      threadId: null,
      text: "Work",
      status,
      reply: null,
      error: null,
      createdAt: 1,
      updatedAt: 1,
      startedAt: null,
      roomId,
      runId: null,
    });
    store.enqueue(j);
    return j;
  };
  return { db, store, room, job };
}

test("channel activity covers routing before a response exists and clears on done or stopped", () => {
  const { db, store, room } = setup();
  try {
    const run = runSchema.parse({
      id: "route",
      roomId: room.id,
      status: "queued",
      routing: "pending",
      round: 0,
      remaining: [],
      next: [],
      jobId: null,
      createdAt: 1,
      error: null,
    });
    for (const status of ["queued", "running"] as const) {
      store.putRun({ ...run, status });
      assert.deepEqual(store.activeRoomIds(), [room.id]);
    }
    for (const status of ["done", "stopped"] as const) {
      store.putRun({ ...run, status });
      assert.deepEqual(store.activeRoomIds(), []);
    }
  } finally {
    db.close();
  }
});

test("channel activity spans queue, dispatch, and execution and waits for every response to settle", () => {
  const { db, store, room, job } = setup();
  try {
    const first = job("queued");
    for (const status of ["queued", "dispatching", "running"] as const) {
      store.putJob({ ...first, status });
      assert.deepEqual(store.activeRoomIds(), [room.id]);
    }
    store.putJob({ ...first, status: "done" });
    assert.deepEqual(store.activeRoomIds(), []);
    const second = job();
    store.putJob({ ...first, status: "running" });
    assert.deepEqual(store.activeRoomIds(), [room.id]);
    store.putJob({ ...first, status: "done" });
    assert.deepEqual(store.activeRoomIds(), [room.id]);
    for (const status of ["done", "error", "cancelled"] as const) {
      store.putJob({ ...second, status });
      assert.deepEqual(store.activeRoomIds(), []);
    }
  } finally {
    db.close();
  }
});

test("pending host cancellation remains active until confirmed even when the run has stopped", () => {
  const { db, store, room, job } = setup();
  try {
    const response = job("cancelled");
    store.putJob({ ...response, cancellationPending: true });
    assert.deepEqual(store.activeRoomIds(), [room.id]);
    store.putJob({ ...response, cancellationPending: false });
    assert.deepEqual(store.activeRoomIds(), []);
  } finally {
    db.close();
  }
});

test("activity is channel-scoped and is not lost behind a page of completed history", () => {
  const { db, store, room, job } = setup();
  try {
    job("running", null);
    job("running", randomUUID());
    const other = { ...room, id: randomUUID() };
    store.putRoom(other);
    const active = job();
    for (let i = 0; i < 150; i++) job("done");
    assert.deepEqual(store.activeRoomIds(), [room.id]);
    store.putJob({ ...active, status: "done" });
    assert.deepEqual(store.activeRoomIds(), []);
    job("dispatching", other.id);
    assert.deepEqual(store.activeRoomIds(), [other.id]);
  } finally {
    db.close();
  }
});
