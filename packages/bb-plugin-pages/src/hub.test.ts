import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { describe, expect, it, vi } from "vitest";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { applyEdits, readBlocks, readMarkdown, seedMarkdown } from "./doc";
import { MESSAGE_AWARENESS, MESSAGE_SYNC, PageHub } from "./hub";

/** A minimal y-websocket-style client wired straight to the hub. */
function client(hub: PageHub, pageId: string) {
  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);
  const socket = {
    send(data: Uint8Array) {
      const decoder = decoding.createDecoder(data);
      const type = decoding.readVarUint(decoder);
      if (type === MESSAGE_SYNC) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        syncProtocol.readSyncMessage(decoder, encoder, doc, "remote");
        if (encoding.length(encoder) > 1) hub.receive(pageId, socket, encoding.toUint8Array(encoder));
      } else if (type === MESSAGE_AWARENESS) {
        awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(decoder), "remote");
      }
    },
  };
  doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin === "remote") return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    hub.receive(pageId, socket, encoding.toUint8Array(encoder));
  });
  hub.connect(pageId, socket);
  const step1 = encoding.createEncoder();
  encoding.writeVarUint(step1, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(step1, doc);
  hub.receive(pageId, socket, encoding.toUint8Array(step1));
  return { doc, awareness, socket };
}

describe("PageHub", () => {
  it("syncs editors, relays server edits and agent presence, and saves", () => {
    vi.useFakeTimers();
    const seed = new Y.Doc();
    seedMarkdown(seed, "# Hello\n\nWorld\n");
    const saves: string[][] = [];
    const hub = new PageHub({
      load: () => Y.encodeStateAsUpdate(seed),
      save: (_id, _doc, actors) => saves.push(actors),
    });

    const a = client(hub, "pg_1");
    const b = client(hub, "pg_1");
    expect(readMarkdown(a.doc)).toBe("# Hello\n\nWorld\n");

    applyEdits(a.doc, [{ op: "append", markdown: "From A" }], "local");
    expect(readMarkdown(b.doc)).toBe("# Hello\n\nWorld\n\nFrom A\n");

    const page = hub.open("pg_1");
    const [heading] = readBlocks(page.doc);
    applyEdits(page.doc, [{ op: "insert_after", block: heading!.id!, markdown: "From agent" }], "bot:bot_1");
    expect(readMarkdown(a.doc)).toBe("# Hello\n\nFrom agent\n\nWorld\n\nFrom A\n");

    hub.showPresence(page, { key: "bot:bot_1", name: "Ops Bot", color: "#7c3aed" }, heading!.id!);
    const agentState = [...b.awareness.getStates().values()].find((state) => state.user?.name === "Ops Bot");
    expect(agentState?.cursor?.anchor).toBeTruthy();

    vi.advanceTimersByTime(8000);
    expect([...b.awareness.getStates().values()].some((state) => state.user?.name === "Ops Bot")).toBe(false);

    vi.advanceTimersByTime(1000);
    expect(saves.at(-1)?.sort()).toEqual(["bot:bot_1", "user"]);
    vi.useRealTimers();
  });

  it("reports a loaded page before its first change, with the stored content", () => {
    const seed = new Y.Doc();
    seedMarkdown(seed, "Seeded\n");
    const events: string[] = [];
    const hub = new PageHub({
      load: () => Y.encodeStateAsUpdate(seed),
      save: () => {},
      opened: (page) => events.push(`opened:${readMarkdown(page.doc).trim()}`),
      changed: () => events.push("changed"),
    });

    const editor = client(hub, "pg_1");
    applyEdits(editor.doc, [{ op: "append", markdown: "First human edit" }], "local");
    expect(events).toEqual(["opened:Seeded", "changed"]);
  });

  it("closes every editor of a deleted page", () => {
    const hub = new PageHub({ load: () => null, save: () => {} });
    const a = client(hub, "pg_1");
    const closed: number[] = [];
    Object.assign(a.socket, { close: (code: number) => closed.push(code) });
    hub.evict("pg_1");
    expect(closed).toEqual([4404]);
  });
});
