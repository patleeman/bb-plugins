// Creates two temporary channels with no member bots, exercises the real UI,
// and removes both fixtures afterward. No bot work is requested.
// BB_WORKBENCH_QA_SESSION=<session> [BB_WORKBENCH_QA_ORIGIN=<url>] node scripts/qa-bot-teams-workbench.mjs
import { execFileSync } from "node:child_process";
const session = process.env.BB_WORKBENCH_QA_SESSION;
const origin = process.env.BB_WORKBENCH_QA_ORIGIN ?? "http://127.0.0.1:38886";
if (!session) throw new Error("Set BB_WORKBENCH_QA_SESSION.");
async function rpc(method, input) {
  const r = await fetch(`${origin}/api/v1/plugins/bot-teams/rpc/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", connection: "close" },
    body: JSON.stringify(input),
  });
  const data = await r.json();
  if (!r.ok || !data.ok) throw new Error(JSON.stringify(data));
  return data.result;
}
const fixtures = [];
try {
  for (const name of ["Workbench tabs QA", "Workbench switching QA"]) {
    fixtures.push(await rpc("createRoom", { name, memberIds: [], requestId: crypto.randomUUID() }));
  }
  const id = fixtures[0].id;
  const context = await rpc("channelContext", { id });
  await rpc("saveChannelContext", {
    id,
    version: context.version,
    brief: "This is a staged release-planning channel. The release code is ORBIT-42.",
    decisions: "Use SQLite for the first release.",
    memory: "Release planning stays in this channel.",
    attachmentIds: [],
  });
  const message = await rpc("send", {
    id,
    text: "ORBIT-42 release planning. Decision: use SQLite for the first release.",
    requestId: crypto.randomUUID(),
  });
  await rpc("saveMessage", { id, messageId: message.id, saved: true });
  for (const fixture of fixtures) await rpc("channelState", { id: fixture.id, archived: true });
  try {
    console.log(
      execFileSync(
        "bb",
        [
          "browser-automation",
          "run",
          session,
          "--script",
          `const p=await browser.getPage("main"); await (${exercise.toString()})(p, ${JSON.stringify(origin)}, ${JSON.stringify(fixtures)});`,
          "--timeout",
          "60s",
          "--json",
        ],
        { encoding: "utf8" },
      ),
    );
  } catch (e) {
    console.error(e.stdout || e.message);
    process.exitCode = 1;
  }
  if (!process.exitCode && process.env.BB_WORKBENCH_QA_CAPTURE === "1") {
    execFileSync("node", ["scripts/capture-plugin-screenshots.mjs"], {
      stdio: "inherit",
      env: {
        ...process.env,
        BB_SERVER_URL: origin,
        BB_CAPTURE_CHANNEL_ID: id,
        BB_CAPTURE_ONLY: "bots-native-tabs",
      },
    });
  }
} finally {
  for (const fixture of fixtures) await rpc("deleteRoom", { id: fixture.id });
}

async function exercise(p, origin, fixtures) {
  const id = fixtures[0].id;
  const route = `${origin}/plugins/bot-teams/channels/${id}`;
  const field = 'textarea[aria-label="Brief and instructions"]';
  const open = async (name) => {
    if (await p.evaluate(() => !!document.querySelector('[aria-label^="Show right panel"]')))
      await p.click('[aria-label^="Show right panel"]');
    const tab = `[aria-label="Right panel views"] button[aria-label="${name}"]`;
    await p.waitForSelector(tab);
    await p.evaluate(selector => document.querySelector(selector).click(), tab);
    await p.waitForFunction(
      selector => document.querySelector(selector)?.getAttribute("aria-pressed") === "true",
      {}, tab,
    );
  };
  const labels = {
    context: "Channel context",
    files: "Files",
    saved: "Saved decisions",
    activity: "Activity",
    automations: "Automations",
    usage: "Usage and limits",
  };
  const select = async (view) => {
    const label = labels[view];
    await p.evaluate((label) =>
      document.querySelector(`[aria-label="Right panel views"] button[aria-label="${label}"]`).click(),
      label,
    );
    await p.waitForFunction(
      (label) =>
        document
          .querySelector(`[aria-label="Right panel views"] button[aria-label="${label}"]`)
          ?.getAttribute("aria-pressed") === "true",
      {},
      label,
    );
  };
  await p.setViewport({ width: 1440, height: 1000, isMobile: false, hasTouch: false });
  await p.goto(route);
  await p.waitForSelector('[aria-label="Channel options"]');
  await p.click('[aria-label="Channel options"]');
  await p.evaluate(() => {
    const items = [...document.querySelectorAll('.channel-popover .channel-menu-row')].map(b => b.textContent.trim());
    const expected = ['Rename channel', 'Pin channel', 'Restore channel', 'Delete channel'];
    if (JSON.stringify(items) !== JSON.stringify(expected))
      throw new Error(`Unexpected channel options: ${items.join(', ')}`);
  });
  await p.click('[aria-label="Channel options"]');
  await open("Channel context");
  await p.waitForSelector(field);
  const baseline = await p.evaluate(
    () => document.querySelector('textarea[aria-label="Brief and instructions"]').value,
  );
  if (!baseline.includes("ORBIT-42")) throw new Error("Expected seeded ORBIT-42 context.");
  const stored = await p.evaluate((id) => localStorage.getItem(`bb:bots:context:${id}`), id);
  let stage = "native labels";
  try {
    await p.evaluate(() => {
      const panel = document.querySelector(".channel-workbench");
      if (
        panel.closest(".bot-room") ||
        !document.querySelector(
          '[aria-label="Right panel views"] [aria-label="Channel context"][aria-pressed="true"]',
        )
      )
        throw new Error("Details are outside the native workbench.");
      if (document.querySelector('select[aria-label="Channel detail view"]'))
        throw new Error("Channel view dropdown must be removed.");
      const buttons = [
        ...document.querySelectorAll('[aria-label="Right panel views"] button[aria-pressed]'),
      ];
      if (
        buttons.length !== 6 ||
        buttons.some((b) => {
          const label = b.querySelector(".sr-only");
          return (
            !label ||
            label.getBoundingClientRect().width < 10 ||
            getComputedStyle(label).clipPath !== "none"
          );
        })
      )
        throw new Error("Expected six native tabs with visible labels.");
      const e = document.querySelector('textarea[aria-label="Brief and instructions"]');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(
        e,
        `${e.value}\nWorkbench draft QA`,
      );
      e.dispatchEvent(new Event("input", { bubbles: true }));
    });
    stage = "draft persistence";
    await p.waitForFunction(() => document.body.innerText.includes("Unsaved changes"));
    await p.click('[aria-label^="Hide right panel"]');
    await open("Channel context");
    await p.waitForSelector(field);
    await p.waitForFunction(() =>
      document
        .querySelector('textarea[aria-label="Brief and instructions"]')
        .value.endsWith("Workbench draft QA"),
    );
    for (const [view, expected] of [
      ["files", "Files shared by you and the bots appear here."],
      ["saved", "SQLite"],
      ["activity", "No activity yet."],
      ["automations", "New automation"],
      ["usage", "Turns per hour"],
    ]) {
      stage = `tab ${view}`;
      await select(view);
      await p.waitForFunction(
        (expected) => document.querySelector(".channel-workbench")?.textContent.includes(expected),
        {},
        expected,
      );
    }
    stage = "reopened selection";
    await p.click('[aria-label^="Hide right panel"]');
    await p.click('[aria-label^="Show right panel"]');
    await p.waitForFunction(() =>
      document.querySelector('.channel-workbench[aria-label="Usage and limits"] input'),
    );
    await open("Channel context");
    await p.waitForSelector(field);
    stage = "switch channels";
    // Switch channels through the real sidebar (SPA navigation), then return.
    await p.click('.channels-sidebar [aria-label="Show archived channels"]');
    await p.waitForFunction(() =>
      [...document.querySelectorAll(".channel-nav-name")].some(
        (e) => e.textContent === "Workbench switching QA",
      ),
    );
    await p.evaluate(() =>
      [...document.querySelectorAll(".channel-nav-row")]
        .find((e) => e.querySelector(".channel-nav-name")?.textContent === "Workbench switching QA")
        .click(),
    );
    await p.waitForFunction(
      () => document.querySelector(".channel-title-name")?.textContent === "Workbench switching QA",
    );
    await p.waitForSelector(field);
    await p.waitForFunction(
      () =>
        !document
          .querySelector('textarea[aria-label="Brief and instructions"]')
          .value.includes("Workbench draft QA"),
    );
    await p.evaluate(() =>
      [...document.querySelectorAll(".channel-nav-row")]
        .find((e) => e.querySelector(".channel-nav-name")?.textContent === "Workbench tabs QA")
        .click(),
    );
    await p.waitForFunction(() =>
      document
        .querySelector('textarea[aria-label="Brief and instructions"]')
        ?.value.endsWith("Workbench draft QA"),
    );
    stage = "mobile layout";
    await p.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await p.waitForSelector('[aria-label="Channel options"]');
    await open("Channel context");
    await p.waitForSelector(field);
    await p.evaluate(() => {
      const panel = document.querySelector(".channel-workbench");
      const r = panel.getBoundingClientRect();
      if (r.left < 0 || r.right > innerWidth + 1 || panel.scrollWidth > panel.clientWidth + 1)
        throw new Error("Compact workbench overflows.");
    });
    stage = "mobile saved jump";
    await select("saved");
    await p.waitForSelector(".channel-search-result");
    await p.click(".channel-search-result");
    await p.waitForFunction(
      () =>
        !document.querySelector(".channel-workbench") &&
        document.activeElement?.id.startsWith("channel-message-"),
    );
    stage = "mobile automation response jump";
    const responseMessageId = await p.evaluate(() =>
      document.activeElement.id.slice("channel-message-".length),
    );
    // Supply a completed run to the real UI without creating a schedule or bot.
    await p.evaluate((id, responseMessageId) => {
      window.workbenchQaFetch = window.fetch;
      window.fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        let result;
        if (url.includes("/rpc/automationList")) {
          result = {
            automations: [{
              id: "workbench-run-qa", projectId: "workbench-qa", channelId: id,
              botId: "bot_0000000000000000", name: "Workbench response QA",
              prompt: "UI navigation fixture", enabled: false,
              trigger: { triggerType: "schedule", cron: "0 9 * * *", timezone: "UTC" },
              nextRunAt: null, lastRunAt: null, lastRunStatus: "success", lastError: null,
            }],
            nextOffset: null,
          };
        } else if (url.includes("/rpc/automationRuns")) {
          result = {
            runs: [{
              id: "workbench-dispatch-qa", status: "success", trigger: "manual",
              startedAt: Date.now(), finishedAt: Date.now(), error: null,
              skipReason: null, output: null, responseStatus: "completed", responseMessageId,
            }],
            nextCursor: null,
          };
        } else return window.workbenchQaFetch(input, init);
        return new Response(JSON.stringify({ ok: true, result }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      };
    }, id, responseMessageId);
    try {
      await open("Automations");
      await p.waitForFunction(() =>
        document.querySelector(".channel-automation-title")?.textContent.includes("Workbench response QA"),
      );
      stage = "mobile automation run history";
      await p.evaluate(() =>
        [...document.querySelectorAll(".channel-automation-actions button")]
          .find(b => b.textContent.trim() === "Run history").click(),
      );
      await p.waitForFunction(() =>
        [...document.querySelectorAll(".channel-automation-history button")]
          .some(b => b.textContent.trim() === "View response"),
      );
      stage = "mobile automation response focus";
      await p.evaluate(() =>
        [...document.querySelectorAll(".channel-automation-history button")]
          .find(b => b.textContent.trim() === "View response").click(),
      );
      await p.waitForFunction(
        (messageId) => !document.querySelector(".channel-workbench") &&
          document.activeElement?.id === `channel-message-${messageId}`,
        {}, responseMessageId,
      );
    } finally {
      await p.evaluate(() => {
        window.fetch = window.workbenchQaFetch;
        delete window.workbenchQaFetch;
      });
    }
    await p.setViewport({ width: 1440, height: 1000, isMobile: false, hasTouch: false });
    await p.waitForSelector('[aria-label="Channel options"]');
    await open("Channel context");
    await p.waitForSelector(field);
    await p.evaluate(() => {
      const errors = [...document.querySelectorAll('main [role="alert"]')]
        .map((e) => e.textContent)
        .filter(Boolean);
      if (errors.length) throw new Error(errors.join("\n"));
    });
    return "PASS: channel options contains only management actions, native workbench placement, six labeled tabs, reopened tab selection, hidden-panel reopening, context draft preservation, SPA channel isolation, compact layout, saved-message navigation, and automation-response navigation.";
  } catch (error) {
    const state = await p.evaluate(() => ({
      route: location.pathname,
      selected: [
        ...document.querySelectorAll(
          '[aria-label="Right panel views"] button[aria-pressed="true"]',
        ),
      ].map((e) => e.getAttribute("aria-label")),
      panel: document.querySelector(".channel-workbench")?.textContent.slice(0, 120),
      focused: document.activeElement?.outerHTML.slice(0, 240),
      drawers: [...document.querySelectorAll('[role="dialog"]')].map(e => ({
        label: e.getAttribute("aria-label"), state: e.getAttribute("data-state"),
      })),
    }));
    throw new Error(`${stage}: ${error.message} ${JSON.stringify(state)}`);
  } finally {
    await p.evaluate(
      (id, stored) => {
        const key = `bb:bots:context:${id}`;
        if (stored === null) localStorage.removeItem(key);
        else localStorage.setItem(key, stored);
      },
      id,
      stored,
    );
    await p.goto(route);
  }
}
