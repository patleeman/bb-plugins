#!/usr/bin/env node

/**
 * Capture the plugin README screenshots from a running BB application.
 *
 * This intentionally uses Chrome's DevTools Protocol against the real BB web
 * client. It is not a mockup generator: each capture is gated on live text
 * from the rendered panel so an empty, broken, or missing surface fails.
 *
 * Usage:
 *   BB_CAPTURE_CDP_PORT=9222 \
 *   BB_CAPTURE_PROJECT_ID=proj_... \
 *   BB_CAPTURE_THREAD_ID=thr_... \
 *   node scripts/capture-plugin-screenshots.mjs
 *
 * If no DevTools endpoint is already available, the script starts a temporary
 * headless Chrome profile. BB itself must already be running at BB_SERVER_URL
 * (the CLI exports this automatically inside a BB environment).
 */

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverUrl = (process.env.BB_SERVER_URL ?? "http://127.0.0.1:38886").replace(/\/$/, "");
const cdpPort = Number(process.env.BB_CAPTURE_CDP_PORT ?? "9222");
const projectId = process.env.BB_CAPTURE_PROJECT_ID ?? process.env.BB_PROJECT_ID;
const threadId = process.env.BB_CAPTURE_THREAD_ID;
const captureOnly = process.env.BB_CAPTURE_ONLY
  ? new Set(process.env.BB_CAPTURE_ONLY.split(",").map((value) => value.trim()).filter(Boolean))
  : null;

if (!projectId || !threadId) {
  throw new Error(
    "Set BB_CAPTURE_PROJECT_ID and BB_CAPTURE_THREAD_ID to a seeded BB thread before capturing.\n" +
      "The thread is used for the message-action and context-menu screenshots.",
  );
}

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

class CdpClient {
  constructor(webSocketUrl) {
    this.webSocketUrl = webSocketUrl;
    this.socket = null;
    this.nextId = 0;
    this.pending = new Map();
  }

