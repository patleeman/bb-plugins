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
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

  async waitForSelector(selector, timeoutMs = 15000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (await this.evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)) return;
      await sleep(250);
    }
    throw new Error(`Timed out waiting for selector ${JSON.stringify(selector)}`);
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

  async capture(outputPath, clip) {
    const screenshot = await this.command("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
      ...(clip ? { clip: { ...clip, scale: 1 } } : {}),
    });
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, Buffer.from(screenshot.data, "base64"));
  }
}

async function seedPages() {
  const markdown = [
    "> [!TIP] Scribe refreshes this page every weekday morning from the release threads.",
    "",
    "```stats",
    JSON.stringify([
      { label: "Beta teams", value: 42, delta: "+9", trend: "up", caption: "since last week" },
      { label: "Crash-free sessions", value: "99.4%", delta: "+0.6", trend: "up" },
      { label: "Open blockers", value: 3, delta: "-2", trend: "down" },
    ]),
    "```",
    "",
    "```chart",
    JSON.stringify({
      type: "bar",
      title: "Weekly active teams",
      x: "week",
      series: ["web", "desktop"],
      stacked: true,
      data: [
        { week: "Sep 1", web: 18, desktop: 7 },
        { week: "Sep 8", web: 22, desktop: 9 },
        { week: "Sep 15", web: 27, desktop: 12 },
        { week: "Sep 22", web: 29, desktop: 13 },
      ],
    }),
    "```",
    "",
    "## Launch checklist",
    "",
    "- [x] Ship offline sync to beta teams",
    "- [x] Publish the migration guide",
    "- [ ] Localise onboarding for Japanese and German",
    "- [ ] Final go/no-go review",
  ].join("\n");
  const { page } = await pluginRpc("pages", "create", { projectId, parentId: null, title: "Offline mode launch", icon: "🚀", markdown });
  const { page: child } = await pluginRpc("pages", "create", { projectId, parentId: page.id, title: "Rollout risks", icon: "⚠️", markdown: "- Storage quota on older devices" });
  const { page: notes } = await pluginRpc("pages", "create", { projectId, parentId: null, title: "Release notes: October", icon: "📝", markdown: "## Highlights\n\n- Offline sync for every team" });
  const cleanup = async () => {
    for (const id of [child.id, page.id, notes.id]) await pluginRpc("pages", "remove", { id }).catch(() => {});
  };
  return { page, cleanup };
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

/** Run the bb CLI as the owner, not as the thread this script may run inside. */
// Bot Teams captures read the seeded "Launch room" channel: Atlas and Scribe
// with fixed replies from their demo missions (see the Bot Teams README).
const launchRoomReplies = [
  "Ready. I'll keep the decision log for ORBIT-42 and post next steps after each check.",
  "Release check passed: the brief, owner, and Friday window all line up.",
  "Logged: release check passed. Next step: confirm the Friday release window.",
];
let launchRoomId = null;
async function launchRoomThread() {
  const { rooms } = await pluginRpc("bot-teams", "list", null);
  const room = rooms.find((r) => r.name === "Launch room" && !r.archived);
  if (!room?.threadId) throw new Error("Seed the Launch room channel thread with Atlas and Scribe before capturing.");
  const { messages } = await pluginRpc("bot-teams", "room", { id: room.id });
  for (const reply of launchRoomReplies)
    if (!messages.some((m) => m.botId && m.text.startsWith(reply.slice(0, 40))))
      throw new Error(`Launch room is missing the seeded reply: ${reply}`);
  launchRoomId = room.id;
  return room.threadId;
}

async function bbCli(args) {
  const env = { ...process.env };
  delete env.BB_THREAD_ID;
  const child = spawn("bb", args, { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const code = await new Promise((resolvePromise) => child.on("close", resolvePromise));
  if (code !== 0) throw new Error(`bb ${args.join(" ")} failed: ${stderr || stdout}`);
  return stdout;
}

async function talkRpc(method, input) {
  const dir = await mkdtemp(join(tmpdir(), "bb-talk-capture-"));
  const file = join(dir, "input.json");
  await writeFile(file, JSON.stringify(input));
  try {
    return JSON.parse(await bbCli(["plugin", "rpc", "call", "talk", method, "--input-file", file, "--json"]));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runText(command, args) {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const code = await new Promise((resolvePromise) => child.on("close", resolvePromise));
  if (code !== 0) throw new Error(`${command} failed: ${stderr}`);
  return stdout;
}

/**
 * Seeds a finished Talk recording from speech synthesized with macOS `say`,
 * uploaded and transcribed through the live plugin and BB's voice service.
 */
async function seedTalkRecording(projectId) {
  const pieces = [
    ["sync", "Welcome to the weekly product sync. First up, the offline mode beta shipped to forty teams on Monday, and crash reports are down by half since the storage fix."],
    ["sync", "Onboarding is the next focus. New users still stall at the import step, so design will prototype a guided import this sprint."],
    ["sync", "For hiring, Maria is running the loop for two senior engineers, with first interviews scheduled for Thursday."],
    ["after", "Action items. Priya drafts the guided import spec. Sam shares the crash dashboard. Everyone reviews the roadmap before Friday."],
  ];
  const dir = await mkdtemp(join(tmpdir(), "bb-talk-seed-"));
  const recording = await talkRpc("recording_create", { kind: "recording", projectId, threadId: null });
  try {
    await talkRpc("recording_rename", { id: recording.id, title: "Weekly product sync" });
    let startedAt = Date.now() - 20 * 60_000;
    const sessions = { sync: "captureseed1", after: "captureseed2" };
    const indexes = { sync: 0, after: 0 };
    for (const [n, [session, text]] of pieces.entries()) {
      const aiff = join(dir, `${n}.aiff`);
      const m4a = join(dir, `${n}.m4a`);
      await runText("say", ["-o", aiff, text]);
      await runText("afconvert", ["-f", "m4af", "-d", "aac", "-b", "32000", aiff, m4a]);
      const audio = await readFile(m4a);
      const info = await runText("afinfo", [m4a]);
      const durationMs = Math.round(Number(/estimated duration: ([\d.]+)/.exec(info)?.[1] ?? 0) * 1000);
      await talkRpc("segment_put", {
        recordingId: recording.id,
        sessionId: sessions[session],
        index: indexes[session]++,
        startedAt,
        durationMs,
        mimeType: "audio/mp4",
        audioBase64: audio.toString("base64"),
      });
      startedAt += durationMs + (session === "sync" ? 0 : 60_000);
    }
    await talkRpc("recording_state", { id: recording.id, status: "finishing" });
    const started = Date.now();
    for (;;) {
      const current = JSON.parse(await bbCli(["talk", "show", recording.id, "--json"]));
      if (current.status === "done" && current.pendingCount === 0) {
        if (current.failedCount > 0) throw new Error(`Talk could not transcribe ${current.failedCount} seeded pieces.`);
        break;
      }
      if (Date.now() - started > 120_000) throw new Error("Timed out waiting for Talk to transcribe the seeded recording.");
      await sleep(1000);
    }
    return recording.id;
  } catch (error) {
    await talkRpc("recording_delete", { id: recording.id }).catch(() => {});
    throw error;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
        // Talk records from a synthetic microphone without a permission prompt.
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
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
    id: "thread-list-plus",
    packageDir: "bb-plugin-thread-list-plus",
    showSidebar: true,
    setup: async (client) => {
      await client.navigate(`/projects/${projectId}/threads/${threadId}`);
      await client.waitForAriaButton("Threads actions");
      await client.evaluate(`document.querySelector('button[aria-label="Threads actions"]')?.scrollIntoView({ block: 'center' })`);
      await sleep(350);
      await client.clickAriaButtonWithPointer("Threads actions");
      await client.waitForSelector('[role="menuitem"]');
      const hasAction = await client.evaluate(`Array.from(document.querySelectorAll('[role="menuitem"]'))
        .some((item) => item.textContent?.trim() === "New project")`);
      if (!hasAction) throw new Error("The live Threads actions menu is missing New project");
    },
    clip: async (client) => client.evaluate(`(() => {
      const menu = Array.from(document.querySelectorAll('[role="menu"]'))
        .find((item) => item.textContent?.includes('New project'));
      if (!menu) throw new Error('Threads actions menu not found for capture');
      const rect = menu.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    })()`),
  },
  {
    id: "thread-list-plus-dialog",
    packageDir: "bb-plugin-thread-list-plus",
    fileName: "project-dialog.png",
    showSidebar: true,
    setup: async (client) => {
      await captures.find((capture) => capture.id === "thread-list-plus").setup(client);
      await client.clickElementWithTextAndPointer('[role="menuitem"]', "New project");
      await client.waitForSelector('[role="dialog"]');
      const hasTitle = await client.evaluate(`document.querySelector('[role="dialog"]')?.textContent?.includes('New project')`);
      if (!hasTitle) throw new Error('The live New project dialog is missing its title');
      for (const text of ["Folder path", "Browse", "Create project"]) await client.waitForText(text);
    },
    clip: async (client) => client.evaluate(`(() => {
      const dialog = document.querySelector('[role="dialog"]');
      if (!dialog) throw new Error('New project dialog not found for capture');
      const rect = dialog.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    })()`),
  },
  {
    id: "automation-calendar",
    packageDir: "bb-plugin-automation-calendar",
    showSidebar: true,
    setup: async (client) => {
      const today = new Date();
      const currentWeekStart = new Date(today.getFullYear(), today.getMonth(), today.getDate() - today.getDay());
      const fixtureMonth = new Date(currentWeekStart.getFullYear(), currentWeekStart.getMonth(), currentWeekStart.getDate() + 21);
      const monthSlug = `${fixtureMonth.getFullYear()}-${String(fixtureMonth.getMonth() + 1).padStart(2, "0")}`;
      const futureDay = (offset) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset, 10);
      const releaseDayLabel = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" })
        .format(futureDay(7));
      const created = [];
      const cleanup = async () => {
        for (const automationId of created) {
          await pluginRpc("automations", "automations_delete", { projectId, automationId });
        }
      };
      try {
        const fixtures = [
          { name: "Weekly status sweep (demo)", trigger: { triggerType: "schedule", cron: "0 9 * * 1", timezone: "America/New_York" } },
          ...[
            ["Release check (demo)", 7],
            ["Dependency review (demo)", 15],
            ["Monthly report (demo)", 23],
          ].map(([name, offset]) => ({
            name,
            trigger: { triggerType: "once", runAt: futureDay(offset).getTime() },
          })),
        ];
        for (const fixture of fixtures) {
          const automation = await pluginRpc("automations", "automations_create", {
            projectId,
            name: fixture.name,
            enabled: true,
            trigger: fixture.trigger,
            execution: { mode: "script", script: ":", interpreter: "sh" },
            origin: "app",
          });
          created.push(automation.id);
        }
        await pluginRpc("automation-calendar", "calendar_action", { projectId, automationId: created[1], action: "pause" });
        const paused = await pluginRpc("automations", "automations_get", { projectId, automationId: created[1] });
        if (paused?.enabled !== false) throw new Error("Calendar pause action did not update the live automation");
        await pluginRpc("automation-calendar", "calendar_action", { projectId, automationId: created[1], action: "resume" });
        await client.navigate(`/plugins/automation-calendar/calendar`);
        await client.evaluate(`document.querySelector('button[aria-label^="Toggle sidebar"][aria-expanded="true"]')?.click()`);
        await client.evaluate(`document.querySelector('input[aria-label="Search automations"]')?.focus()`);
        await client.command("Input.insertText", { text: "(demo)" });
        for (const text of ["Weekly status sweep (demo)", "Release check (demo)", "Dependency review (demo)", "Monthly report (demo)"]) {
          await client.waitForText(text);
        }
        await client.evaluate(`(() => {
          const calendar = document.querySelector('[aria-label$="automation calendar"]');
          if (!calendar || calendar.querySelectorAll('.ac-cell').length !== 42) throw new Error('Live six-week month grid is missing');
          const now = new Date();
          const sunday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay());
          const firstWeekLabel = 'Show ' + new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(sunday);
          if (calendar.querySelector('.ac-cell .ac-date')?.getAttribute('aria-label') !== firstWeekLabel)
            throw new Error('Current week is not at the top of the month grid');
          const names = [...calendar.querySelectorAll('.ac-event-name')].map(node => node.textContent);
          for (const name of ['Weekly status sweep (demo)', 'Release check (demo)', 'Dependency review (demo)', 'Monthly report (demo)']) {
            if (!names.includes(name)) throw new Error('Missing live calendar event: ' + name);
          }
          if (document.querySelector('.ac-error')) throw new Error('Calendar shows a live RPC error');
        })()`);
        await client.evaluate(`(() => {
          const day = [...document.querySelectorAll('.ac-cell button')].find(button =>
            button.getAttribute('aria-label') === ${JSON.stringify("Show " + releaseDayLabel)});
          if (!day) throw new Error('Month date action is missing');
          day.click();
        })()`);
        await client.waitForSelector('.ac-time-view[data-view="day"] .ac-time-event[title^="Release check"]');
        await client.evaluate(`(() => {
          const view = document.querySelector('.ac-time-view[data-view="day"]');
          if (!view || view.querySelectorAll('.ac-time-heading').length !== 1) throw new Error('Live day view is missing');
        })()`);
        await sleep(200);
        await client.evaluate(`(() => {
          const event = document.querySelector('.ac-time-event[title^="Release check"]');
          if (!event) throw new Error('Release check event button is missing from the day view');
          event.click();
        })()`);
        await client.waitForText("One time");
        await client.evaluate(`(() => {
          const popup = document.querySelector('.ac-popover[role="dialog"]');
          if (!popup || !popup.innerText.includes('Release check') || popup.getBoundingClientRect().width > 420)
            throw new Error('Event popup did not open as a floating overlay');
          if (document.querySelector('.ac-day-agenda, .ac-scrim')) throw new Error('Old event sidebar or drawer still rendered');
        })()`);
        await client.capture(join(repoRoot, "packages", "bb-plugin-automation-calendar", "assets", "event-popup.png"));
        await client.evaluate(`document.querySelector('.ac-popover button[aria-label="Close details"]')?.click()`);
        await client.evaluate(`document.querySelector('.ac-view-switch button[data-view="three"]')?.click()`);
        await client.waitForSelector('.ac-time-view[data-view="three"] .ac-time-event[title^="Release check"]');
        await client.evaluate(`(() => {
          const view = document.querySelector('.ac-time-view[data-view="three"]');
          if (!view || view.querySelectorAll('.ac-time-heading').length !== 3) throw new Error('Live three-day view is missing');
        })()`);
        await client.evaluate(`document.querySelector('.ac-view-switch button[data-view="week"]')?.click()`);
        await client.waitForSelector('.ac-time-view[data-view="week"] .ac-time-event[title^="Release check"]');
        await client.evaluate(`(() => {
          const view = document.querySelector('.ac-time-view[data-view="week"]');
          if (!view || view.querySelectorAll('.ac-time-heading').length !== 7) throw new Error('Live week view is missing');
        })()`);
        await client.capture(join(repoRoot, "packages", "bb-plugin-automation-calendar", "assets", "week-view.png"));
        await client.evaluate(`document.querySelector('.ac-view-switch button[data-view="month"]')?.click()`);
        await client.waitForSelector('.ac-grid[data-view="month"] .ac-event[title^="Release check"]');
        await client.evaluate(`document.querySelector('.ac-grid[data-view="month"] .ac-event[title^="Release check"]').click()`);
        await client.waitForText("One time");
        await client.waitForText("Open in Automations");
        await client.evaluate(`(() => {
          const detail = document.querySelector('.ac-popover[role="dialog"]');
          if (!detail || !detail.innerText.includes('Release check')) throw new Error('Live automation popup did not open');
          const editor = [...detail.querySelectorAll('a')].find(link => link.innerText.includes('Open in Automations'));
          if (!editor) throw new Error('Native editor action is missing');
          editor.click();
        })()`);
        await sleep(350);
        const nativePath = await client.evaluate("location.pathname");
        if (!nativePath.startsWith("/plugins/automations/automations/")) {
          throw new Error(`Open editor did not navigate to native Automations: ${nativePath}`);
        }
        await client.navigate(`/plugins/automation-calendar/calendar/${monthSlug}`);
        await client.evaluate(`document.querySelector('button[aria-label^="Toggle sidebar"][aria-expanded="true"]')?.click()`);
        await client.evaluate(`document.querySelector('input[aria-label="Search automations"]')?.focus()`);
        await client.command("Input.insertText", { text: "(demo)" });
        await client.waitForText("Release check");
        return cleanup;
      } catch (error) {
        await cleanup();
        throw error;
      }
    },
  },
  {
    id: "bots",
    packageDir: "bb-plugin-bot-teams",
    fileName: "staged-preview.png",
    setup: async (client) => {
      const threadId = await launchRoomThread();
      await client.navigate(`/threads/${threadId}`);
      for (const text of launchRoomReplies) await client.waitForText(text);
      await client.waitForAriaButton("Channel members: 2 bots");
      await client.waitForAriaButton("Search channel");
      await client.evaluate(`(() => {
        const picker = [...document.querySelectorAll('[data-app-composer] button')]
          .find((b) => (b.getAttribute('aria-label') ?? '').startsWith('Provider, model and reasoning'));
        if (!picker?.innerText.includes('Directed') || !picker.innerText.includes("Each bot's own"))
          throw new Error("The composer's picker must show the chat mode and bot permissions");
        if (!document.querySelector('a[href^="/plugins/bot-teams/mention/"]'))
          throw new Error("A bot's @mention must render as a link");
        if (document.body.innerText.includes('bots_channel_thread_post'))
          throw new Error('Posting to the channel must stay a collapsed bookkeeping row');
      })()`);
    },
  },
  {
    id: "bots-mentions",
    packageDir: "bb-plugin-bot-teams",
    fileName: "channel-mentions.png",
    setup: async (client) => {
      const threadId = await launchRoomThread();
      await client.navigate(`/threads/${threadId}`);
      await client.waitForText(launchRoomReplies[0]);
      await client.evaluate(`document.querySelector('[data-app-composer] [contenteditable="true"]')?.focus()`);
      // The menu asks providers once a character follows the trigger. A full
      // handle keeps BB's own thread and project suggestions, which are the
      // owner's real data, out of a published screenshot.
      await client.command("Input.insertText", { text: "@atlas" });
      await client.waitForText("Bots");
      await client.evaluate(`(() => {
        const menu = document.body.innerText;
        for (const text of ['Atlas', '@atlas'])
          if (!menu.includes(text)) throw new Error('The @ menu is missing ' + text);
        const headings = [...document.querySelectorAll('[role="listbox"] *, [data-mention-menu] *')]
          .map((e) => e.childElementCount === 0 ? e.textContent.trim() : '');
        if (headings.includes('Threads') || headings.includes('Projects'))
          throw new Error('The @ menu shows real threads or projects; narrow the query');
      })()`);
      return async () => {
        await client.command("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape" });
        await client.evaluate(`(() => {
          const editor = document.querySelector('[data-app-composer] [contenteditable="true"]');
          editor?.focus(); document.execCommand('selectAll'); document.execCommand('delete');
        })()`);
      };
    },
  },
  {
    id: "bots-search",
    packageDir: "bb-plugin-bot-teams",
    fileName: "channel-search.png",
    setup: async (client) => {
      const threadId = await launchRoomThread();
      await client.navigate(`/threads/${threadId}`);
      await client.waitForText(launchRoomReplies[0]);
      await client.evaluate(`document.querySelector('button[aria-label="Search channel"]').click()`);
      await client.waitForSelector('input[aria-label="Search channel history"]');
      await client.evaluate(`document.querySelector('input[aria-label="Search channel history"]').focus()`);
      await client.command("Input.insertText", { text: "release check" });
      await client.waitForText("3 messages");
      await client.evaluate(`[...document.querySelectorAll('.channel-search-result')].find(r => r.innerText.includes('Logged'))?.click()`);
      await client.evaluate(`(() => {
        const open = document.querySelector('.channel-search-result[aria-expanded="true"]');
        if (!open?.innerText.includes('Next step: confirm the Friday release window.'))
          throw new Error('Choosing a result must expand the full message in place');
      })()`);
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
      const setupPath = `/plugins/bot-teams/bots/new/${room.id}`;
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
    id: "emoji-react",
    packageDir: "bb-plugin-emoji-react",
    fileName: "smart-reactions.png",
    privateSidebar: true,
    // Seed a thread with smart reactions on that asks "SQLite or Postgres?";
    // its reply must end with a ::reactions directive naming both.
    setup: async (client) => {
      const smartThreadId = process.env.BB_CAPTURE_SMART_REACTIONS_THREAD_ID ?? threadId;
      await client.navigate(`/projects/${projectId}/threads/${smartThreadId}`);
      await client.waitForSelector('[role="group"][aria-label="Suggested reactions"]');
      await client.evaluate(`(() => {
        const group = document.querySelector('[role="group"][aria-label="Suggested reactions"]');
        const labels = Array.from(group.querySelectorAll("button")).map((button) => button.textContent.trim());
        for (const label of ["SQLite", "Postgres"]) {
          if (!labels.some((text) => text.endsWith(label))) {
            throw new Error("Smart reactions are missing " + label + ": " + labels.join(", "));
          }
        }
        if (document.body.innerText.includes("::reactions{")) {
          throw new Error("The raw ::reactions directive is still visible");
        }
        group.scrollIntoView({ block: "center" });
        return true;
      })()`);
      // Clicking a reaction drafts it into the composer.
      await client.evaluate(`new Promise((resolve, reject) => {
        Array.from(document.querySelectorAll('[aria-label="Suggested reactions"] button'))
          .find((button) => button.textContent.trim().endsWith("SQLite"))
          .click();
        const started = Date.now();
        const check = () => {
          const editor = document.querySelector('[contenteditable="true"]');
          if (editor?.innerText.includes("SQLite")) return resolve(true);
          if (Date.now() - started > 5000) return reject(new Error("Clicking SQLite did not draft a reply"));
          setTimeout(check, 100);
        };
        check();
      })`, true);
      return async () => {
        await client.evaluate(`(() => {
          const editor = document.querySelector('[contenteditable="true"]');
          editor?.focus();
          document.execCommand("selectAll");
          document.execCommand("delete");
          return true;
        })()`);
      };
    },
    // End the frame below the reactions, above the composer and machine name.
    clip: (client) =>
      client.evaluate(`(() => {
        const group = document.querySelector('[role="group"][aria-label="Suggested reactions"]');
        const bottom = group.getBoundingClientRect().bottom + 24;
        return { x: 0, y: 0, width: window.innerWidth, height: Math.round(bottom) };
      })()`),
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
    id: "smart-queue",
    packageDir: "bb-plugin-smart-queue",
    // End the frame just below the composer, above the row naming the machine.
    clip: (client) =>
      client.evaluate(`(() => {
        // The composer card is the bordered frame around both the editor and its model picker.
        const editor = document.querySelector('[contenteditable="true"]');
        const picker = Array.from(document.querySelectorAll("button"))
          .find((candidate) => candidate.innerText.includes("Qwen3.8 Flash"));
        if (!editor || !picker) throw new Error("Composer editor or model picker not found");
        let composer = picker.parentElement;
        while (composer && !(composer.contains(editor) && getComputedStyle(composer).borderTopWidth !== "0px")) {
          composer = composer.parentElement;
        }
        if (!composer) throw new Error("Composer frame not found");
        const frame = composer.getBoundingClientRect();
        // Whatever sits below the card, such as the machine row, must fall outside the crop.
        const below = Array.from(document.querySelectorAll("button, span"))
          .filter((candidate) => !composer.contains(candidate) && candidate.textContent.trim() &&
            candidate.getBoundingClientRect().top >= frame.bottom &&
            candidate.getBoundingClientRect().left < frame.right && candidate.getBoundingClientRect().right > frame.left);
        if (!below.length) throw new Error("Expected the machine row below the composer");
        const nextTop = Math.min(...below.map((candidate) => candidate.getBoundingClientRect().top));
        const bottom = Math.min(Math.ceil(frame.bottom) + 12, Math.floor(nextTop) - 1);
        const inside = below.find((candidate) => candidate.getBoundingClientRect().top < bottom);
        if (inside) {
          throw new Error("The crop would include " + JSON.stringify(inside.textContent.trim()) +
            " at " + Math.round(inside.getBoundingClientRect().top) + "px; the composer ends at " + Math.round(frame.bottom) + "px");
        }
        return { x: 0, y: 0, width: window.innerWidth, height: bottom };
      })()`),
    setup: async (client) => {
      const followup = "Next, write a haiku about message queues.";
      const correction = "Stop, cancel the sleep now and reply with the word cancelled.";
      // A real busy turn: a cheap provider session that sleeps in its shell.
      const spawned = JSON.parse(await bbCli([
        "thread", "spawn", "--json",
        "--project", "proj_personal",
        "--new-environment", "personal",
        "--provider", "pi",
        "--model", "opencode-go/qwen3.8-flash",
        "--permission-mode", "full",
        "--title", "Smart Queue demo",
        "--prompt", "Use your shell tool to run exactly: sleep 150. When it ends, reply with the single word: done.",
      ]));
      const demoThreadId = spawned.id;
      const cleanup = async () => {
        await bbCli(["thread", "stop", demoThreadId]).catch(() => {});
        await bbCli(["thread", "delete", demoThreadId, "--yes"]).catch(() => {});
      };
      try {
        const started = Date.now();
        while (!(await bbCli(["thread", "log", demoThreadId])).includes("sleep 150")) {
          if (Date.now() - started > 60000) throw new Error("The demo turn never started its shell command");
          await sleep(1000);
        }
        // Personal-project threads have no project segment in their route.
        await client.navigate(`/threads/${demoThreadId}`);
        await client.waitForText("sleep 150");
        await client.waitForSelector('[contenteditable="true"]');
        // Both messages go through the real composer while the turn is busy.
        for (const text of [followup, correction]) {
          await client.evaluate(`(() => {
            // An unknown route falls back to the new-thread composer; never type there.
            if (location.pathname !== ${JSON.stringify(`/threads/${demoThreadId}`)}) {
              throw new Error("Expected the demo thread, found " + location.pathname);
            }
            document.querySelector('[contenteditable="true"]').focus();
            return true;
          })()`);
          await client.command("Input.insertText", { text });
          await client.command("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
          await client.command("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
          await sleep(1500);
        }
        // The correction joins the running turn; the separate task waits in the queue.
        await client.waitForText(`Steer\n\n${correction}`, 60000);
        await client.waitForText(`Queue\n1\n${followup}`);
        await client.waitForText("sleep 150");
        const recent = JSON.parse(await bbCli(["smart-queue", "recent", "--limit", "5", "--json"]));
        const decided = (text) => recent.find((entry) => entry.threadId === demoThreadId && entry.preview === text)?.verdict.action;
        if (decided(correction) !== "steer" || decided(followup) !== "followup") {
          throw new Error(`Smart Queue did not record the expected decisions: ${JSON.stringify(recent)}`);
        }
      } catch (error) {
        await cleanup();
        throw error;
      }
      return cleanup;
    },
  },
  {
    id: "smart-queue-settings",
    packageDir: "bb-plugin-smart-queue",
    fileName: "settings.png",
    setup: async (client) => {
      // Stage a known fallback choice for the picker, then restore the owner's.
      const previous = JSON.parse(await bbCli(["smart-queue", "fallback", "--json"]));
      await bbCli(["smart-queue", "fallback", "pi", "opencode-go/qwen3.8-flash", "low"]);
      const restore = async () => {
        await client.command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
        await (previous.mode === "model"
          ? bbCli(["smart-queue", "fallback", previous.providerId, previous.model, ...(previous.reasoningLevel ? [previous.reasoningLevel] : [])])
          : bbCli(["smart-queue", "fallback", previous.mode]));
      };
      try {
        await client.navigate("/settings/plugins/smart-queue");
        await client.waitForText("Jev provider");
        await client.waitForText("TypeSafe model");
        await client.waitForText("Jev connection");
        await client.waitForText("Providers auto will try");
        await client.waitForText("Test connection");
        await client.waitForText("Fallback model");
        await client.waitForText("A specific model");
        await client.waitForText("Qwen3.8 Flash");
        // A taller frame shows the provider keys and both custom sections
        // without clipping a row; the page ends at the fallback model.
        await client.command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1120, deviceScaleFactor: 1, mobile: false });
        await sleep(400);
        // The live connection check proves the listed provider answers.
        await client.clickButtonText("Test");
        await client.waitForText("Jev answered through", 20000);
        await client.evaluate(`(() => {
          const picker = Array.from(document.querySelectorAll("button"))
            .find((candidate) => candidate.innerText.includes("Qwen3.8 Flash"));
          let pane = picker?.parentElement;
          while (pane && pane.scrollHeight <= pane.clientHeight) pane = pane.parentElement;
          if (!pane) throw new Error("Settings scroll pane not found");
          pane.scrollTop = pane.scrollHeight;
          return true;
        })()`);
        await sleep(400);
      } catch (error) {
        await restore();
        throw error;
      }
      return restore;
    },
  },
  {
    id: "talk",
    packageDir: "bb-plugin-talk",
    privateSidebar: true,
    setup: async (client) => {
      const recordingId = await seedTalkRecording(projectId);
      const cleanup = async () => {
        await client.evaluate(`document.querySelector('[data-talk-overlay] button[aria-label="Stop recording"]')?.click()`);
        await sleep(1500);
        await talkRpc("recording_delete", { id: recordingId });
      };
      try {
        await client.navigate(`/plugins/talk/recordings/${recordingId}`);
        await client.waitForText("Weekly product sync");
        await client.waitForText("offline mode beta");
        await client.waitForText("guided import spec");
        await client.waitForText("Record more");
        // Record from the synthetic microphone so the live pill is on screen.
        await client.clickButtonText("Record more");
        await client.waitForSelector("[data-talk-overlay]");
        await client.waitForAriaButton("Stop recording");
        await client.waitForText("Pause");
        await sleep(2500);
      } catch (error) {
        await cleanup();
        throw error;
      }
      return cleanup;
    },
  },
  {
    id: "pages",
    packageDir: "bb-plugin-pages",
    privateSidebar: true,
    setup: async (client) => {
      const { page, cleanup } = await seedPages();
      try {
        await client.navigate(`/plugins/pages/pages/${page.id}`);
        await client.waitForSelector('nav[aria-label="Breadcrumbs"]');
        await client.waitForAriaButton("Comments");
        await client.waitForAriaButton("Page actions");
        await client.waitForText("Work with this page…");
        await client.waitForText("Offline mode launch");
        await client.waitForText("Beta teams");
        await client.waitForText("Crash-free sessions");
        await client.waitForText("Weekly active teams");
        await client.waitForText("Localise onboarding for Japanese and German");
        await client.waitForSelector(".recharts-bar-rectangle");
        // Talk is installed in the staged app, so the page offers dictation.
        await client.waitForSelector('[data-talk-field^="pages:"]');
        await client.waitForAriaButton("Dictate");
        await sleep(1000);
      } catch (error) {
        await cleanup();
        throw error;
      }
      return cleanup;
    },
  },
  {
    id: "pages-collection",
    packageDir: "bb-plugin-pages",
    fileName: "collection.png",
    privateSidebar: true,
    setup: async (client) => {
      const { cleanup } = await seedPages();
      try {
        await client.navigate("/plugins/pages/pages");
        // Shows the list view across every project, whatever an earlier run left behind.
        await client.evaluate(`localStorage.setItem("bb-pages:view", "list"); localStorage.removeItem("bb-pages:project-filter")`);
        await client.navigate("/plugins/pages/pages");
        await client.waitForSelector('input[aria-label="Search pages"]');
        await client.waitForSelector('[role="table"]');
        await client.waitForText("New page");
        await client.waitForText("Edited by agents");
        await client.waitForText("Offline mode launch");
        await client.waitForText("Rollout risks");
        await client.waitForText("Release notes: October");
        await sleep(800);
      } catch (error) {
        await cleanup();
        throw error;
      }
      return cleanup;
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
      const privateSidebar = !capture.showSidebar && (capture.privateSidebar || (capture.packageDir === "bb-plugin-bot-teams" && capture.id !== "bots-forks") || capture.id === "automation-calendar" || capture.id === "smart-queue");
      if (privateSidebar) {
        await client.evaluate(`document.querySelector('button[aria-label^="Toggle sidebar"]')?.click()`);
        await sleep(350);
      }
      // A capture may crop the real frame, such as to leave out machine names.
      await client.capture(outputPath, capture.clip ? await capture.clip(client) : undefined);
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
