import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { blockTextType } from "./doc";

// Live documents. Each open page has one in-memory Y.Doc; editors connect over
// a plugin WebSocket and speak the standard y-protocols sync + awareness
// messages (the same wire format as y-websocket). Server-side writers (agent
// tools, restores, the CLI) edit the same Y.Doc, so their changes stream to
// every open editor as ordinary Yjs updates.

export const MESSAGE_SYNC = 0;
export const MESSAGE_AWARENESS = 1;

export interface Socket {
  send(data: Uint8Array): void;
  /** Ends the connection; 4404 tells the editor its page is gone. */
  close?(code: number, reason: string): void;
}

/** Who made a change. Sockets are humans; strings are server-side actors. */
export type Origin = Socket | string;

export interface Actor {
  /** Stable key, e.g. `bot:bot_…` or `agent:thr_…`. */
  key: string;
  name: string;
  color: string;
}

export interface LivePage {
  id: string;
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  sockets: Map<Socket, Set<number>>;
  saveTimer: ReturnType<typeof setTimeout> | null;
  unloadTimer: ReturnType<typeof setTimeout> | null;
  /** Actor keys that changed the doc since the last save. */
  dirtyBy: Set<string>;
  presences: Map<string, { awareness: awarenessProtocol.Awareness; clear: ReturnType<typeof setTimeout> }>;
}

export interface HubOptions {
  load(pageId: string): Uint8Array | null;
  save(pageId: string, doc: Y.Doc, actors: string[]): void;
  /** Called once a page is loaded, before any change reaches `changed`. */
  opened?(page: LivePage): void;
  /** Called after every doc change (debounced by the caller as needed). */
  changed?(page: LivePage, origin: unknown): void;
  saveDelayMs?: number;
  unloadDelayMs?: number;
}

const HUMAN = "user";

export class PageHub {
  private readonly pages = new Map<string, LivePage>();

  constructor(private readonly options: HubOptions) {}

  has(pageId: string): boolean {
    return this.pages.has(pageId);
  }

