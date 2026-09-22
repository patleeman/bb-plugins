type RecordValue = Record<string, unknown>;

const asRecord = (value: unknown): RecordValue | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : null;

const asText = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null;

export const normalizeActivity = (value: unknown): string | null => {
  const text = asText(value)
    ?.replace(/```[\s\S]*?```/gu, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gmu, "")
    .replace(/[\\`*_~#]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (!text || /^\[PASS\]$/iu.test(text)) return null;
  const limit = 240;
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
};

const first = (...values: unknown[]) => {
  for (const value of values) {
    const text = normalizeActivity(value);
    if (text) return text;
  }
  return null;
};

function workRow(row: RecordValue) {
  const value = asRecord(row.presentation);
  const detail = first(value?.detail);
  const title = first(value?.title);
  const pendingLabel = first(asRecord(value?.label)?.pending);

  const kind = asText(row.workKind);
  switch (kind) {
    case "command":
      return first(
        title && `Running ${title}`,
        row.command && `Running ${String(row.command)}`,
        detail,
        pendingLabel,
      );
    case "search":
      return first(
        row.query && `Searching ${String(row.query)}`,
        detail,
        title && `Searching ${title}`,
        pendingLabel,
      );
    case "web-search":
      return first(
        Array.isArray(row.queries) && row.queries.length
          ? `Searching the web for ${row.queries.join(", ")}`
          : (detail ?? (title && `Searching the web for ${title}`)),
        pendingLabel,
      );
    case "web-fetch":
      return first(
        row.url && `Reading ${String(row.url)}`,
        detail,
        title && `Reading ${title}`,
        pendingLabel,
      );
    case "file-read":
      return first(
        row.path && `Reading ${String(row.path)}`,
        detail,
        title && `Reading ${title}`,
        pendingLabel,
      );
    case "file-change":
      return first(
        asRecord(row.change)?.path &&
          `Editing ${String(asRecord(row.change)?.path)}`,
        detail,
        title && `Editing ${title}`,
        pendingLabel,
      );
    case "image-view":
      return first(
        row.path && `Viewing ${String(row.path)}`,
        detail,
        title && `Viewing ${title}`,
        pendingLabel,
      );
    case "image-generation":
      return first(
        row.prompt && `Generating ${String(row.prompt)}`,
        detail,
        title && `Generating ${title}`,
        pendingLabel,
      );
    case "plan-steps": {
      const steps = Array.isArray(row.steps) ? row.steps : [];
      const active = steps
        .map(asRecord)
        .find((step) => ["active", "pending"].includes(String(step?.status)));
      return first(
        active?.step,
        row.explanation && String(row.explanation),
        detail,
        title,
        pendingLabel,
      );
    }
    case "delegation":
    case "workflow":
      return first(
        row.description && `Working on ${String(row.description)}`,
        detail,
        title && `Working on ${title}`,
        pendingLabel,
      );
    case "tool":
      return first(
        row.toolName && `Using ${String(row.toolName)}`,
        detail,
        title && `Using ${title}`,
        pendingLabel,
      );
    case "approval":
      return first(detail, title, "Waiting for approval", pendingLabel);
    case "question":
      return first(detail, title, "Waiting for an answer", pendingLabel);
    case "extension":
      return first(
        row.extensionKind && `Running ${String(row.extensionKind)}`,
        detail,
        title && `Running ${title}`,
        pendingLabel,
      );
    default:
      return first(detail, title, pendingLabel);
  }
}

function rowSnippet(row: RecordValue) {
  if (row.kind === "conversation")
    return row.role === "assistant" ? normalizeActivity(row.text) : null;
  if (row.kind === "work") return workRow(row);
  if (row.kind === "system" && row.systemKind === "operation")
    return first(row.detail, row.title);
  return null;
}

function collectRows(
  rows: unknown[],
  result: RecordValue[],
  seen: Set<string>,
) {
  for (const value of rows) {
    const row = asRecord(value);
    if (!row) continue;
    const id = asText(row.id);
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    result.push(row);
    if (Array.isArray(row.children)) collectRows(row.children, result, seen);
    if (Array.isArray(row.childRows)) collectRows(row.childRows, result, seen);
  }
}

/**
 * Reduce the latest useful hidden-thread timeline row to one safe UI line.
 * It intentionally ignores active thinking text: that can contain private
 * reasoning, while conversation/work rows are the same user-facing progress
 * the native thread displays.
 */
export function activitySnippetFromTimeline(timeline: unknown): string | null {
  const value = asRecord(timeline);
  const rows: RecordValue[] = [];
  collectRows(Array.isArray(value?.rows) ? value.rows : [], rows, new Set());
  return (
    rows
      .map((row, index) => ({
        row,
        index,
        sequence:
          typeof row.sourceSeqEnd === "number"
            ? row.sourceSeqEnd
            : typeof row.createdAt === "number"
              ? row.createdAt
              : index,
      }))
      .sort((a, b) => a.sequence - b.sequence || a.index - b.index)
      .map(({ row }) => rowSnippet(row))
      .filter((text): text is string => !!text)
      .at(-1) ?? null
  );
}
