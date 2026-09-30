import { describe, expect, it } from "vitest";
import { DEFAULT_COLUMNS } from "../shared";
import { TaskStore } from "./store";
import { memoryStore } from "../test/db";

function clock() {
  let at = 1_000;
  return () => (at += 1);
}

const column = (store: ReturnType<typeof memoryStore>["store"], status: string) =>
  store
    .list()
    .filter((task) => task.status === status)
    .map((task) => task.title);

describe("the task store", () => {
  it("adds tasks to the top of their column", () => {
    const { store } = memoryStore(clock());
    store.create({ title: "First", by: "user" });
    store.create({ title: " Second ", by: "user" });
    store.create({ title: "Reviewing", status: "review", by: "agent" });
    expect(column(store, "todo")).toEqual(["Second", "First"]);
    expect(column(store, "review")).toEqual(["Reviewing"]);
    expect(store.list()[0]).toMatchObject({ id: expect.stringMatching(/^tsk_[0-9a-z]{16}$/), assignee: null, done_at: null });
  });

  it("moves a task to the top of another column, or to a position", () => {
    const { store } = memoryStore(clock());
    const [a, b, c] = ["A", "B", "C"].map((title) => store.create({ title, by: "user" }));
    expect(column(store, "todo")).toEqual(["C", "B", "A"]);
    store.move(a!.id, "in_progress", "user");
    store.move(b!.id, "in_progress", "user");
    expect(column(store, "in_progress")).toEqual(["B", "A"]);
    store.move(c!.id, "in_progress", "user", 1);
    expect(column(store, "in_progress")).toEqual(["B", "C", "A"]);
    store.move(b!.id, "in_progress", "user", 2);
    expect(column(store, "in_progress")).toEqual(["C", "A", "B"]);
    store.move(b!.id, "in_progress", "user", 0);
    expect(column(store, "in_progress")).toEqual(["B", "C", "A"]);
    // Past the end is the bottom.
    store.move(b!.id, "in_progress", "user", 99);
    expect(column(store, "in_progress")).toEqual(["C", "A", "B"]);
  });

  it("spreads a column out when ranks get too close to split", () => {
    const { store } = memoryStore(clock());
    const tasks = ["A", "B", "C"].map((title) => store.create({ title, by: "user" }));
    // Keep dropping C between the top two until the gap runs out.
    for (let round = 0; round < 60; round += 1) {
      const order = column(store, "todo");
      const moving = tasks.find((task) => task.title === order[2])!;
      store.move(moving.id, "todo", "user", 1);
    }
    expect(new Set(column(store, "todo")).size).toBe(3);
    const ranks = store.list().map((task) => task.rank);
    expect(new Set(ranks).size).toBe(3);
  });

  it("stamps done_at when a task is done, keeps it on reorder, and clears it when reopened", () => {
    const { store } = memoryStore(clock());
    const task = store.create({ title: "Ship", by: "user" });
    const done = store.move(task.id, "done", "user");
    expect(done.done_at).not.toBeNull();
    expect(store.move(task.id, "done", "user", 0).done_at).toBe(done.done_at);
    expect(store.move(task.id, "todo", "user").done_at).toBeNull();
  });

  it("updates only the fields given", () => {
    const { store } = memoryStore(clock());
    const task = store.create({ title: "Draft", description: "Notes", due: "2026-10-01", by: "user" });
    const next = store.update(task.id, { title: "Final", due: null }, "agent");
    expect(next).toMatchObject({ title: "Final", description: "Notes", due: null, updated_by: "agent" });
    expect(() => store.update("tsk_missing", { title: "x" }, "user")).toThrow(/not found/);
  });

  it("hides archived tasks unless asked", () => {
    const { store } = memoryStore(clock());
    const task = store.create({ title: "Old", by: "user" });
    store.setArchived(task.id, true);
    expect(store.list()).toHaveLength(0);
    expect(store.list({ includeArchived: true })).toHaveLength(1);
  });

  it("keeps links unique, relabels them, and follows thread titles", () => {
    const { store } = memoryStore(clock());
    const task = store.create({ title: "Launch", by: "user" });
    store.link(task.id, { target: "item", plugin_id: "pages", item_id: "pg_1", label: "Plan", href: "/plugins/pages/pages/pg_1" });
    store.link(task.id, { target: "item", plugin_id: "pages", item_id: "pg_1", label: "Launch plan", href: "/plugins/pages/pages/pg_1" });
    store.link(task.id, { target: "thread", plugin_id: null, item_id: "thr_1", label: "Launch", href: "/threads/thr_1" });
    expect(store.links(task.id).map((link) => link.label)).toEqual(["Launch plan", "Launch"]);
    expect(store.relabelThread("thr_1", "Write the launch post")).toEqual([task.id]);
    expect(store.relabelThread("thr_1", "Write the launch post")).toEqual([]);
    expect(store.unlink(task.id, "item", "pg_1")).toBe(true);
    expect(store.links(task.id).map((link) => link.label)).toEqual(["Write the launch post"]);
  });

  it("lists handoffs newest first and drops links and handoffs with the task", () => {
    const { db, store } = memoryStore(clock());
    const task = store.create({ title: "Launch", by: "user" });
    store.addHandoff(task.id, "thr_1", "Claude");
    store.addHandoff(task.id, "thr_2", "Codex");
    store.setHandoff("thr_1", "archived", "Old");
    expect(store.handoffs(task.id).map((handoff) => handoff.thread_id)).toEqual(["thr_2", "thr_1"]);
    expect(store.latestHandoff(task.id)).toMatchObject({ thread_id: "thr_2", state: "starting" });
    expect(store.openHandoffs().map((handoff) => handoff.thread_id)).toEqual(["thr_2"]);
    store.link(task.id, { target: "thread", plugin_id: null, item_id: "thr_2", label: "Launch", href: null });
    store.delete(task.id);
    expect(db.prepare("SELECT count(*) AS n FROM task_handoffs").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT count(*) AS n FROM task_links").get()).toEqual({ n: 0 });
  });
});


describe("custom board columns", () => {
  const waiting = { id: "col_0123456789abcdef", label: "Waiting" };

  it("preserves existing tasks while renaming, adding and reordering columns across restart", () => {
    const { db, store } = memoryStore(clock());
    const task = store.create({ title: "Existing task", status: "review", by: "agent" });
    const columns = [...DEFAULT_COLUMNS].reverse().map((column) => column.id === "review" ? { ...column, label: "Check" } : column);
    store.saveColumns([waiting, ...columns], 0);
    const restarted = new TaskStore(db);
    expect(restarted.boardConfig()).toEqual({ columns: [waiting, ...columns], revision: 1 });
    expect(restarted.get(task.id)).toEqual(task);
    expect(restarted.statusLabel("review")).toBe("Check");
    expect(restarted.statusOrder(waiting.id)).toBe(0);
    const custom = restarted.create({ title: "Waiting on a reply", status: waiting.id, by: "user" });
    expect(custom.done_at).toBeNull();
    expect(restarted.move(custom.id, "done", "user").done_at).not.toBeNull();
    expect(restarted.move(custom.id, waiting.id, "user").done_at).toBeNull();
  });

  it("blocks removing occupied columns, including archived tasks, then allows an empty column", () => {
    const { store } = memoryStore(clock());
    store.saveColumns([...DEFAULT_COLUMNS, waiting], 0);
    const task = store.create({ title: "Keep me", status: waiting.id, by: "user" });
    store.setArchived(task.id, true);
    expect(() => store.saveColumns(DEFAULT_COLUMNS, 1)).toThrow(/including archived tasks/);
    expect(store.boardConfig().revision).toBe(1);
    expect(store.get(task.id)?.status).toBe(waiting.id);
    store.move(task.id, "todo", "user");
    store.saveColumns(DEFAULT_COLUMNS, 1);
    expect(store.boardConfig().revision).toBe(2);
    expect(() => store.move(task.id, waiting.id, "user")).toThrow(/Column not found/);
    expect(() => store.create({ title: "Invalid", status: waiting.id, by: "user" })).toThrow(/Column not found/);
  });

  it("rejects stale edits and invalid configurations without changing the board", () => {
    const { store } = memoryStore();
    store.saveColumns([...DEFAULT_COLUMNS, waiting], 0);
    const saved = store.boardConfig();
    expect(() => store.saveColumns(DEFAULT_COLUMNS, 0)).toThrow(/changed elsewhere/);
    expect(() => store.saveColumns([waiting], 1)).toThrow(/four workflow/);
    expect(() => store.saveColumns([...DEFAULT_COLUMNS, waiting, waiting], 1)).toThrow(/unique column IDs/);
    expect(() => store.saveColumns([...DEFAULT_COLUMNS, { ...waiting, label: " to DO " }], 1)).toThrow(/different name/);
    expect(() => store.saveColumns([...DEFAULT_COLUMNS, { ...waiting, label: " " }], 1)).toThrow(/1 to 60/);
    expect(() => store.saveColumns([...DEFAULT_COLUMNS, { ...waiting, id: "unknown" }], 1)).toThrow(/unique column IDs/);
    expect(store.boardConfig()).toEqual(saved);
  });
});
