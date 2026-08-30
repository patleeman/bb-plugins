import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { formatRate, turnIdFromRowId } from "./src/rate";
import "./app.css";

const RATE_ATTR = "data-bb-tok-speed";
const OWNED_TITLE_ATTR = "data-bb-tok-speed-owned-title";
const ORIGINAL_TITLE_ATTR = "data-bb-tok-speed-original-title";
const POLL_MS = 400;
const REFRESH_MS = 2_000;
const MAX_THREAD_IDS = 8;

type TurnRate = {
  threadId: string;
  turnId: string;
  rate: number | null;
  totalOutputTokens: number;
  responseCount: number;
};

type RpcEnvelope =
  | { ok: true; result: { turns: TurnRate[] } }
  | { ok: false; error?: { message?: string } };

function threadIdFromPath(pathname = window.location.pathname): string | null {
  const match = decodeURIComponent(pathname).match(/\/threads\/([^/?#]+)/);
  return match?.[1] ?? null;
}

function threadIdFromRowId(rowId: string): string | null {
  const separator = rowId.indexOf(":");
  return separator > 0 ? rowId.slice(0, separator) : null;
}

function visibleThreadIds(): string[] {
  const ids = new Set<string>();
  const urlId = threadIdFromPath();
  if (urlId) ids.add(urlId);

  document
    .querySelectorAll<HTMLElement>(
      '[data-sidebar-thread-id][aria-current="page"]',
    )
    .forEach((anchor) => {
      const threadId = anchor.dataset.sidebarThreadId;
      if (threadId) ids.add(threadId);
    });

  return Array.from(ids).slice(0, MAX_THREAD_IDS);
}

function isAssistantRow(rowId: string): boolean {
  return rowId.includes(":assistant:");
}

function findMessageGroup(row: HTMLElement): HTMLElement | null {
  if (row.classList.contains("group/message")) return row;
  // An attribute selector treats the slash as ordinary class-token text and
  // avoids walking every descendant during streamed message updates.
  return row.querySelector<HTMLElement>('[class~="group/message"]');
}

function findActionRow(message: HTMLElement): HTMLElement | null {
  const legacyRow = message.querySelector<HTMLElement>(
    ":scope > .mt-1.flex.justify-end",
  );
  if (legacyRow) return legacyRow;

  // Current BB renders a fixed-height hover row containing an absolutely
  // positioned flex group of buttons. Decorate that inner flex group so the
  // metric participates in the same row as the controls instead of occupying
  // the row's fixed-height wrapper.
  const hoverRow = Array.from(message.children)
    .reverse()
    .find(
      (child): child is HTMLElement =>
        child instanceof HTMLElement &&
        child.classList.contains("relative") &&
        child.classList.contains("w-full") &&
        child.querySelector("button[aria-label]") !== null,
    );
  if (!hoverRow) return null;
  return (
    hoverRow.querySelector<HTMLElement>(":scope > [class~='flex']") ??
    hoverRow
  );
}

function rateKey(threadId: string, turnId: string): string {
  return `${threadId}\u0000${turnId}`;
}

function tooltipFor(rate: TurnRate, label: string): string {
  const sampleWord = rate.responseCount === 1 ? "sample" : "samples";
  return `Provider generation: ${label} tok/s across ${rate.responseCount} ${sampleWord} (${rate.totalOutputTokens.toLocaleString("en-US")} output tokens; host tool time excluded)`;
}

function clearDecoration(message: HTMLElement): void {
  const originalTitle = message.getAttribute(ORIGINAL_TITLE_ATTR);
  if (originalTitle !== null) {
    message.setAttribute("title", originalTitle);
  } else if (message.getAttribute(OWNED_TITLE_ATTR) === "true") {
    message.removeAttribute("title");
  }
  message.removeAttribute(RATE_ATTR);
  message.removeAttribute(OWNED_TITLE_ATTR);
  message.removeAttribute(ORIGINAL_TITLE_ATTR);
}

function setDecoration(message: HTMLElement, rate: TurnRate): void {
  const formatted = formatRate(rate.rate);
  if (!formatted || rate.responseCount <= 0) {
    clearDecoration(message);
    return;
  }

  if (!message.hasAttribute(ORIGINAL_TITLE_ATTR)) {
    const existingTitle = message.getAttribute("title");
    if (existingTitle !== null) {
      message.setAttribute(ORIGINAL_TITLE_ATTR, existingTitle);
    }
  }

  const label = `${formatted} tok/s`;
  message.setAttribute(RATE_ATTR, label);
  message.setAttribute(OWNED_TITLE_ATTR, "true");
  message.setAttribute("title", tooltipFor(rate, formatted));
}

function decorate(rates: Map<string, TurnRate>): void {
  const keep = new Set<HTMLElement>();

  document
    .querySelectorAll<HTMLElement>("[data-timeline-row-id]")
    .forEach((row) => {
      const rowId = row.dataset.timelineRowId;
      if (!rowId || !isAssistantRow(rowId)) return;

      const message = findMessageGroup(row);
      if (!message) return;
      const actionRow = findActionRow(message);
      if (!actionRow) {
        clearDecoration(message);
        return;
      }

      const threadId = threadIdFromRowId(rowId);
      const turnId = turnIdFromRowId(rowId);
      const rate =
        threadId && turnId ? rates.get(rateKey(threadId, turnId)) : undefined;
      if (!rate) {
        clearDecoration(actionRow);
        return;
      }

      setDecoration(actionRow, rate);
      if (actionRow.hasAttribute(RATE_ATTR)) keep.add(actionRow);
    });

  document.querySelectorAll<HTMLElement>(`[${RATE_ATTR}]`).forEach((element) => {
    if (!keep.has(element)) clearDecoration(element);
  });
}

function clearDecorations(): void {
  document
    .querySelectorAll<HTMLElement>(`[${RATE_ATTR}]`)
    .forEach(clearDecoration);
}

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "turn-token-speeds",
    mount({ pluginId, signal }) {
      const rates = new Map<string, TurnRate>();
      let inFlight: Promise<void> | null = null;
      let lastRefreshAt = 0;
      let lastThreadKey = "";

      const load = async (threadIds: string[]) => {
        const response = await fetch(
          `/api/v1/plugins/${encodeURIComponent(pluginId)}/rpc/turnRates`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ threadIds }),
            signal,
          },
        );
        const envelope = (await response.json()) as RpcEnvelope;
        if (!response.ok || !envelope.ok || !Array.isArray(envelope.result.turns)) {
          return;
        }

        for (const threadId of threadIds) {
          for (const key of rates.keys()) {
            if (key.startsWith(`${threadId}\u0000`)) rates.delete(key);
          }
        }

        for (const rate of envelope.result.turns) {
          if (
            typeof rate.threadId !== "string" ||
            typeof rate.turnId !== "string" ||
            typeof rate.responseCount !== "number" ||
            typeof rate.totalOutputTokens !== "number" ||
            (rate.rate !== null && typeof rate.rate !== "number")
          ) {
            continue;
          }
          rates.set(rateKey(rate.threadId, rate.turnId), rate);
        }
      };

      const refresh = (force: boolean) => {
        const threadIds = visibleThreadIds();
        if (threadIds.length === 0) {
          if (rates.size > 0) {
            rates.clear();
            clearDecorations();
          }
          lastThreadKey = "";
          return;
        }

        const threadKey = threadIds.slice().sort().join(",");
        const stale =
          force ||
          threadKey !== lastThreadKey ||
          Date.now() - lastRefreshAt >= REFRESH_MS;
        if (!stale) {
          decorate(rates);
          return;
        }
        if (inFlight) {
          decorate(rates);
          return;
        }

        lastThreadKey = threadKey;
        lastRefreshAt = Date.now();
        inFlight = load(threadIds)
          .catch(() => undefined)
          .finally(() => {
            inFlight = null;
            if (!signal.aborted) decorate(rates);
          });
      };

      refresh(true);
      const timer = window.setInterval(() => refresh(false), POLL_MS);
      const observer = new MutationObserver(() => refresh(false));
      observer.observe(document.body, { childList: true, subtree: true });

      return () => {
        window.clearInterval(timer);
        observer.disconnect();
        clearDecorations();
      };
    },
  });
});
