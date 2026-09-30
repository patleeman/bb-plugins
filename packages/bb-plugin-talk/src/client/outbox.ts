// The browser-side outbox: every audio chunk is written to IndexedDB the
// moment MediaRecorder hands it over (every few seconds), and a segment leaves
// the outbox only after the server confirms it is on disk. A reload, crash,
// or network outage therefore loses at most the last few seconds of audio.
//
// Chunks are stored as ArrayBuffers, not Blobs: WebKit web views (the BB
// mobile app) have a history of losing Blobs stored in IndexedDB.

export interface OutboxSegment {
  recordingId: string;
  sessionId: string;
  index: number;
  startedAt: number;
  mimeType: string;
  /** Wall-clock time of the newest chunk. */
  lastPartAt: number;
  durationMs: number | null;
  complete: boolean;
  /**
   * Why the server refused this segment for good. It stays here, so its audio
   * isn't silently lost, but the uploader skips it.
   */
  rejected?: string;
  parts: ArrayBuffer[];
}

export type OutboxKey = Pick<OutboxSegment, "recordingId" | "sessionId" | "index">;

const DB_NAME = "bb-plugin-talk";
const STORE = "segments";

/**
 * Without Web Locks, windows can't tell who is capturing; a segment that has
 * gone this long without a chunk (one comes every 4s) is taken as abandoned.
 */
export const ORPHAN_QUIET_MS = 30_000;

/**
 * Whether an unfinished segment was abandoned. `lockFree` says the capture
 * lock is free or held by this window; either way no other window is
 * recording, so anything not live here is an orphan. When it's unknown (no
 * Web Locks), only a segment that stopped growing counts.
 */
export function isOrphan(
  segment: Pick<OutboxSegment, "complete" | "lastPartAt">,
  live: boolean,
  lockFree: boolean | null,
  now: number,
): boolean {
  if (segment.complete || live || lockFree === false) return false;
  return lockFree === true || now - segment.lastPartAt >= ORPHAN_QUIET_MS;
}

/** Whether the uploader should send this segment now. */
export function isUploadable(segment: Pick<OutboxSegment, "complete" | "rejected">): boolean {
  return segment.complete && !segment.rejected;
}

/**
 * Whether the server refused an upload for good: the input fails the RPC
 * contract (a bad duration, say), so sending it again can't succeed.
 */
export function isPermanentRejection(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "invalid_input" || code === "invalid_json";
}

function keyOf(key: OutboxKey): IDBValidKey {
  return [key.recordingId, key.sessionId, key.index];
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export class Outbox {
  private db: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE, { keyPath: ["recordingId", "sessionId", "index"] });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.db;
  }

  private async tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => Promise<T>): Promise<T> {
    const db = await this.open();
    const transaction = db.transaction(STORE, mode, { durability: "strict" } as IDBTransactionOptions);
    const done = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    });
    const result = await run(transaction.objectStore(STORE));
    await done;
    return result;
  }

  begin(segment: Omit<OutboxSegment, "parts" | "complete" | "durationMs" | "lastPartAt">): Promise<void> {
    return this.tx("readwrite", async (store) => {
      await request(
        store.put({ ...segment, parts: [], complete: false, durationMs: null, lastPartAt: segment.startedAt }),
      );
    });
  }

  appendPart(key: OutboxKey, part: ArrayBuffer): Promise<void> {
    return this.tx("readwrite", async (store) => {
      const current = (await request(store.get(keyOf(key)))) as OutboxSegment | undefined;
      if (!current) return;
      current.parts.push(part);
      current.lastPartAt = Date.now();
      await request(store.put(current));
    });
  }

  complete(key: OutboxKey, durationMs: number): Promise<void> {
    return this.tx("readwrite", async (store) => {
      const current = (await request(store.get(keyOf(key)))) as OutboxSegment | undefined;
      if (!current) return;
      if (current.parts.length === 0) {
        await request(store.delete(keyOf(key)));
        return;
      }
      current.complete = true;
      current.durationMs = durationMs;
      await request(store.put(current));
    });
  }

  /**
   * Seals abandoned segments (see `isOrphan`) — left behind by a page that
   * reloaded or crashed mid-segment. Their chunks still form a playable file.
   */
  sealOrphans(orphaned: (segment: OutboxSegment) => boolean): Promise<number> {
    return this.tx("readwrite", async (store) => {
      const all = (await request(store.getAll())) as OutboxSegment[];
      let sealed = 0;
      for (const segment of all) {
        if (!orphaned(segment)) continue;
        if (segment.parts.length === 0) {
          await request(store.delete(keyOf(segment)));
          continue;
        }
        segment.complete = true;
        // Wall-clock time, so a sleep mid-segment inflates it; the uploader
        // clamps it to what the server accepts.
        segment.durationMs = Math.max(0, segment.lastPartAt - segment.startedAt);
        await request(store.put(segment));
        sealed++;
      }
      return sealed;
    });
  }

  /** Every segment, oldest first. */
  async all(): Promise<OutboxSegment[]> {
    const all = await this.tx("readonly", (store) => request(store.getAll()) as Promise<OutboxSegment[]>);
    return all.sort((a, b) => a.startedAt - b.startedAt || a.index - b.index);
  }

  /** Sets a segment the server refused for good aside (see `rejected`). */
  reject(key: OutboxKey, reason: string): Promise<void> {
    return this.tx("readwrite", async (store) => {
      const current = (await request(store.get(keyOf(key)))) as OutboxSegment | undefined;
      if (!current) return;
      current.rejected = reason;
      await request(store.put(current));
    });
  }

  remove(key: OutboxKey): Promise<void> {
    return this.tx("readwrite", async (store) => {
      await request(store.delete(keyOf(key)));
    });
  }
}

export function toBase64(buffers: readonly ArrayBuffer[]): string {
  let binary = "";
  for (const buffer of buffers) {
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
  }
  return btoa(binary);
}