  async connect() {
    this.socket = new WebSocket(this.webSocketUrl);
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    });
    await new Promise((resolvePromise, reject) => {
      this.socket.addEventListener("open", resolvePromise, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
  }

  command(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, awaitPromise = false) {
    const result = await this.command("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text ??
          "Runtime evaluation failed",
      );
    }
    if (result.result?.subtype === "error") {
      throw new Error(result.result.description ?? "Runtime evaluation failed");
    }
    return result.result?.value;
  }

  async navigate(path) {
    await this.command("Page.navigate", { url: `${serverUrl}${path}` });
    await sleep(900);
  }

  async waitForText(text, timeoutMs = 15000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const bodyText = await this.evaluate("document.body?.innerText ?? \"\"");
      if (bodyText.includes(text)) return;
      await sleep(250);
    }
    const bodyText = await this.evaluate("document.body?.innerText ?? \"\"");
    throw new Error(`Timed out waiting for ${JSON.stringify(text)}.\n${bodyText.slice(-1200)}`);
  }

  async waitForInputValue(label, expected, timeoutMs = 15000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const value = await this.evaluate(`(() => {
        const field = Array.from(document.querySelectorAll("input, textarea"))
          .find((candidate) => candidate.getAttribute("aria-label") === ${JSON.stringify(label)});
        return field?.value ?? null;
      })()`);
      if (value === expected) return;
      await sleep(250);
    }
    const value = await this.evaluate(`(() => {
      const field = Array.from(document.querySelectorAll("input, textarea"))
        .find((candidate) => candidate.getAttribute("aria-label") === ${JSON.stringify(label)});
      return field?.value ?? null;
    })()`);
    throw new Error(`Timed out waiting for ${JSON.stringify(label)} to equal ${JSON.stringify(expected)}; actual value was ${JSON.stringify(value)}`);
  }

  async waitForAriaButton(label, timeoutMs = 15000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const present = await this.evaluate(`Array.from(document.querySelectorAll("button"))
        .some((candidate) => candidate.getAttribute("aria-label") === ${JSON.stringify(label)})`);
      if (present) return;
      await sleep(250);
    }
    throw new Error(`Timed out waiting for button ${JSON.stringify(label)}`);
  }

  async hasText(text, timeoutMs = 2500) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const bodyText = await this.evaluate("document.body?.innerText ?? \"\"");
      if (bodyText.includes(text)) return true;
      await sleep(250);
    }
    return false;
  }

  async clickButtonText(label) {
    const clicked = await this.evaluate(`(() => {
      const button = Array.from(document.querySelectorAll("button"))
        .find((candidate) => candidate.innerText.trim() === ${JSON.stringify(label)});
      if (!button) throw new Error("Button not found: ${label}");
      button.click();
      return true;
    })()`);
    if (!clicked) throw new Error(`Unable to click ${label}`);
    await sleep(900);
  }

  async drawRectangle() {
    await this.evaluate(`(() => {
      const tool = Array.from(document.querySelectorAll("[aria-label]"))
        .find((candidate) => candidate.getAttribute("aria-label") === "Rectangle");
      if (!tool) throw new Error("Excalidraw Rectangle tool not found");
      tool.click();
      return true;
    })()`);
    await this.command("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: 560,
      y: 300,
      buttons: 0,
    });
    await this.command("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: 560,
      y: 300,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await this.command("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: 960,
      y: 550,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await this.command("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: 960,
      y: 550,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    await sleep(1200);
  }

  async clickSidebarButton(label) {
    const clicked = await this.evaluate(`(() => {
      const button = Array.from(document.querySelectorAll("button"))
        .find((candidate) => candidate.innerText.trim() === ${JSON.stringify(label)});
      if (!button) throw new Error("Sidebar button not found: ${label}");
      button.click();
      return true;
    })()`);
    if (!clicked) throw new Error(`Unable to click sidebar button ${label}`);
    await sleep(900);
  }

  async clickFirstButtonWithAria(label) {
    const clicked = await this.evaluate(`(() => {
      const button = Array.from(document.querySelectorAll("button"))
        .find((candidate) => candidate.getAttribute("aria-label") === ${JSON.stringify(label)});
      if (!button) throw new Error("Button not found: ${label}");
      button.click();
      return true;
    })()`);
    if (!clicked) throw new Error(`Unable to click ${label}`);
    await sleep(900);
  }

  async clickAriaButtonWithPointer(label) {
    const point = await this.evaluate(`(() => {
      const button = Array.from(document.querySelectorAll("button"))
        .find((candidate) => candidate.getAttribute("aria-label") === ${JSON.stringify(label)});
      if (!button) throw new Error("Button not found: ${label}");
      const rect = button.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    await this.command("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
      buttons: 0,
    });
    await this.command("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: point.x,
      y: point.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await this.command("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: point.x,
      y: point.y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    await sleep(300);
  }

  async clickElementWithTextAndPointer(selector, text) {
    const point = await this.evaluate(`(() => {
      const element = Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
        .find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(text)});
      if (!element) throw new Error("Element not found: ${text}");
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    await this.command("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
      buttons: 0,
    });
    await this.command("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: point.x,
      y: point.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await this.command("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: point.x,
      y: point.y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    await sleep(300);
  }

  async openThreadContextMenu() {
    const point = await this.evaluate(`(() => {
      const anchor = Array.from(document.querySelectorAll(
        '[data-sidebar-thread-id], [data-thread-id], [data-session-id], a[href*="/threads/"]',
      )).find((candidate) =>
        candidate.getAttribute("data-sidebar-thread-id") === ${JSON.stringify(threadId)} ||
        candidate.getAttribute("data-thread-id") === ${JSON.stringify(threadId)} ||
        candidate.getAttribute("data-session-id") === ${JSON.stringify(threadId)} ||
        candidate.getAttribute("href")?.includes("/threads/" + ${JSON.stringify(threadId)}),
      );
      if (!anchor) throw new Error("Seed thread row not found in the sidebar");
      const rect = anchor.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    await this.command("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: point.x,
      y: point.y,
      button: "right",
      clickCount: 1,
    });
    await this.command("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: point.x,
      y: point.y,
      button: "right",
      clickCount: 1,
    });
    await sleep(700);
  }

  async capture(outputPath) {
    const screenshot = await this.command("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, Buffer.from(screenshot.data, "base64"));
  }
}

async function findPageTarget() {
  const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
  const target = targets.find((candidate) => candidate.type === "page" && !candidate.url.startsWith("chrome://"));
  if (!target?.webSocketDebuggerUrl) throw new Error("No controllable Chrome page target found");
  return target.webSocketDebuggerUrl;
}

async function pluginRpc(pluginId, method, input) {
  const response = await fetch(`${serverUrl}/api/v1/plugins/${pluginId}/rpc/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error?.message ?? `Plugin RPC failed: ${pluginId}/${method}`);
  }
  return payload.result;
}

async function ensureChrome() {
  try {
    return { webSocketUrl: await findPageTarget(), process: null };
  } catch {
    const chromePath = process.env.BB_CAPTURE_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const profileDir = await mkdtemp(join(tmpdir(), "bb-plugin-capture-"));
    const chromeProcess = spawn(
      chromePath,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        `--user-data-dir=${profileDir}`,
        `--remote-debugging-address=127.0.0.1`,
        `--remote-debugging-port=${cdpPort}`,
        "--window-size=1440,1000",
        "about:blank",
      ],
      { stdio: "ignore" },
    );
    const started = Date.now();
    while (Date.now() - started < 20000) {
      try {
        return { webSocketUrl: await findPageTarget(), process: chromeProcess };
      } catch {
        await sleep(250);
      }
    }
    chromeProcess.kill();
    throw new Error(`Timed out waiting for Chrome DevTools on port ${cdpPort}`);
  }
}

const threadUrl = `/projects/${projectId}/threads/${threadId}`;

const captures = [
  {
    id: "agent-checklists",
    packageDir: "bb-plugin-agent-checklists",
    setup: async (client) => {
      await client.navigate("/");
      await client.clickSidebarButton("Checklists");
      await client.waitForText("Your Checklists");
      await client.waitForText("Software Development Lifecycle");
    },
  },
  {
    id: "agent-plugins",
    packageDir: "bb-plugin-agent-plugins",
    setup: async (client) => {
      await client.navigate("/");
      await client.clickSidebarButton("Agent Plugins");
      await client.waitForText("Installed");
      await client.waitForText("13 skills");
    },
  },
  {
    id: "gtd-sidebar",
    packageDir: "bb-plugin-gtd-sidebar",
    setup: async (client) => {
      await client.navigate("/settings/appearance");
      await client.waitForText("Sidebar");
      const sidebarPoint = await client.evaluate(`(() => {
        const controls = Array.from(document.querySelectorAll("button,[role=combobox]"));
        const sidebarControl = controls.find((candidate) =>
          candidate.textContent?.trim() === "Automatic",
        );
        if (!sidebarControl) throw new Error("Sidebar provider control not found");
        const rect = sidebarControl.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()`);
      await client.command("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: sidebarPoint.x,
        y: sidebarPoint.y,
        button: "left",
        buttons: 1,
        clickCount: 1,
      });
      await client.command("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: sidebarPoint.x,
        y: sidebarPoint.y,
        button: "left",
        buttons: 0,
        clickCount: 1,
      });
      await sleep(300);
      await client.waitForText("GTD Sidebar (inbox)");
      await client.evaluate(`(() => {
        const option = Array.from(document.querySelectorAll("*"))
          .filter((candidate) => candidate.textContent?.trim() === "GTD Sidebar (inbox)")
          .sort((left, right) => left.children.length - right.children.length)[0];
        if (!option) throw new Error("GTD Sidebar provider option not found");
        option.click();
        return true;
      })()`);
      await client.navigate("/");
      await client.waitForText("All projects");
      await client.waitForText("Next Action");
      await client.waitForAriaButton("Sidebar view: Show all projects");
      await client.clickAriaButtonWithPointer("Sidebar view: Show all projects");
      await client.waitForText("Group by project");
      await client.clickElementWithTextAndPointer('[role="menuitemradio"]', "Group by project");
      await sleep(300);
      await client.evaluate(`(() => {
        if (!document.querySelector("[data-project-group]")) {
          throw new Error("Grouped project headings did not render");
        }
        return true;
      })()`);
    },
  },
  {
    id: "cobalt2",
    packageDir: "bb-plugin-cobalt2",
    setup: async (client) => {
      await client.navigate("/settings/appearance");
      await client.waitForText("cobalt2");
      await client.waitForText("Theme");
    },
  },
  {
    id: "comprehension",
    packageDir: "bb-plugin-comprehension",
    setup: async (client) => {
      await client.navigate(threadUrl);
      await client.waitForAriaButton("Explain this");
      await client.clickFirstButtonWithAria("Explain this");
      await client.waitForText("What do you want to make?");
      await client.waitForText("What should it cover?");
    },
  },
  {
    id: "copy-session-id",
    packageDir: "bb-plugin-copy-session-id",
    setup: async (client) => {
      await client.navigate("/");
      await client.openThreadContextMenu();
      await client.waitForText("Copy session ID");
      await client.evaluate(`(() => {
        const item = Array.from(document.querySelectorAll('[role="menuitem"]'))
          .find((candidate) => candidate.textContent?.trim() === "Copy session ID");
        if (!item) throw new Error("Copy session ID menu item not found");
        if (item.querySelector("svg")) {
          throw new Error("Copy session ID menu item still renders an icon");
        }
        return true;
      })()`);
    },
  },
  {
    id: "tok-speed",
    packageDir: "bb-plugin-tok-speed",
    setup: async (client) => {
      await client.navigate(threadUrl);
      const assistantPoint = await client.evaluate(`(() => {
        const row = Array.from(document.querySelectorAll('[data-timeline-row-id]'))
          .find((candidate) => candidate.dataset.timelineRowId?.includes(':assistant:'));
        const group = row?.querySelector('[class~="group/message"]');
        if (!group) throw new Error('Assistant message group not found');
        group.scrollIntoView({ block: 'center', inline: 'nearest' });
        const rect = group.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: Math.max(rect.top + 4, rect.bottom - 8) };
      })()`);
      await client.command("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: assistantPoint.x,
        y: assistantPoint.y,
        buttons: 0,
      });
      await sleep(500);
      const started = Date.now();
      while (Date.now() - started < 15000) {
        const count = await client.evaluate(`Array.from(
          document.querySelectorAll('[data-bb-tok-speed]'),
        ).filter((element) => element.getAttribute('data-bb-tok-speed')?.includes('tok/s')).length`);
        if (count > 0) break;
        await sleep(250);
      }
      await client.evaluate(`(() => {
        const labels = Array.from(document.querySelectorAll('[data-bb-tok-speed]'))
          .filter((element) => element.getAttribute('data-bb-tok-speed')?.includes('tok/s'));
        if (labels.length === 0) {
          throw new Error('Tok Speed did not decorate an assistant message');
        }
        labels[0].scrollIntoView({ block: 'center', inline: 'nearest' });
        return true;
      })()`);
      const point = await client.evaluate(`(() => {
        const label = Array.from(document.querySelectorAll('[data-bb-tok-speed]'))
          .find((element) => element.getAttribute('data-bb-tok-speed')?.includes('tok/s'));
        const group = label?.closest('[class~="group/message"]');
        if (!group) throw new Error('Tok Speed message group not found');
        const rect = group.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: Math.max(rect.top + 4, rect.bottom - 8) };
      })()`);
      await client.command("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: point.x,
        y: point.y,
        buttons: 0,
      });
      await sleep(500);
    },
  },
  {
    id: "council",
    packageDir: "bb-plugin-council",
    setup: async (client) => {
      await client.navigate("/plugins/council/council");
      await client.waitForText("Sessions");
      await client.waitForText("Proposal:");
      await client.waitForText("completed");
    },
  },
  {
    id: "ds4",
    packageDir: "bb-plugin-ds4",
    setup: async (client) => {
      await client.navigate("/settings/plugins/ds4");
      await client.waitForText("Automatic startup");
      await client.waitForText("Model files");
      await client.waitForText("Selected model files");
      await client.waitForText("Download selected model files");
      await client.waitForText("Language model GGUF");
      await client.waitForText("DS4 checkout directory");
      await client.waitForText("Model GGUF path");
      await client.waitForText("Model");
      await client.waitForText("SELECTED MODEL");
      await client.waitForText("MODEL PATH");
      await client.waitForText("VISION ENCODER");
      await client.waitForText("Context tokens (-c)");
      await client.waitForText("Stop after idle (seconds)");
      await client.waitForText("ds4flash.gguf");
      await client.waitForInputValue("Context tokens (-c)", "250000");
      await client.waitForText("metal/cuda/rocm/cpu");
      await client.waitForText("0731 support GGUF");
      if (await client.hasText("BB model selector")) {
        throw new Error("DwarfStar settings still show the removed model selector");
      }
      if (await client.hasText("BB provider filter")) {
        throw new Error("DwarfStar settings still show the removed provider filter");
      }
      for (const removedLabel of [
        "Manage Pi/BB provider config",
        "Manage opencode provider config",
        "Manage Codex CLI provider config",
      ]) {
        if (await client.hasText(removedLabel)) {
          throw new Error(`DwarfStar settings still show removed legacy toggle: ${removedLabel}`);
        }
      }
      await client.evaluate(`(() => {
        const heading = Array.from(document.querySelectorAll("*"))
          .find((candidate) => candidate.textContent?.trim() === "Selected model files");
        if (!heading) throw new Error("DwarfStar model files section not found");
        heading.scrollIntoView({ block: "center", inline: "nearest" });
        return true;
      })()`);
    },
  },
  {
    id: "emoji-react",
    packageDir: "bb-plugin-emoji-react",
    setup: async (client) => {
      await client.navigate("/settings/plugins/emoji-react");
      await client.waitForText("Emoji reactions");
      await client.waitForText("👍 Agree");
      await client.waitForText("Quote the highlighted text");
    },
  },
  {
    id: "excalidraw",
    packageDir: "bb-plugin-excalidraw",
    setup: async (client) => {
      await client.navigate("/plugins/excalidraw/drawings");
      await client.waitForText("Drawings");
      if (await client.hasText("Plugin screenshot staging map")) return;

      // Some BB versions keep the Excalidraw gallery unavailable when a
      // persisted preview cannot be rendered. Use the real editor as the
      // fallback surface: create a temporary drawing through the UI, draw a
      // rectangle through Excalidraw's own canvas, capture it, then remove the
      // temporary fixture in cleanup.
      const before = await pluginRpc("excalidraw", "listDrawings", null);
      await client.clickButtonText("New drawing");
      await client.waitForText("Canvas actions");
      await client.drawRectangle();
      const after = await pluginRpc("excalidraw", "listDrawings", null);
      const beforeIds = new Set(before.drawings.map((drawing) => drawing.id));
      const created = after.drawings.find((drawing) => !beforeIds.has(drawing.id));
      return async () => {
        if (created) await pluginRpc("excalidraw", "deleteDrawing", { id: created.id });
      };
    },
  },
  {
    id: "plannotator",
    packageDir: "bb-plugin-plannotator",
    setup: async (client) => {
      await client.navigate("/settings/plugins/plannotator");
      await client.waitForText("Plannotator binary");
      await client.waitForText("bundled");
    },
  },
  {
    id: "prime-agent",
    packageDir: "bb-plugin-prime-agent",
    setup: async (client) => {
      await client.navigate("/settings/providers");
      await client.waitForText("Prime Agent");
      await client.waitForText("Make default");
    },
  },
  {
    id: "traces",
    packageDir: "bb-plugin-traces",
    setup: async (client) => {
      await client.navigate("/plugins/traces/traces");
      await client.waitForText("Index ready");
      await client.waitForText("matching sessions");
    },
  },
  {
    id: "omp",
    packageDir: "bb-plugin-omp",
    setup: async (client) => {
      await client.navigate("/settings/providers");
      await client.waitForText("OhMyPi");
      await client.evaluate(`(() => {
        const row = Array.from(document.querySelectorAll("div"))
          .find((candidate) => candidate.classList.contains("group/provider-row") &&
            candidate.innerText.includes("OhMyPi"));
        if (!row) throw new Error("OhMyPi provider row not found");
        const makeDefault = Array.from(row.querySelectorAll("button"))
          .find((candidate) => candidate.innerText.trim() === "Make default");
        if (makeDefault) makeDefault.click();
        return true;
      })()`);
      await client.navigate("/");
      await client.clickFirstButtonWithAria("New thread in bb-plugins");
      await client.waitForAriaButton("Provider, model and reasoning (⇧ ⌘ M)");
      await client.clickAriaButtonWithPointer("Provider, model and reasoning (⇧ ⌘ M)");
      await client.waitForText("GLM 5.3 Flashopenrouter");
      await client.evaluate(`(() => {
        const option = Array.from(document.querySelectorAll('[role="option"]'))
          .find((candidate) => candidate.innerText.trim() === "GLM 5.3 Flashopenrouter");
        if (!option) throw new Error("OpenRouter GLM 5.3 Flash model option not found");
        option.click();
        return true;
      })()`);
      await client.waitForText("Reasoning");
      await client.waitForText("Low");
      await client.waitForText("Medium");
      await client.waitForText("High");
      await client.evaluate(`(() => {
        const dialog = document.querySelector('[role="dialog"]');
        const scrollable = Array.from(dialog?.querySelectorAll("*") ?? [])
          .find((candidate) => candidate.scrollHeight > candidate.clientHeight);
        if (!scrollable) throw new Error("OMP model picker list is not scrollable");
        scrollable.scrollTop = scrollable.scrollHeight;
        const visible = (text) => Array.from(dialog.querySelectorAll("button"))
          .some((candidate) => {
            if (candidate.innerText.trim() !== text) return false;
            const rect = candidate.getBoundingClientRect();
            return rect.bottom > 0 && rect.top < window.innerHeight;
          });
        const text = dialog?.innerText ?? "";
        if (!text.includes("GLM 5.3 Flashopenrouter") ||
            !text.includes("Low") || !text.includes("Medium") || !text.includes("High") ||
            !visible("Low") || !visible("Medium") || !visible("High")) {
          throw new Error("OMP reasoning options are not visible in the model picker");
        }
        return true;
      })()`);
    },
  },
  {
    id: "ua-fetch",
    packageDir: "bb-plugin-ua-fetch",
    setup: async (client) => {
      await client.navigate("/settings/plugins/ua-fetch");
      await client.waitForText("Default user agent");
      await client.waitForText("Probe on block");
      await client.waitForText("chrome");
    },
  },
];

const { webSocketUrl, process: chromeProcess } = await ensureChrome();
const client = new CdpClient(webSocketUrl);
await client.connect();
await client.command("Emulation.setDeviceMetricsOverride", {
  width: 1440,
  height: 1000,
  deviceScaleFactor: 1,
  mobile: false,
});

try {
  for (const capture of captures) {
    if (captureOnly && !captureOnly.has(capture.id)) continue;
    process.stdout.write(`Capturing ${capture.id}...\n`);
    const cleanup = await capture.setup(client);
    try {
      const outputPath = join(repoRoot, "packages", capture.packageDir, "assets", "staged-preview.png");
      await client.capture(outputPath);
      process.stdout.write(`  ${outputPath}\n`);
    } finally {
      if (cleanup) await cleanup();
    }
  }
} finally {
  client.socket?.close();
  if (chromeProcess) chromeProcess.kill();
}
