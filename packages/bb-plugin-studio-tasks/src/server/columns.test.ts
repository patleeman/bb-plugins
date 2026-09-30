import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin from "../../server";
import { COLUMNS_UPDATE_TYPE, DEFAULT_COLUMNS } from "../shared";

describe("column RPC and agent contracts", () => {
  it("shares custom columns and labels across board, task, Studio, agent ", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "studio-tasks" });
    await plugin(bb);
    try {
      const columns = [{ id: "col_0123456789abcdef", label: "Waiting" }, ...DEFAULT_COLUMNS.map((column) =>
        column.id === "todo" ? { ...column, label: "Backlog" } : column)];
      await harness.behavior.callRpc("saveColumns", { columns, revision: 0 });
      expect(harness.realtimeSignals).toContainEqual(expect.objectContaining({ payload: { type: COLUMNS_UPDATE_TYPE } }));
      const { task } = await harness.behavior.callRpc("create", { title: "Reply", status: columns[0]!.id }) as any;
      const board = await harness.behavior.callRpc("board", {}) as any;
      expect(board).toMatchObject({ columns, revision: 1, tasks: [{ status: columns[0]!.id, statusLabel: "Waiting" }] });
      const detail = await harness.behavior.callRpc("get", { id: task.id }) as any;
      expect(detail.columns).toEqual(columns);
      const studio = await harness.behavior.callRpc("studio_list", null) as any;
      expect(studio.items[0].facts[0]).toEqual({ id: "status", value: "Waiting", sort: 0 });
      const listed = await harness.behavior.callAgentTool("tasks_list", {});
      expect(JSON.stringify(listed)).toContain("Waiting (col_0123456789abcdef)");
      await harness.behavior.callRpc("move", { id: task.id, status: "todo" });
      expect((await harness.behavior.callRpc("get", { id: task.id }) as any).task.statusLabel).toBe("Backlog");
      await expect(harness.behavior.callRpc("saveColumns", { columns: DEFAULT_COLUMNS, revision: 0 })).rejects.toThrow(/changed elsewhere/);
      await expect(harness.behavior.callRpc("create", { title: "Invalid", status: "col_ffffffffffffffff" })).rejects.toThrow(/Column not found/);
    } finally {
      await harness.lifecycle.dispose();
    }
  });
});
