import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { HUMAN_USER_ID, PLUGIN_RPC_ACTOR } from "./constants";
import { rpcContract } from "./contract";
import { readMarkdown } from "./doc";
import { PagesService } from "./service";
import { MIGRATIONS, PageStore } from "./store";

const services: PagesService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.hub.disposeAll();
});

function setup() {
  const db = new Database(":memory:");
  for (const sql of MIGRATIONS) db.exec(sql);
  const store = new PageStore(db);
  const events: unknown[] = [];
  const bb = { realtime: { publish: (_channel: string, event: unknown) => events.push(event) } };
  const service = new PagesService(bb as never, store, {} as never);
  services.push(service);
  const actor = { key: PLUGIN_RPC_ACTOR, name: "Agent", color: "#000" };
  return { store, service, events, actor };
}

describe("replaceMarkdown", () => {
  it("saves a named version, then replaces the page live", () => {
    const { store, service, events, actor } = setup();
    const page = service.createPage({ projectId: null, parentId: null, title: "Plan", markdown: "# Old\n\nKeep me safe.\n", actor: HUMAN_USER_ID });
    // An open editor's doc is the hub's doc, so it sees the change as it happens.
    const live = service.hub.open(page.id);
    const updates: Uint8Array[] = [];
    live.doc.on("update", (update: Uint8Array) => updates.push(update));

    const meta = service.replaceMarkdown(page.id, "# New\n\n```html\n<b>hi</b>\n```\n", "Before explore", actor);

    expect(updates.length).toBeGreaterThan(0);
    expect(readMarkdown(live.doc)).toBe("# New\n\n```html\n<b>hi</b>\n```\n");
    expect(store.get(page.id)!.markdown).toBe("# New\n\n```html\n<b>hi</b>\n```\n");
    expect(meta).toMatchObject({ id: page.id, updated_by: PLUGIN_RPC_ACTOR });
    expect(events).toContainEqual({ type: "page", pageId: page.id });

    const [snapshot] = store.snapshots(page.id);
    expect(snapshot).toMatchObject({ label: "Before explore", actor: PLUGIN_RPC_ACTOR });
    const saved = new Y.Doc();
    Y.applyUpdate(saved, new Uint8Array(store.snapshotState(snapshot!.id)!.state));
    expect(readMarkdown(saved)).toBe("# Old\n\nKeep me safe.\n");

    // The version restores what was there before.
    service.restore(snapshot!.id, HUMAN_USER_ID);
    expect(readMarkdown(live.doc)).toBe("# Old\n\nKeep me safe.\n");
  });

  it("empties a page for empty Markdown and rejects unknown pages", () => {
    const { service, actor } = setup();
    const page = service.createPage({ projectId: "proj_a", parentId: null, title: "Plan", markdown: "Text\n", actor: HUMAN_USER_ID });
    service.replaceMarkdown(page.id, "", "Cleared", actor);
    expect(readMarkdown(service.hub.open(page.id).doc).trim()).toBe("");
    expect(() => service.replaceMarkdown("pg_000000000000", "x", "v", actor)).toThrow("Page not found.");
  });

  it("validates input like create does", () => {
    const input = rpcContract.replaceMarkdown.input;
    expect(input.safeParse({ id: "pg_0123456789ab", markdown: "# Hi", snapshotName: "v1" }).success).toBe(true);
    expect(input.safeParse({ id: "pg_0123456789ab", markdown: "# Hi", snapshotName: "  " }).success).toBe(false);
    expect(input.safeParse({ id: "pg_0123456789ab", markdown: "x".repeat(200_001), snapshotName: "v1" }).success).toBe(false);
    expect(input.safeParse({ id: "nope", markdown: "", snapshotName: "v1" }).success).toBe(false);
  });
});
