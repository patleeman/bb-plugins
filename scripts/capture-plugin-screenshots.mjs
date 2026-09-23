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

  async openChannelTab(name) {
    await this.evaluate(`document.querySelector('button[aria-label^="Show right panel"]')?.click()`);
    await this.waitForAriaButton(name);
    await this.evaluate(`(() => {
      const tab = [...document.querySelectorAll('[aria-label="Right panel views"] button')]
        .find(button => button.getAttribute('aria-label') === ${JSON.stringify(name)});
      if (!tab) throw new Error('Missing native channel tab');
      tab.click();
    })()`);
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
    id: "bots-ping-highlight",
    showSidebar: true,
    packageDir: "bb-plugin-bot-teams",
    fileName: "channel-ping-highlight.png",
    setup: async (client) => {
      const { items } = await pluginRpc("bot-teams", "attentionList", { status: "open" });
      const request = items.find(item => item.id === "ping-highlight-qa" && item.channelName === "Attention QA");
      if (!request) throw new Error("Seed the open ORBIT-42 @user ping in Attention QA before capture.");
      await client.navigate(`/plugins/bot-teams/channels/${request.roomId}/message/${request.id}`);
      for (const text of ["Needs you", "Should we release on Friday or Monday?", "Acknowledge"]) await client.waitForText(text);
      await client.evaluate(`(() => {
        document.querySelector('button[aria-label^="Hide right panel"]')?.click();
        document.querySelector('button[aria-label^="Toggle sidebar"][aria-expanded="false"]')?.click();
      })()`);
      await sleep(350);
      await client.evaluate(`(() => {
        const m = document.getElementById('channel-message-ping-highlight-qa');
        const bell = document.querySelector('.channel-needs-attention[aria-label="1 request needs your attention"]');
        if (!m?.classList.contains('needs-owner-attention') || !bell?.checkVisibility() || bell.getBoundingClientRect().left < 0) throw new Error('The ping highlight and persistent channel bell must both be visible');
        if (document.querySelector('[aria-label="Channel conversation"] [role="alert"]')) throw new Error('The staged channel must not contain a live error');
      })()`);
    },
  },
  {
    id: "bots-attention-question",
    packageDir: "bb-plugin-bot-teams",
    fileName: "channel-attention-question.png",
    setup: async (client) => {
      await client.navigate(threadUrl);
      for (const text of ["Atlas in #Attention QA", "Which day should we release ORBIT-42?", "Your answer", "Send reply", "Snooze 1 hour"]) await client.waitForText(text);
      await client.evaluate(`(() => {
        if (!document.querySelector('.attention-question textarea')) throw new Error('The real pending channel question must be open');
      })()`);
    },
  },
  {
    id: "bots-attention",
    packageDir: "bb-plugin-bot-teams",
    fileName: "channel-attention.png",
    setup: async (client) => {
      const { items } = await pluginRpc("bot-teams", "attentionList", { status: "open" });
      const request = items.find(item => item.channelName === "Attention QA" && item.message.speaker === "Atlas" && item.message.text.includes("ORBIT-42 release for Thursday"));
      if (!request) throw new Error("Seed Atlas's ORBIT-42 decision request in Attention QA before capture.");
      await client.navigate("/");
      await client.waitForText("For you");
      await client.evaluate(`(() => {
        const entry = Array.from(document.querySelectorAll('nav button')).find(button => button.textContent.includes('For you'));
        if (!entry) throw new Error('For you must be available in the real navigation');
        entry.click();
      })()`);
      for (const text of ["Decision needed", "ORBIT-42 release for Thursday", "Reply in channel", "Acknowledge", "Snooze…"]) await client.waitForText(text);
      await client.evaluate(`(() => {
        if (!document.querySelector('.attention-inbox') || !location.pathname.endsWith('/for-you')) throw new Error('For you inbox must be rendered');
      })()`);
    },
  },
  {
    id: "bots-rail",
    packageDir: "bb-plugin-bot-teams",
    fileName: "channel-rail.png",
    setup: async (client) => {
      const { rooms } = await pluginRpc("bot-teams", "list", null);
      const room = rooms.find(r => process.env.BB_CAPTURE_RAIL_CHANNEL_ID ? r.id === process.env.BB_CAPTURE_RAIL_CHANNEL_ID : r.name === "Rail QA");
      if (!room || room.archived) throw new Error("Seed or restore the Rail QA channel before capturing.");
      if (!room.memberIds.length) throw new Error("Rail QA must have a member bot so the rail's roster is real.");
      const data = await pluginRpc("bot-teams", "room", { id: room.id });
      if (!data.messages.some(m => m.attachments.some(a => a.name === "rail-check.csv")))
        throw new Error("Seed the staged rail-check.csv attachment so the Output section is real.");
      const { automations } = await pluginRpc("bot-teams", "automationList", { channelId: room.id, limit: 50, offset: 0 });
      if (!automations.some(a => a.enabled && a.nextRunAt))
        throw new Error("Seed an enabled Rail QA automation so the countdown is real.");
      const attention = await pluginRpc("bot-teams", "attentionList", { status: "open", channelId: room.id });
      if (!attention.items.some(item => item.reason === "decision"))
        throw new Error(
          "Seed an open decision request in Rail QA before capture:\n" +
            "  bb bots channel notify 'Rail QA' --reason decision --text '...'",
        );
      await client.navigate(`/plugins/bot-teams/channels/${room.id}`);
      await client.waitForText("Rail QA");
      // The rail shares the channel with BB's own right panel; the capture
      // shows the channel at full width, which is when the rail is meant to show.
      await client.evaluate(`document.querySelector('button[aria-label^="Hide right panel"]')?.click()`);
      await sleep(600);
      for (const text of ["Decision needed", "Threads", "Members", "Next automation", "Output", "Usage"])
        await client.waitForText(text);
      await client.evaluate(`(() => {
        const rail = document.querySelector('.channel-rail');
        if (!rail?.checkVisibility()) throw new Error('The channel rail must be visible');
        const sections = [...rail.querySelectorAll('.channel-rail-section')].map(s => s.dataset.section);
        for (const required of ['attention', 'threads', 'members', 'automation', 'output', 'usage'])
          if (!sections.includes(required)) throw new Error('The rail is missing its ' + required + ' section');
        if (!rail.querySelector('[data-section="members"] .channel-rail-state'))
          throw new Error('Member rows must show a live state');
        if (!/\\d+ \\/ \\d+ turns today/.test(rail.querySelector('.channel-rail-usage')?.innerText ?? ''))
          throw new Error('The usage meter must show real turn counts');
        if (/in \\d/.test(rail.querySelector('[data-section="automation"]')?.innerText ?? '') === false)
          throw new Error('The automation countdown must be rendered');
        const main = document.querySelector('.bot-room-main').getBoundingClientRect().width;
        if (main < 480) throw new Error('The rail must not crush the transcript');
      })()`);
    },
  },
  {
    id: "bots-native-tabs",
    packageDir: "bb-plugin-bot-teams",
    fileName: "channel-workbench.png",
    setup: async (client) => {
      const id = process.env.BB_CAPTURE_CHANNEL_ID;
      if (!id) throw new Error("Set BB_CAPTURE_CHANNEL_ID to a Workbench tabs QA fixture.");
      const { room, messages } = await pluginRpc("bot-teams", "room", { id });
      if (room.name !== "Workbench tabs QA" || room.memberIds.length ||
          !messages.some(m => m.saved && m.text.includes("ORBIT-42")))
        throw new Error("Expected the memberless Workbench tabs QA fixture with a saved release decision.");
      await client.navigate(`/plugins/bot-teams/channels/${id}`);
      await client.waitForText("ORBIT-42 release planning.");
      await client.openChannelTab("Channel context");
      await client.waitForInputValue("Brief and instructions", "This is a staged release-planning channel. The release code is ORBIT-42.");
      await client.evaluate(`(() => {
        const tabs = [...document.querySelectorAll('[aria-label="Right panel views"] button[aria-pressed]')];
        if (tabs.length !== 6 || tabs.some(tab => {
          const label = tab.querySelector('.sr-only');
          return !label || label.getBoundingClientRect().width < 10 || getComputedStyle(label).clipPath !== 'none';
        })) throw new Error('Expected six native tabs with readable labels');
        if (document.querySelector('.channel-workbench').closest('.bot-room') || document.querySelector('select[aria-label="Channel detail view"]'))
          throw new Error('Channel details must use native workbench tabs');
      })()`);
    },
  },
  {
    id: "bots-workbench",
    packageDir: "bb-plugin-bot-teams",
    fileName: "channel-workbench.png",
    setup: async (client) => {
      const { rooms } = await pluginRpc("bot-teams", "list", null);
      const room = rooms.find(r => process.env.BB_CAPTURE_CHANNEL_ID ? r.id === process.env.BB_CAPTURE_CHANNEL_ID : r.name === "Workbench QA");
      if (!room || room.archived) throw new Error("Seed or restore Workbench QA before capturing.");
      const data = await pluginRpc("bot-teams", "room", {id:room.id});
      if (!data.messages.some(m => m.botId && m.text === "ORBIT-42 release report is ready." && m.attachments.some(a => a.name === "release-check.csv")))
        throw new Error("A real bot must have published the staged release-check.csv report.");
      const context = await pluginRpc("bot-teams", "channelContext", {id:room.id});
      const initialUsage=await pluginRpc("bot-teams","usage",{id:room.id,kind:"channel"});
      const savedMessage=data.messages.find(m=>m.saved);
      if(!savedMessage)throw new Error("Seed a saved release-planning decision.");
      if (!context.brief.includes("ORBIT-42") || !context.attachmentIds.length) throw new Error("Seed the release brief and retain the real report as a reference.");
      await client.navigate("/");
      await client.waitForText(room.name);
      await client.evaluate(`(() => {
        const button = Array.from(document.querySelectorAll('.channels-sidebar button')).find(b => b.textContent.includes(${JSON.stringify(room.name)}));
        if (!button) throw new Error('Missing staged channel in the sidebar'); button.click();
      })()`);
      await client.waitForText("ORBIT-42 release report is ready.");
      const openPanel = (name) => client.openChannelTab(name);
      const fill = async (label,value) => {
        await client.evaluate(`(() => {
          const e=Array.from(document.querySelectorAll('input,textarea,select')).find(e=>e.getAttribute('aria-label')===${JSON.stringify(label)});
          if(!e) throw new Error('Missing input: '+${JSON.stringify(label)});
          const prototype=e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:e instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(prototype,'value').set.call(e,${JSON.stringify(value)});
          e.dispatchEvent(new Event(e instanceof HTMLSelectElement?'change':'input',{bubbles:true}));
        })()`);
        await sleep(100);
      };
      await openPanel("Channel context");
      await client.waitForInputValue("Brief and instructions",context.brief);
      await client.evaluate(`(() => {
        const panel = document.querySelector('.channel-workbench');
        const tab = document.querySelector('[aria-label="Right panel views"] button[aria-label="Channel context"]');
        if (!tab || tab.getAttribute('aria-pressed') !== 'true' || panel.closest('.bot-room'))
          throw new Error('Channel details must be in the native BB workbench, outside the conversation');
        if (document.querySelector('select[aria-label="Channel detail view"]'))
          throw new Error('The channel dropdown must be replaced with native tabs');
        const tabs = [...document.querySelectorAll('[aria-label="Right panel views"] button[aria-pressed]')];
        if (tabs.length !== 6 || tabs.some(tab => tab.querySelector('.sr-only')?.getBoundingClientRect().width < 10))
          throw new Error('Expected six native channel tabs with visible labels');
      })()`);
      await client.clickButtonText("Version history");
      await client.evaluate(`(() => {
        const versions=document.querySelectorAll('.channel-revisions details');
        if(versions.length<2)throw new Error('Expected retained context history');
        const referenceVersion=Array.from(versions).find(v=>v.querySelector('pre').textContent.includes('attachmentIds'));
        if(!referenceVersion)throw new Error('Reference change missing from comparison');
        referenceVersion.querySelector('summary').click();
      })()`);
      await client.waitForText("Use this version");
      if(process.env.BB_CAPTURE_QA_ACTIONS === "1") {
        const memoryDraft=context.memory.startsWith("Release preview")?"Release context verified in this channel. Keep these facts scoped here.":"Release preview verified in this channel. Keep these facts scoped here.";
        await fill("Channel memory",memoryDraft);
        await client.evaluate(`document.querySelector('button[aria-label^="Hide right panel"]').click()`);
        await openPanel("Channel context");
        await client.waitForInputValue("Channel memory",memoryDraft);
        await client.clickButtonText("Save context");
        await client.waitForText("Saved. Bots receive this context on their next task.");
        await openPanel("Files");
        await client.waitForText("release-check.csv");
        await client.evaluate(`(() => { if(!document.querySelector('.channel-workbench a[href*="attachment"]'))throw new Error('Sent file missing from Files'); })()`);
        await openPanel("Saved decisions");
        await client.waitForText(savedMessage.text.slice(0,80));
        await client.evaluate(`(() => { if(!document.querySelector('.channel-workbench .channel-search-result'))throw new Error('Saved decision missing'); })()`);
        await openPanel("Usage and limits");
        const priorUsage=await pluginRpc("bot-teams","usage",{id:room.id,kind:"channel"});
        await client.waitForInputValue("Turns per hour",String(priorUsage.limits.turnsPerHour));
        await fill("Turns per hour","12");
        await client.clickButtonText("Save limits");
        await client.waitForText("Limits saved.");
        const usage=await pluginRpc("bot-teams","usage",{id:room.id,kind:"channel"});
        if(usage.turns<1 || usage.routingCalls!==initialUsage.routingCalls || usage.limits.turnsPerHour!==12)throw new Error('Single-bot usage or saved limits incorrect');
        await openPanel("Automations");
        const priorSchedules=await pluginRpc("bot-teams","automationList",{channelId:room.id});
        if(!priorSchedules.automations.some(a=>["Weekday release check","Release check at 9:30"].includes(a.name))) {
        await client.clickButtonText("New automation");
        await fill("Automation name","Weekday release check");
        await fill("Automation task","Reply exactly: QA_SCHEDULE_OK. Do not create or modify automations.");
        await fill("Schedule timezone","America/New_York");
        await client.clickButtonText("Create automation");
        await client.waitForText("Weekday release check");
        await client.waitForText("Weekdays at 09:00");
        }
        await client.clickButtonText("Edit");
        await fill("Automation name","Release check at 9:30");
        await fill("Cron expression","30 9 * * 1-5");
        await client.clickButtonText("Save automation");
        await client.waitForText("Release check at 9:30");
        await client.waitForText("Weekdays at 09:30");
        const schedules=await pluginRpc("bot-teams","automationList",{channelId:room.id});
        const saved=schedules.automations.find(a=>a.name==="Release check at 9:30");
        if(!saved || saved.enabled || saved.trigger.cron!=="30 9 * * 1-5")throw new Error('Schedule edit lost its paused state or trigger');
        await client.clickButtonText("Run now");
        await client.waitForText("Run requested.");
        await client.waitForText("QA_SCHEDULE_OK",60000);
        await client.clickButtonText("Run history");
        await client.waitForText("Response: done");
        await client.waitForText("View response");
        await client.clickButtonText("View response");
      }
      await openPanel("Channel context");
      const current=await pluginRpc("bot-teams","channelContext",{id:room.id});
      await client.waitForInputValue("Channel memory",current.memory);
      await client.command("Emulation.setDeviceMetricsOverride", {width:390,height:844,deviceScaleFactor:1,mobile:false});
      await sleep(900);
      if(!await client.evaluate("!!document.querySelector('.channel-workbench')"))await openPanel("Channel context");
      await client.evaluate(`(() => {
        const panel=document.querySelector('.channel-workbench'),r=panel.getBoundingClientRect();
        if(r.left<0 || r.right>innerWidth+1 || panel.scrollWidth>panel.clientWidth+1)throw new Error('Context panel overflows the narrow viewport');
      })()`);
      await client.command("Emulation.setDeviceMetricsOverride", {width:1440,height:1000,deviceScaleFactor:1,mobile:false});
      await sleep(900);
      if(!await client.evaluate("!!document.querySelector('.channel-workbench')"))await openPanel("Channel context");
      await client.waitForInputValue("Brief and instructions",current.brief);
      await client.evaluate(`(() => {
        const panel=document.querySelector('.channel-workbench');
        if(panel.querySelector('[role="alert"]'))throw new Error(panel.querySelector('[role="alert"]').textContent);
        if(!panel.querySelector('input[type="checkbox"]:checked'))throw new Error('Saved reference file must be checked');
      })()`);
    },
  },
  {
    id: "bots-automations",
    packageDir: "bb-plugin-bot-teams",
    fileName: "channel-automations.png",
    setup: async (client) => {
      const { rooms } = await pluginRpc("bot-teams", "list", null);
      const room = rooms.find(r => r.name === "Channel automations QA" && !r.archived);
      if (!room) throw new Error("Seed or restore Channel automations QA before capturing.");
      const { automations } = await pluginRpc("bot-teams", "automationList", { channelId: room.id });
      const brief = automations.find(a => a.name === "Weekday channel brief");
      if (!brief || brief.enabled || brief.trigger.timezone !== "America/New_York")
        throw new Error("Seed the paused Weekday channel brief with its New York timezone.");
      const data = await pluginRpc("bot-teams", "room", { id: room.id });
      if (!data.messages.some(m => m.botId && m.text === "Scheduled channel verified: ORBIT-42."))
        throw new Error("The scheduled bot response must be visible in the live channel.");
      await client.navigate("/");
      await client.waitForText("Channel automations QA");
      await client.evaluate(`(() => {
        const button = Array.from(document.querySelectorAll('.channels-sidebar button'))
          .find(b => b.textContent.includes('Channel automations QA'));
        if (!button) throw new Error('Missing staged channel in the live sidebar');
        button.click();
      })()`);
      await client.waitForText("Scheduled channel verified: ORBIT-42.");
      const openAutomations = async () => {
        await client.openChannelTab("Automations");
        await client.waitForText("Task details");
        await client.waitForText("America/New_York");
      };
      await openAutomations();
      if (process.env.BB_CAPTURE_QA_ACTIONS === "1") {
        const rowAction = async (label) => {
          await client.evaluate(`(() => {
            const row = Array.from(document.querySelectorAll('.channel-automation'))
              .find(e => e.textContent.includes('CLI daily check'));
            const button = row && Array.from(row.querySelectorAll('button'))
              .find(b => b.textContent.trim() === ${JSON.stringify(label)});
            if (!button || button.disabled) throw new Error('Missing enabled automation action');
            button.click();
          })()`);
        };
        await rowAction("Resume");
        await client.waitForText("Automation resumed.");
        await rowAction("Pause");
        await client.waitForText("Paused. Any response already in progress continues.");
        await rowAction("Run now");
        await client.waitForText("Run requested.");
        await rowAction("Delete");
        await client.waitForText("Confirm delete");
        await rowAction("Cancel");
        await rowAction("Delete");
        await rowAction("Confirm delete");
        await client.waitForText("Automation deleted.");
        const live = await pluginRpc("bot-teams", "automationList", { channelId: room.id });
        if (live.automations.some(a => a.name === 'CLI daily check')) throw new Error('Confirmed delete must remove the schedule');
      }
      if (process.env.BB_CAPTURE_QA_ACTIONS === "1" || process.env.BB_CAPTURE_QA_LAYOUT === "1") {
        await client.command("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
        await sleep(900); // BB remounts the channel header at its mobile breakpoint.
        if (!await client.evaluate("!!document.querySelector('.channel-automation-list')")) await openAutomations();
        await client.evaluate(`(() => {
          const dialog = document.querySelector('[role="dialog"]');
          const rect = dialog.getBoundingClientRect();
          if (rect.left < 0 || rect.right > innerWidth || rect.top < 0 || rect.bottom > innerHeight || dialog.scrollWidth > dialog.clientWidth)
            throw new Error('Channel automations must fit on a narrow screen');
        })()`);
        await client.command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
        await sleep(900);
        if (!await client.evaluate("!!document.querySelector('.channel-automation-list')")) await openAutomations();
      }
      await client.evaluate(`(() => {
        const row = Array.from(document.querySelectorAll('.channel-automation'))
          .find(e => e.textContent.includes('Weekday channel brief'));
        if (!row || !row.textContent.includes('Paused') || !row.textContent.includes('Schedule QA'))
          throw new Error('Missing automation identity and paused state: ' + (row?.textContent ?? document.body.innerText.slice(-1500)));
        row.querySelector('summary').click();
      })()`);
      await client.waitForText("Last dispatch:");
      if (process.env.BB_CAPTURE_QA_HISTORY === "1") {
        await client.evaluate(`(() => {
          const row = Array.from(document.querySelectorAll('.channel-automation'))
            .find(e => e.textContent.includes('Weekday channel brief'));
          const button = row && Array.from(row.querySelectorAll('button'))
            .find(b => b.textContent.trim() === 'Run history');
          if (!button) throw new Error('Missing Run history action');
          button.click();
        })()`);
        await client.waitForText("Dispatch history");
        await client.evaluate(`(() => {
          const history = document.querySelector('[aria-label="Run history for Weekday channel brief"]');
          if (!history || !history.textContent.includes('Manual') || !history.textContent.includes('succeeded'))
            throw new Error('The real manual dispatch must appear in channel run history');
        })()`);
      }
    },
  },
  {
    id: "bots-images",
    packageDir: "bb-plugin-bot-teams",
    fileName: "channel-images.png",
    setup: async (client) => {
      const { rooms } = await pluginRpc("bot-teams", "list", null);
      const room = rooms.find(r => r.name === "Chat polish QA" && !r.archived);
      if (!room) throw new Error("Seed or restore the Chat polish QA channel before capturing inline images.");
      const data = await pluginRpc("bot-teams", "room", { id: room.id });
      if (!data.messages.some(m => m.speaker === "You" && m.attachments.some(a => a.type === "localImage"))) throw new Error("Missing a real owner image message.");
      if (!data.messages.some(m => m.botId && m.text === "Here is the inline preview." && m.attachments.some(a => a.type === "localImage"))) throw new Error("Missing a bot-published inline image response.");
      await client.navigate("/");
      await client.waitForText("Chat polish QA");
      await client.evaluate(`(() => {
        const button = Array.from(document.querySelectorAll('.channels-sidebar button')).find(b => b.textContent.trim().startsWith('#Chat polish QA'));
        if (!button) throw new Error('QA channel missing from sidebar');
        button.click();
      })()`);
      await client.waitForAriaButton("Rename channel: Chat polish QA");
      await client.waitForText("Here is the inline preview.");
      await client.evaluate(`(() => {
        const row = Array.from(document.querySelectorAll('.bot-room-message')).find(m => m.textContent.includes('A preview pasted directly'));
        if (!row) throw new Error('Owner paste missing');
        row.scrollIntoView({block:'start'});
      })()`);
      await sleep(600);
      await client.evaluate(`(() => {
        const images = Array.from(document.querySelectorAll('[role="log"] .channel-image img'));
        for (const alt of ['channel-preview.png', 'Four color swatches']) {
          if (!images.some(i => i.alt === alt && i.complete && i.naturalWidth === 720 && i.naturalHeight === 360)) throw new Error('Inline image failed to load: ' + alt);
        }
      })()`);
    },
  },
  {
    id: "bots-behavior",
    packageDir: "bb-plugin-bot-teams",
    fileName: "channel-behavior.png",
    setup: async (client) => {
      await captures.find(c => c.id === "bots-images").setup(client);
      await client.clickAriaButtonWithPointer("Chat mode: Smart");
      for (const text of ["Choose relevant bots", "Only mentions and replies", "All bots can respond"]) await client.waitForText(text);
      await client.evaluate(`(() => {
        const items = Array.from(document.querySelectorAll('[aria-label="Chat mode"] [role="menuitemradio"]'));
        if (!items.some(b => b.textContent.startsWith('Smart') && b.getAttribute('aria-checked') === 'true')) throw new Error('Smart selection missing');
        const trigger = document.querySelector('[aria-label="Chat mode: Smart"]');
        const box = document.querySelector('.group-compose');
        if (!trigger || !box || trigger.getBoundingClientRect().top < box.getBoundingClientRect().bottom) throw new Error('Chat mode must be beneath the composer');
      })()`);
    },
  },
  {
    id: "bots-consultation",
    packageDir: "bb-plugin-bot-teams",
    fileName: "channel-consultation.png",
    setup: async (client) => {
      const { rooms, bots } = await pluginRpc("bot-teams", "list", null);
      const room = rooms.find(r => r.name === "Council" && !r.archived);
      if (!room) throw new Error("Migrate the Council advisors and seed their consultation before capturing.");
      const names = room.memberIds.map(id => bots.find(b => b.id === id)?.name);
      for (const name of ["Grug", "Architect", "Designer"]) if (!names.includes(name)) throw new Error("Missing migrated advisor: " + name);
      await client.navigate("/");
      await client.waitForText("Council");
      await client.evaluate(`(() => {
        const button = Array.from(document.querySelectorAll('.channels-sidebar button')).find(b => b.textContent.trim() === '#Council');
        if (!button) throw new Error('Council channel missing from sidebar');
        button.click();
      })()`);
      await client.waitForAriaButton("Rename channel: Council");
      await client.waitForAriaButton("Channel members: 3 bots");
      await client.waitForText("Biggest structural risk: a growing avatar stack");
      await client.evaluate(`(() => {
        const messages = Array.from(document.querySelectorAll('.bot-room-message'));
        for (const name of ['BB agent', 'Grug', 'Architect', 'Designer']) {
          if (!messages.some(m => m.querySelector('strong')?.textContent === name && m.querySelector('p')?.textContent.length > 30)) throw new Error('Missing live response from ' + name);
        }
        if (!Array.from(document.querySelectorAll("button")).some(b => b.getAttribute("aria-label") === "View BB agent's work")) throw new Error('Agent attribution needs a work link');
        const transcript = document.querySelector('[role="log"]');
        if (transcript) transcript.scrollTop = 0;
      })()`);
      await client.clickFirstButtonWithAria("Channel members: 3 bots");
      await client.waitForText("Add bot");
    },
  },
  {
    id: "bots-creation",
    packageDir: "bb-plugin-bot-teams",
    fileName: "bot-creation-thread.png",
    setup: async (client) => {
      const room = await pluginRpc("bot-teams", "createRoom", {
        name: "Bot creation QA", memberIds: [], requestId: crypto.randomUUID(),
      });
      const channelPath = `/plugins/bot-teams/channels/${room.id}`;
      const setupPath = `/plugins/bot-teams/bots/new/${room.id}`;
      const draftText = "Keep this channel draft @";
      const checkComposer = async (channel = false) => {
        await client.waitForText("Help me create a persistent bot in BB Bot Teams");
        if (channel) await client.waitForText(room.id);
        await client.evaluate(`(() => {
          const editor = document.querySelector('[data-bot-creation-thread] [contenteditable="true"]');
          if (!editor || !editor.textContent.includes('bb bots') || document.activeElement !== editor)
            throw new Error('Expected focused native thread composer with bot setup instructions');
          if (document.querySelector('input[aria-label="Bot name"], textarea[aria-label="Mission"]'))
            throw new Error('Bot creation form is still present');
          if (${channel} !== editor.textContent.includes(${JSON.stringify(room.id)}))
            throw new Error('Wrong channel context in setup draft');
        })()`);
      };
      try {
        await client.navigate("/plugins/bot-teams/bots");
        await client.waitForText("New bot");
        await client.clickButtonText("New bot");
        await checkComposer();
        // Direct links and reload must show the same native composer.
        await client.navigate("/plugins/bot-teams/bots/new");
        await checkComposer();
        await client.navigate(channelPath);
        await client.waitForAriaButton("Channel members: 0 bots");
        await client.evaluate(`(() => {
          const editor = document.querySelector('textarea[aria-label="Message channel"]');
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(editor, ${JSON.stringify(draftText)});
          editor.dispatchEvent(new Event('input', { bubbles: true }));
          editor.focus();
        })()`);
        await client.waitForText("Create new bot…");
        await client.clickButtonText("Create new bot…");
        await checkComposer(true);
        await client.clickFirstButtonWithAria("Back to channel");
        await client.waitForInputValue("Message channel", draftText);
        await client.clickFirstButtonWithAria("Channel members: 0 bots");
        await client.clickButtonText("Add bot");
        await client.waitForText("Create new bot…");
        await client.clickButtonText("Create new bot…");
        await checkComposer(true);
        await client.navigate(setupPath);
        await checkComposer(true);
        await client.command("Emulation.setDeviceMetricsOverride", {
          width: 390, height: 844, deviceScaleFactor: 1, mobile: true,
        });
        await client.evaluate(`(() => {
          const surface = document.querySelector('[data-bot-creation-thread]');
          if (surface.scrollWidth > surface.clientWidth + 1)
            throw new Error('Bot setup overflows on mobile');
        })()`);
        await client.command("Emulation.setDeviceMetricsOverride", {
          width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false,
        });
        await client.navigate("/plugins/bot-teams/bots/new");
        await checkComposer();
        // Exercise a failed submit without dispatching an agent or creating a bot.
        await client.evaluate(`(() => {
          window.botSetupQaFetch = window.fetch;
          window.fetch = async (input, init) => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
            if (url.includes('/rpc/createBotSetupThread')) {
              return new Response(JSON.stringify({ ok: false, error: { message: 'QA host unavailable' } }), {
                status: 503, headers: { 'content-type': 'application/json' },
              });
            }
            return window.botSetupQaFetch(input, init);
          };
        })()`);
        try {
          await client.clickFirstButtonWithAria("Submit (Enter)");
          await client.waitForText("QA host unavailable");
          await client.evaluate(`(() => {
            if (!document.querySelector('[contenteditable="true"]')?.textContent.includes('Help me create') ||
                document.querySelector('button[aria-label="Submit (Enter)"]').disabled)
              throw new Error('Failed setup must preserve the draft and allow retry');
          })()`);
        } finally {
          await client.evaluate('window.fetch = window.botSetupQaFetch');
        }
        await client.navigate("/plugins/bot-teams/bots/new");
        await checkComposer();
        return async () => { await pluginRpc("bot-teams", "deleteRoom", { id: room.id }); };
      } catch (error) {
        await pluginRpc("bot-teams", "deleteRoom", { id: room.id });
        throw error;
      }
    },
  },
  {
    id: "bots-profile",
    packageDir: "bb-plugin-bot-teams",
    fileName: "bot-profile.png",
    setup: async (client) => {
      await captures.find((capture) => capture.id === "bots-collection").setup(client);
      await client.evaluate(`(() => {
        const bot = Array.from(document.querySelectorAll('[data-resource-row] button')).find((button) => button.textContent.startsWith('Atlas'));
        if (!bot) throw new Error('Atlas is missing from the live collection');
        bot.click();
      })()`);
      await client.waitForInputValue("Bot name", "Atlas");
      await client.waitForInputValue("Bot role", "Research and verify the facts");
      await client.waitForText("Mission schedule");
      await client.evaluate(`(() => {
        const form = document.querySelector('form[aria-label="Bot profile"]');
        if (!form || form.querySelectorAll('.bot-config-row').length !== 6 || !form.querySelector('button[aria-label="Mission schedule"]')) {
          throw new Error('Expected native bot settings rows and schedule picker');
        }
        const width = form.closest('.bot-config-content').getBoundingClientRect().width;
        if (width > 1024 || width < 900) throw new Error('Bot configuration must use BB collection width');
        const save = Array.from(form.querySelectorAll('button')).find((button) => button.textContent === 'Save profile');
        if (!save?.disabled) throw new Error('Unchanged profiles must disable Save');
      })()`);
    },
  },
  {
    id: "bots-memory",
    packageDir: "bb-plugin-bot-teams",
    fileName: "bot-memory.png",
    setup: async (client) => {
      await captures.find((capture) => capture.id === "bots-profile").setup(client);
      await client.evaluate(`Array.from(document.querySelectorAll('.bot-tabs button')).find((button) => button.textContent === 'Memory').click()`);
      await client.waitForText("MEMORY.md");
      // Wait for the real file, not just the empty editor shell.
      const started = Date.now();
      while (!(await client.evaluate(`document.querySelector('textarea[aria-label="MEMORY.md"]')?.value.includes('ORBIT-42')`))) {
        if (Date.now() - started > 10000) throw new Error('Atlas memory must contain the staged launch brief');
        await sleep(100);
      }
      await client.evaluate(`(() => {
        const editor = document.querySelector('textarea[aria-label="MEMORY.md"]');
        const height = editor.getBoundingClientRect().height;
        if (height < 208 || height > 400 || editor.disabled) throw new Error('Memory editor must be bounded and editable');
        const save = Array.from(document.querySelectorAll('.bot-document button')).find((button) => button.textContent === 'Save memory');
        if (!save?.disabled || !document.querySelector('.bot-document [data-icon="RotateCcw"]')) throw new Error('Expected native reload and unchanged-save controls');
      })()`);
    },
  },
  {
    id: "bot-teams",
    packageDir: "bb-plugin-bot-teams",
    setup: async (client) => {
      const { bots } = await pluginRpc("bot-teams", "list", null);
      const atlas = bots.find((bot) => bot.name === "Atlas" && bot.description === "Research and verify the facts");
      if (!atlas || !atlas.paused || atlas.intervalMinutes !== 0) {
        throw new Error("Seed the paused Atlas demonstration bot with mission schedules off before capturing Bot Teams.");
      }
      const cleanup = async () => {
        if (atlas.retired) await pluginRpc("bot-teams", "retire", { id: atlas.id, retired: true });
      };
      try {
        if (atlas.retired) await pluginRpc("bot-teams", "retire", { id: atlas.id, retired: false });
        await client.navigate("/plugins/bot-teams/bots");
        await client.waitForText("Bot Teams");
        await client.waitForAriaButton("Filter bots");
        await client.evaluate(`(() => {
          const input = document.querySelector('input[aria-label="Search bots"]');
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Atlas');
          input.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        await client.waitForText("Research and verify the facts");
        await client.evaluate(`(() => {
          const rows = [...document.querySelectorAll('[data-bots-collection] [data-resource-row]')];
          if (location.pathname !== '/plugins/bot-teams/bots' || rows.length !== 1 || !rows[0].textContent.includes('Atlas') || !rows[0].textContent.includes('Research and verify the facts')) {
            throw new Error('The renamed Bot Teams collection must show only the staged Atlas bot.');
          }
        })()`);
        return cleanup;
      } catch (error) {
        await cleanup();
        throw error;
      }
    },
  },
  {
    id: "bots-collection",
    packageDir: "bb-plugin-bot-teams",
    fileName: "bots-collection.png",
    setup: async (client) => {
      await client.navigate("/");
      await client.waitForText("Bot Teams");
      await client.evaluate(`(() => {
        const button = Array.from(document.querySelectorAll('.channels-navigation button'))
          .find((candidate) => candidate.textContent.trim() === 'Bot Teams');
        if (!button) throw new Error('Bots navigation is missing');
        button.click();
      })()`);
      await client.waitForAriaButton("Filter bots");
      await client.waitForAriaButton("Sort bots");
      await client.waitForText("Research and verify the facts");
      await client.evaluate(`(() => {
        const collection = document.querySelector('[data-bots-collection]');
        if (!collection?.querySelector('input[aria-label="Search bots"]') || !collection.querySelector('[data-resource-list-panel]')) {
          throw new Error('Bots collection must use a search toolbar and native bordered list');
        }
        const rows = Array.from(collection.querySelectorAll('[data-resource-row]'));
        for (const name of ['Atlas', 'Quinn', 'Relay', 'Scribe']) {
          if (!rows.some((row) => row.textContent.includes(name) && row.textContent.includes('@'))) {
            throw new Error('Missing staged bot: ' + name);
          }
        }
        const width = collection.firstElementChild.getBoundingClientRect().width;
        if (width > 1024 || width < 900) throw new Error('Bots collection must use BB collection content width');
      })()`);
    },
  },
  {
    id: "bots-forks",
    packageDir: "bb-plugin-bot-teams",
    fileName: "channel-forks.png",
    setup: async (client) => {
      const { rooms } = await pluginRpc("bot-teams", "list", null);
      const room = rooms.find((r) => process.env.BB_CAPTURE_CHANNEL_ID ? r.id === process.env.BB_CAPTURE_CHANNEL_ID : r.name === "Fork QA");
      if (!room) throw new Error("Seed the Fork QA channel with a real primary session and native fork before capturing.");
      const data = await pluginRpc("bot-teams", "room", { id: room.id });
      const fork = data.jobs.find((j) => j.forkSourceThreadId && j.reply === "SIDE_ANSWER");
      if (!fork?.threadId || fork.threadId === fork.forkSourceThreadId)
        throw new Error("Fork QA must contain a completed native fork with SIDE_ANSWER and a distinct source thread.");
      await client.navigate("/");
      await client.waitForText(room.name);
      await client.evaluate(`(() => {
        const button = Array.from(document.querySelectorAll('.channels-sidebar button')).find(b => b.textContent.includes(${JSON.stringify(room.name)}));
        if (!button) throw new Error('Staged channel missing from real sidebar');
        button.click();
      })()`);
      await client.waitForText("SIDE_ANSWER");
      await client.evaluate(`document.querySelector('button[aria-label^="Toggle sidebar"][aria-expanded="true"]')?.click()`);
      await sleep(350);
      await client.evaluate(`(() => {
        const answer = Array.from(document.querySelectorAll('.bot-room-message')).find(m => m.textContent.includes('SIDE_ANSWER') && m.querySelector('.channel-fork-label'));
        if (!answer) throw new Error('Native fork answer must be visibly labeled Fork');
        const trigger = document.querySelector('button[aria-label^="Send mode:"]');
        if (!trigger) throw new Error('Send mode control missing');
      })()`);
      const sendLabel = await client.evaluate(`document.querySelector('button[aria-label^="Send mode:"]').getAttribute('aria-label')`);
      await client.clickAriaButtonWithPointer(sendLabel);
      for (const text of ["Send this message", "Change the task currently running.", "Wait for the current task to finish.", "Ask separately while the current task continues."])
        await client.waitForText(text);
      await client.evaluate(`(() => {
        if (document.querySelectorAll('[role="menuitemradio"]').length !== 4) throw new Error('All four send modes must be rendered');
      })()`);
      return async () => {
        await client.command("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
        await client.command("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
        await client.evaluate(`document.querySelector('button[aria-label^="Toggle sidebar"][aria-expanded="false"]')?.click()`);
        await sleep(350);
      };
    },
  },
  {
    id: "bots",
    packageDir: "bb-plugin-bot-teams",
    setup: async (client) => {
      const { rooms } = await pluginRpc("bot-teams", "list", null);
      const room = rooms.find((candidate) => candidate.name === "Launch room");
      if (!room) throw new Error("Seed the Launch room channel with Atlas and Scribe before capturing.");
      await client.navigate("/");
      await client.waitForText("Launch room");
      await client.evaluate(`(() => {
        const button = Array.from(document.querySelectorAll(".channels-sidebar button"))
          .find((candidate) => candidate.textContent.includes("Launch room"));
        if (!button) throw new Error("Launch room is not visible in the Channels sidebar");
        button.click();
      })()`);
      await client.waitForText("Launch room");
      await client.waitForText("Atlas is ready. I will verify the facts before we decide.");
      await client.waitForText("Scribe is ready. I will record our decisions and next steps.");
      await client.waitForAriaButton("Channel members: 2 bots");
      await client.waitForAriaButton("Attach files");
      await client.waitForAriaButton("Dictate message");
      await client.waitForText("launch-brief.txt");
      await client.waitForText("ORBIT-42");
      await client.evaluate(`(() => {
        const messages = Array.from(document.querySelectorAll(".bot-room-message"));
        for (const [speaker, reply] of [
          ["Atlas", "Atlas is ready. I will verify the facts before we decide."],
          ["Scribe", "Scribe is ready. I will record our decisions and next steps."],
        ]) {
          if (!messages.some((entry) => entry.querySelector("strong")?.textContent === speaker && entry.textContent.includes(reply))) {
            throw new Error("Missing live bot reply from " + speaker);
          }
        }
        for (const speaker of ["Atlas", "Scribe"]) {
          if (!messages.some((entry) => entry.querySelector("strong")?.textContent === speaker && entry.textContent.includes("ORBIT-42"))) {
            throw new Error("Missing attachment answer from " + speaker);
          }
        }
        if (!document.querySelector('[aria-label="Channel conversation"]') || !document.querySelector(".channel-avatar-stack")) {
          throw new Error("Channel transcript and avatar stack must be visible");
        }
        if (!document.querySelector('.channel-reactions button[aria-label="👍: You"]')) {
          throw new Error("Seed a thumbs-up reaction on the live Atlas reply before capturing");
        }
        const header = document.querySelector(".channel-header");
        const title = header.querySelector('button.channel-title');
        const row = header.closest('[data-testid="app-page-header-content-row"]');
        if (!title || title.textContent.trim() !== "#Launch room" || !title.getAttribute("aria-label").includes("Rename channel")) {
          throw new Error("The channel name must be the clickable header title");
        }
        if (title.getBoundingClientRect().left > row.getBoundingClientRect().left + 24 || /Channels/.test(row.innerText)) {
          throw new Error("The channel title must replace Channels at the left of the header");
        }
        const headerBounds = header.getBoundingClientRect();
        const rowBounds = row.getBoundingClientRect();
        if (rowBounds.right - headerBounds.right > 48 || headerBounds.right > rowBounds.right + 1) {
          throw new Error("Channel controls must align at the right of the host header, beside the panel toggle");
        }
        const headerButtons = Array.from(header.querySelectorAll("button"), (button) => button.getBoundingClientRect());
        if (headerButtons.some((bounds, index) => index > 0 && bounds.left < headerButtons[index - 1].right)) {
          throw new Error("Channel title and header controls must not overlap");
        }
        const firstMessage = messages[0];
        const composer = document.querySelector(".group-compose");
        if (header.getBoundingClientRect().height > 40 || firstMessage.getBoundingClientRect().height > 50) {
          throw new Error("Channels should use compact BB spacing in the header and transcript");
        }
        if (!composer.classList.contains("rounded-xl") || !composer.classList.contains("shadow-lift") || Math.abs(composer.getBoundingClientRect().height - 116) > 4 || composer.querySelector("textarea").disabled) {
          throw new Error("Channel composer must match BB's native composer and remain usable");
        }
        if (Array.from(header.querySelectorAll("button")).some((button) => /pause|resume|stop|run/i.test(button.textContent + button.getAttribute("aria-label")))) {
          throw new Error("Channels must not expose run or pause controls");
        }
        if (getComputedStyle(firstMessage.querySelector(".bot-message-actions")).position !== "absolute") {
          throw new Error("Hidden message actions must not reserve transcript space");
        }
        document.querySelector(".channel-avatar-stack").click();
      })()`);
      await client.waitForText("Add bot");
      await client.evaluate(`(() => {
        const menu = document.querySelector('[role="dialog"][aria-label="Channel members"]');
        if (!menu || !menu.textContent.includes("Atlas") || !menu.textContent.includes("Scribe") || /paused/i.test(menu.textContent)) {
          throw new Error("Avatar stack must open the live member list with channel presence");
        }
        if (Array.from(menu.querySelectorAll("button")).at(-1)?.textContent.trim() !== "Add bot") {
          throw new Error("Add bot must be at the bottom of the member menu");
        }
      })()`);
    },
  },
  {
    id: "bots-emoji",
    packageDir: "bb-plugin-bot-teams",
    fileName: "emoji-picker.png",
    setup: async (client) => {
      await captures.find((capture) => capture.id === "bots").setup(client);
      await client.clickFirstButtonWithAria("Channel members: 2 bots");
      await client.clickFirstButtonWithAria("Add reaction");
      await client.waitForAriaButton("Flags");
      await client.evaluate(`(() => {
        const picker = document.querySelector(".channel-emoji-picker");
        for (const category of ["Recently Used", "Smileys & People", "Animals & Nature", "Food & Drink", "Travel & Places", "Activities", "Objects", "Symbols", "Flags"]) {
          if (!Array.from(picker.querySelectorAll('[role="tab"]')).some((tab) => tab.getAttribute("aria-label") === category)) {
            throw new Error("Missing emoji category: " + category);
          }
        }
        if (picker.querySelectorAll('button[aria-label^="Skin tone"]').length !== 6 || picker.querySelector("img")) {
          throw new Error("The full picker must have skin tones and use native emoji");
        }
        picker.querySelector("input").focus();
      })()`);
      await client.command("Input.insertText", { text: "otter" });
      await client.waitForText("1 result found.");
      await client.command("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 });
      await client.command("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 });
      await sleep(150);
      await client.evaluate(`(() => {
        if (document.activeElement?.getAttribute("data-unified") !== "1f9a6") {
          throw new Error("Typing otter and pressing ArrowDown must focus the matching emoji");
        }
      })()`);
      await client.clickFirstButtonWithAria("Clear");
      await client.waitForInputValue("Type to search for an emoji", "");
      await client.command("Input.insertText", { text: "Canada" });
      await client.waitForAriaButton("flag: Canada");
      await client.clickFirstButtonWithAria("Clear");
      await client.waitForInputValue("Type to search for an emoji", "");
    },
  },
  {
    id: "bots-search",
    packageDir: "bb-plugin-bot-teams",
    fileName: "channel-search.png",
    setup: async (client) => {
      await captures.find((capture) => capture.id === "bots").setup(client);
      await client.clickFirstButtonWithAria("Channel members: 2 bots");
      await client.clickFirstButtonWithAria("Search channel");
      await client.waitForText("Search the entire channel, including older messages.");
      await client.evaluate(`document.querySelector('input[aria-label="Search channel history"]').focus()`);
      await client.command("Input.insertText", { text: "ORBIT-42" });
      await client.waitForText("2 messages");
      await client.evaluate(`(() => {
        const results = Array.from(document.querySelectorAll(".channel-search-result"));
        if (results.length !== 2 || !results.every(r => r.textContent.includes("ORBIT-42"))) {
          throw new Error("Channel search must find both staged bot replies");
        }
      })()`);
    },
  },
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
    id: "spool",
    packageDir: "bb-plugin-spool",
    setup: async (client) => {
      await client.navigate("/plugins/spool/spool");
      await client.waitForText("Spool for BB");
      await client.waitForText("MCP included");
      await client.waitForText("Connect it once");
      await client.waitForText("MCP surface");
      await client.waitForText("Trust boundaries");
      await client.waitForText("Audited:");
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
      const outputPath = join(repoRoot, "packages", capture.packageDir, "assets", capture.fileName ?? "staged-preview.png");
      // Use BB's real collapsed-sidebar state so publication does not expose
      // unrelated local projects/threads alongside the deterministic fixtures.
      const privateSidebar = !capture.showSidebar && ((capture.packageDir === "bb-plugin-bot-teams" && capture.id !== "bots-forks") || capture.id === "spool");
      if (privateSidebar) {
        await client.evaluate(`document.querySelector('button[aria-label^="Toggle sidebar"]')?.click()`);
        await sleep(350);
      }
      await client.capture(outputPath);
      if (privateSidebar) {
        await client.evaluate(`document.querySelector('button[aria-label^="Toggle sidebar"]')?.click()`);
        await sleep(350);
      }
      process.stdout.write(`  ${outputPath}\n`);
    } finally {
      if (cleanup) await cleanup();
    }
  }
} finally {
  client.socket?.close();
  if (chromeProcess) chromeProcess.kill();
}
