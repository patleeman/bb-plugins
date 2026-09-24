import type { PluginContentScriptRegistration } from "@get-bb/plugin-sdk/app";
import { requestChannelHandoff } from "./channel-handoff";

const rowSelector = "[data-sidebar-thread-id], [data-thread-id]";
const menuSelector = '[role="menu"]';
const itemSelector = '[role="menuitem"]';
const marker = "data-bot-teams-channel-handoff";
const svgNamespace = "http://www.w3.org/2000/svg";

function channelIcon(template: HTMLElement): SVGSVGElement {
  const icon = template.querySelector("svg")?.cloneNode(false) as SVGSVGElement | null ??
    document.createElementNS(svgNamespace, "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("width", "16");
  icon.setAttribute("height", "16");
  icon.setAttribute("fill", "none");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-width", "2");
  icon.setAttribute("stroke-linecap", "round");
  icon.setAttribute("stroke-linejoin", "round");
  icon.setAttribute("aria-hidden", "true");
  for (const pathData of [
    "M21 11.5V17a4 4 0 0 1-4 4H8l-5 2V7a4 4 0 0 1 4-4h7",
    "M18 2v8",
    "M14 6h8",
  ]) {
    const path = document.createElementNS(svgNamespace, "path");
    path.setAttribute("d", pathData);
    icon.append(path);
  }
  return icon;
}

function threadIdAt(target: EventTarget | null): string | null {
  const element = target instanceof Element ? target : null;
  const row = element?.closest<HTMLElement>(rowSelector) ??
    element?.closest<HTMLElement>(".bb-sidebar-hover-actions-row")
      ?.querySelector<HTMLElement>(rowSelector);
  return row?.dataset.sidebarThreadId || row?.dataset.threadId || null;
}

function visibleMenus(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(menuSelector)).filter(
    (menu) =>
      menu.getAttribute("data-state") !== "closed" &&
      menu.getAttribute("aria-hidden") !== "true" &&
      getComputedStyle(menu).display !== "none",
  );
}

function hostThreadMenu(menu: HTMLElement): boolean {
  const labels = Array.from(menu.querySelectorAll<HTMLElement>(itemSelector),
    (item) => item.textContent?.trim());
  return labels.includes("Open in split") && labels.includes("Copy thread link");
}

export const threadChannelMenu: PluginContentScriptRegistration = {
  id: "thread-channel-menu",
  mount({ signal }) {
    if (signal.aborted) return;
    let pending: { threadId: string; existing: Set<HTMLElement> } | null = null;
    let expiry: number | undefined;
    const owned = new Set<HTMLElement>();
    const style = document.createElement("style");
    style.textContent = `
      [${marker}] { cursor: default; }
      [${marker}]:is(:hover, :focus-visible, [data-last-hovered]) {
        background: var(--state-hover, rgba(127, 127, 127, .14)) !important;
        color: var(--foreground, currentColor) !important;
      }
    `;
    document.head.append(style);

    const clearPending = () => {
      pending = null;
      if (expiry !== undefined) window.clearTimeout(expiry);
      expiry = undefined;
    };
    const arm = (target: EventTarget | null) => {
      const threadId = threadIdAt(target);
      if (!threadId) return;
      clearPending();
      pending = { threadId, existing: new Set(visibleMenus()) };
      expiry = window.setTimeout(clearPending, 2_000);
      window.setTimeout(scan, 0);
    };
    const scan = () => {
      const request = pending;
      if (!request) return;
      const menu = visibleMenus().find(
        (candidate) =>
          (!request.existing.has(candidate) || candidate.dataset.state === "open") &&
          hostThreadMenu(candidate),
      );
      if (!menu) return;
      const threadId = request.threadId;
      clearPending();
      const old = menu.querySelector<HTMLElement>(`[${marker}]`);
      if (old) old.remove();
      const items = Array.from(menu.querySelectorAll<HTMLElement>(itemSelector));
      const copyLink = items.find((item) => item.textContent?.trim() === "Copy thread link");
      if (!copyLink) return;
      const item = copyLink.cloneNode(true) as HTMLElement;
      for (const attribute of [
        "id", "aria-describedby", "aria-labelledby", "data-state",
        "data-highlighted", "data-disabled", "data-last-hovered",
        "data-radix-collection-item",
      ]) item.removeAttribute(attribute);
      item.setAttribute(marker, threadId);
      item.setAttribute("role", "menuitem");
      item.setAttribute("tabindex", "-1");
      item.setAttribute("aria-label", "Start channel from thread");
      item.replaceChildren(channelIcon(copyLink), "Start channel from thread");
      const select = (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
        menu.dispatchEvent(new KeyboardEvent("keydown", {
          key: "Escape", bubbles: true, cancelable: true,
        }));
        requestChannelHandoff(threadId);
      };
      item.addEventListener("click", select);
      item.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") select(event);
      });
      item.addEventListener("pointerenter", () => item.focus({ preventScroll: true }));
      copyLink.after(item);
      owned.add(item);
    };
    const onPointerDown = (event: PointerEvent) => arm(event.target);
    const onContextMenu = (event: MouseEvent) => arm(event.target);
    const onKeyDown = (event: KeyboardEvent) => {
      const trigger = event.target instanceof Element &&
        event.target.closest<HTMLElement>('button[aria-label="Thread actions"]');
      if ((event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey) ||
          (trigger && (event.key === "Enter" || event.key === " "))) &&
          threadIdAt(event.target)) arm(event.target);
      const target = event.target instanceof Element ? event.target : null;
      const menu = target?.closest<HTMLElement>(menuSelector);
      if (!menu || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
      const items = Array.from(menu.querySelectorAll<HTMLElement>(itemSelector));
      const current = target?.closest<HTMLElement>(itemSelector);
      const index = current ? items.indexOf(current) : -1;
      const next = items[index + (event.key === "ArrowDown" ? 1 : -1)];
      if (!current?.hasAttribute(marker) && !next?.hasAttribute(marker)) return;
      event.preventDefault();
      event.stopPropagation();
      next?.focus({ preventScroll: true });
    };
    const observer = new MutationObserver(() => {
      for (const item of owned) {
        if (!item.isConnected) owned.delete(item);
      }
      scan();
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true,
      attributeFilter: ["data-state", "aria-hidden", "style"] });
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("contextmenu", onContextMenu, true);
    document.addEventListener("keydown", onKeyDown, true);
    const dispose = () => {
      observer.disconnect();
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("contextmenu", onContextMenu, true);
      document.removeEventListener("keydown", onKeyDown, true);
      signal.removeEventListener("abort", dispose);
      clearPending();
      for (const item of owned) item.remove();
      style.remove();
    };
    signal.addEventListener("abort", dispose, { once: true });
    return dispose;
  },
};