  open(pageId: string): LivePage {
    const existing = this.pages.get(pageId);
    if (existing) return existing;
    const doc = new Y.Doc();
    const state = this.options.load(pageId);
    if (state?.byteLength) Y.applyUpdate(doc, state, "load");
    const awareness = new awarenessProtocol.Awareness(doc);
    awareness.setLocalState(null);
    const page: LivePage = {
      id: pageId,
      doc,
      awareness,
      sockets: new Map(),
      saveTimer: null,
      unloadTimer: null,
      dirtyBy: new Set(),
      presences: new Map(),
    };
    doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === "load") return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      this.broadcast(page, encoding.toUint8Array(encoder), origin);
      page.dirtyBy.add(typeof origin === "string" ? origin : HUMAN);
      this.scheduleSave(page);
      this.options.changed?.(page, origin);
    });
    awareness.on(
      "update",
      ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
        const changed = [...added, ...updated, ...removed];
        const clients = origin && typeof origin === "object" ? page.sockets.get(origin as Socket) : undefined;
        if (clients) {
          for (const id of added) clients.add(id);
          for (const id of removed) clients.delete(id);
        }
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, changed));
        this.broadcast(page, encoding.toUint8Array(encoder), null);
      },
    );
    this.pages.set(pageId, page);
    this.options.opened?.(page);
    this.scheduleUnload(page);
    return page;
  }

  connect(pageId: string, socket: Socket): LivePage {
    const page = this.open(pageId);
    page.sockets.set(socket, new Set());
    if (page.unloadTimer) clearTimeout(page.unloadTimer);
    page.unloadTimer = null;

    const sync = encoding.createEncoder();
    encoding.writeVarUint(sync, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(sync, page.doc);
    socket.send(encoding.toUint8Array(sync));

    const states = [...page.awareness.getStates().keys()];
    if (states.length) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(page.awareness, states));
      socket.send(encoding.toUint8Array(encoder));
    }
    return page;
  }

  receive(pageId: string, socket: Socket, data: Uint8Array): void {
    const page = this.pages.get(pageId);
    if (!page || !page.sockets.has(socket)) return;
    const decoder = decoding.createDecoder(data);
    const type = decoding.readVarUint(decoder);
    if (type === MESSAGE_SYNC) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.readSyncMessage(decoder, encoder, page.doc, socket);
      if (encoding.length(encoder) > 1) socket.send(encoding.toUint8Array(encoder));
    } else if (type === MESSAGE_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(page.awareness, decoding.readVarUint8Array(decoder), socket);
    }
  }

  disconnect(pageId: string, socket: Socket): void {
    const page = this.pages.get(pageId);
    if (!page) return;
    const clients = page.sockets.get(socket);
    page.sockets.delete(socket);
    if (clients?.size) awarenessProtocol.removeAwarenessStates(page.awareness, [...clients], null);
    this.scheduleUnload(page);
  }

  /** Shows an agent's labeled cursor over a block for a few seconds. */
  showPresence(page: LivePage, actor: Actor, blockId: string | null, ttlMs = 8000): void {
    let presence = page.presences.get(actor.key);
    if (!presence) {
      const awareness = new awarenessProtocol.Awareness(new Y.Doc());
      presence = { awareness, clear: setTimeout(() => undefined, 0) };
      page.presences.set(actor.key, presence);
    }
    clearTimeout(presence.clear);
    const target = blockId ? blockTextType(page.doc, blockId) : null;
    const cursor = target
      ? {
          anchor: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(target, 0)),
          head: Y.relativePositionToJSON(
            Y.createRelativePositionFromTypeIndex(target, target instanceof Y.XmlText ? target.length : 0),
          ),
        }
      : null;
    presence.awareness.setLocalState({ user: { name: actor.name, color: actor.color, agent: true }, cursor });
    this.relayPresence(page, presence.awareness);
    const current = presence;
    presence.clear = setTimeout(() => {
      current.awareness.setLocalState(null);
      this.relayPresence(page, current.awareness);
      current.awareness.destroy();
      page.presences.delete(actor.key);
    }, ttlMs);
  }

  private relayPresence(page: LivePage, awareness: awarenessProtocol.Awareness): void {
    const update = awarenessProtocol.encodeAwarenessUpdate(awareness, [awareness.clientID]);
    awarenessProtocol.applyAwarenessUpdate(page.awareness, update, "agent");
  }

  /** Writes a page now (e.g. before snapshotting or on shutdown). */
  flush(page: LivePage): void {
    if (page.saveTimer) clearTimeout(page.saveTimer);
    page.saveTimer = null;
    if (!page.dirtyBy.size) return;
    const actors = [...page.dirtyBy];
    page.dirtyBy.clear();
    this.options.save(page.id, page.doc, actors);
  }

  flushAll(): void {
    for (const page of this.pages.values()) this.flush(page);
  }

  /** Drops a page from memory, closing it for every connected editor. */
  evict(pageId: string): void {
    const page = this.pages.get(pageId);
    if (!page) return;
    this.dispose(page, false);
    for (const socket of page.sockets.keys()) {
      try {
        socket.close?.(4404, "Page deleted");
      } catch {
        // Already closing.
      }
    }
  }

  disposeAll(): void {
    for (const page of [...this.pages.values()]) this.dispose(page, true);
  }

  private dispose(page: LivePage, save: boolean): void {
    if (save) this.flush(page);
    if (page.saveTimer) clearTimeout(page.saveTimer);
    if (page.unloadTimer) clearTimeout(page.unloadTimer);
    for (const presence of page.presences.values()) {
      clearTimeout(presence.clear);
      presence.awareness.destroy();
    }
    page.awareness.destroy();
    page.doc.destroy();
    this.pages.delete(page.id);
  }

  private broadcast(page: LivePage, message: Uint8Array, except: unknown): void {
    for (const socket of page.sockets.keys()) {
      if (socket === except) continue;
      try {
        socket.send(message);
      } catch {
        // A closing socket is cleaned up by its close handler.
      }
    }
  }

  private scheduleSave(page: LivePage): void {
    if (page.saveTimer) return;
    page.saveTimer = setTimeout(() => this.flush(page), this.options.saveDelayMs ?? 1000);
  }

  private scheduleUnload(page: LivePage): void {
    if (page.sockets.size || page.unloadTimer) return;
    page.unloadTimer = setTimeout(() => {
      page.unloadTimer = null;
      if (!page.sockets.size) this.dispose(page, true);
    }, this.options.unloadDelayMs ?? 120_000);
  }
}
