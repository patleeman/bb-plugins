import { studioSchemas } from "@bb-studio/kit/contract";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { bytes, memoryStore } from "../test/db";
import { htmlText, registerStudio } from "./studio";

function setup() {
  const { store } = memoryStore();
  let handlers: Record<string, (input: unknown) => unknown> = {};
  const bb = { rpc: { register: (_contract: unknown, registered: typeof handlers) => (handlers = registered) } };
  const changed: string[] = [];
  registerStudio(bb as never, studioSchemas(z), { store, changed: (id) => void changed.push(id) });
  const call = async (method: string, input: unknown): Promise<any> => handlers[method]!(input);
  const save = (name: string, text: string, extra: Record<string, unknown> = {}) =>
    store.save({ name, mime: "", bytes: bytes(text), projectId: null, by: "agent", ...extra }).artifact;
  return { store, call, changed, save };
}

describe("the Artifacts Studio provider", () => {
  it("describes artifacts, which Studio can't create", async () => {
    const { call } = setup();
    const info = await call("studio_describe", null);
    expect(info).toMatchObject({ pluginId: "artifacts", panel: "artifacts", kinds: [{ id: "artifact", create: null, canArchive: true }] });
    expect(studioSchemas(z).info.parse(info)).toBeTruthy();
    await expect(call("studio_create", { kind: "artifact", projectId: null, title: "x" })).rejects.toThrow(/saved from threads/);
  });

  it("lists artifacts with type, size and version facts, and a thumbnail for images", async () => {
    const { call, save } = setup();
    const doc = save("notes.md", "---\n# Launch plan\nShip it", { title: "Plan", projectId: "proj_a" });
    const image = save("chart.png", "PNG");
    const { items } = await call("studio_list", null);
    expect(studioSchemas(z).provider.studio_list.output.parse({ items })).toBeTruthy();
    const byId = Object.fromEntries(items.map((item: { id: string }) => [item.id, item]));
    expect(byId[doc.id]).toMatchObject({
      kind: "artifact",
      title: "Plan",
      projectId: "proj_a",
      updatedBy: "agent",
      preview: "Launch plan",
      facts: [
        { id: "type", value: "Markdown", sort: null },
        { id: "size", value: expect.any(String), sort: 25 },
        { id: "versions", value: "1", sort: 1 },
      ],
      thumbnailUrl: null,
      href: `/plugins/artifacts/artifacts/${doc.id}`,
      archived: false,
    });
    expect(byId[image.id]).toMatchObject({
      title: "chart.png",
      facts: expect.arrayContaining([{ id: "type", value: "Image", sort: null }]),
      thumbnailUrl: `/api/v1/plugins/artifacts/http/content?artifact=${image.id}&version=${image.version.id}`,
    });
  });

  it("doesn't preview a first line that repeats the title", async () => {
    const { call, save } = setup();
    const doc = save("notes.md", "# Release notes\n\n- Offline sync", { title: "Release notes" });
    const { items } = await call("studio_list", null);
    expect(items.find((item: { id: string }) => item.id === doc.id).preview).toBe("Offline sync");
  });

  it("finds artifacts by description, file name and text", async () => {
    const { call, save } = setup();
    const a = save("a.md", "the quarterly numbers");
    const b = save("budget.csv", "x,y", { description: "Forecast" });
    save("c.png", "quarterly");
    expect(await call("studio_search", { query: "quarterly" })).toEqual({ ids: [a.id], snippets: { [a.id]: "the quarterly numbers" } });
    expect((await call("studio_search", { query: "forecast" })).ids).toEqual([b.id]);
    expect((await call("studio_search", { query: "budget" })).ids).toEqual([b.id]);
  });

  it("moves, archives and deletes, telling listeners each time", async () => {
    const { store, call, changed, save } = setup();
    const a = save("a.md", "a");
    expect(await call("studio_move", { ids: [a.id, "art_missing"], projectId: "proj_b" })).toMatchObject({
      failed: [{ id: "art_missing" }],
    });
    expect(store.get(a.id)?.project_id).toBe("proj_b");
    await call("studio_archive", { ids: [a.id], archived: true });
    expect(store.get(a.id)?.archived_at).not.toBeNull();
    await call("studio_delete", { ids: [a.id] });
    expect(store.get(a.id)).toBeNull();
    expect(changed).toEqual([a.id, a.id, a.id]);
  });

  it("copies text, and says when there's none", async () => {
    const { call, save } = setup();
    const a = save("a.md", "Alpha", { title: "A" });
    const b = save("b.txt", "Beta", { title: "B" });
    const image = save("c.png", "x");
    expect(await call("studio_action", { action: "copy-text", ids: [a.id] })).toEqual({ message: "Text copied", text: "Alpha" });
    expect(await call("studio_action", { action: "copy-text", ids: [a.id, b.id, image.id] })).toEqual({
      message: "Copied text from 2 artifacts",
      text: "## A\n\nAlpha\n\n## B\n\nBeta",
    });
    expect(await call("studio_action", { action: "copy-text", ids: [image.id] })).toMatchObject({ text: null });
  });
});

describe("htmlText", () => {
  it("keeps the words and drops markup, scripts and styles", () => {
    const html = '<style>ul { color: red }</style><ul><li>Offline sync &amp; plans</li></ul><script>track("ul")</script>';
    expect(htmlText(html).replace(/\s+/g, " ").trim()).toBe("Offline sync & plans");
  });
});
