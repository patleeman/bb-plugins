// Reading a thread's timeline: where a message sits (to fork there), and
// which files its turn read and changed (hints for the worker). Rows are
// read defensively: they're the SDK's timeline rows, nested under turns.

type Row = Record<string, unknown>;

const isRow = (value: unknown): value is Row => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | null => (typeof value === "string" && value.length ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** Every row, depth first, with the turn it sits in. */
export function* walk(rows: unknown, turnId: string | null = null): Generator<{ row: Row; turnId: string | null }> {
  if (!Array.isArray(rows)) return;
  for (const row of rows) {
    if (!isRow(row)) continue;
    const own = str(row.turnId) ?? turnId;
    yield { row, turnId: own };
    if (Array.isArray(row.children)) yield* walk(row.children, own);
  }
}

export interface MessageAnchor {
  /** Fork the thread here: the end of the message's source range. */
  sourceSeqEnd: number | null;
  turnId: string | null;
  text: string;
}

export function findMessage(rows: unknown, messageId: string): MessageAnchor | null {
  for (const { row, turnId } of walk(rows)) {
    if (row.kind === "conversation" && row.id === messageId) {
      return { sourceSeqEnd: num(row.sourceSeqEnd), turnId, text: str(row.text) ?? "" };
    }
  }
  return null;
}

export interface TurnHints {
  read: string[];
  changed: string[];
  searched: string[];
}

const MAX_HINTS = 40;

function add(list: string[], value: string | null) {
  if (value && list.length < MAX_HINTS && !list.includes(value)) list.push(value);
}

/** Files the turn read, changed and searched, in the order it touched them. */
export function turnHints(rows: unknown, turnId: string | null): TurnHints {
  const hints: TurnHints = { read: [], changed: [], searched: [] };
  if (!turnId) return hints;
  for (const { row, turnId: rowTurn } of walk(rows)) {
    if (row.kind !== "work" || rowTurn !== turnId) continue;
    switch (row.workKind) {
      case "file-read":
        add(hints.read, str(row.path));
        break;
      case "file-change":
        add(hints.changed, isRow(row.change) ? str(row.change.path) : null);
        break;
      case "search": {
        const query = str(row.query);
        const path = str(row.path);
        add(hints.searched, query ? `${query}${path ? ` in ${path}` : ""}` : path);
        break;
      }
    }
  }
  // A file the turn changed is the more telling hint.
  hints.read = hints.read.filter((path) => !hints.changed.includes(path));
  return hints;
}

/** How many files a worker has read or searched since it started (a fork also holds its source's rows). */
export function countReads(rows: unknown, since = 0): number {
  let count = 0;
  for (const { row } of walk(rows)) {
    if (row.kind !== "work" || (row.workKind !== "file-read" && row.workKind !== "search")) continue;
    if ((num(row.createdAt) ?? 0) >= since) count += 1;
  }
  return count;
}

/** The cursor for the page of rows before these, when there is one. */
export function olderCursor(timeline: unknown): { beforeAnchorId: string; beforeAnchorSeq: string } | null {
  if (!isRow(timeline) || !isRow(timeline.timelinePage) || !isRow(timeline.timelinePage.olderCursor)) return null;
  const anchorId = str(timeline.timelinePage.olderCursor.anchorId);
  const anchorSeq = num(timeline.timelinePage.olderCursor.anchorSeq);
  return anchorId && anchorSeq !== null ? { beforeAnchorId: anchorId, beforeAnchorSeq: String(anchorSeq) } : null;
}
