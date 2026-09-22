// Run against a seeded, empty-member "Transcript paging QA" channel containing
// at least 1,200 messages with IDs qa:<channel-id>:0 through :1199.
// This exercises the real BB UI and sends one harmless message to that fixture.
// BB_TRANSCRIPT_QA_SESSION=<browser-automation session>
// BB_TRANSCRIPT_QA_CHANNEL=<fixture UUID> node scripts/qa-bot-teams-transcript.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const session = process.env.BB_TRANSCRIPT_QA_SESSION;
const channel = process.env.BB_TRANSCRIPT_QA_CHANNEL;
const origin = process.env.BB_TRANSCRIPT_QA_ORIGIN || "http://127.0.0.1:38886";
if (!session || !channel)
  throw new Error("Set BB_TRANSCRIPT_QA_SESSION and BB_TRANSCRIPT_QA_CHANNEL.");
const temp = mkdtempSync(join(tmpdir(), "bb-transcript-qa-"));
try {
  const input = join(temp, "input.json");
  writeFileSync(input, JSON.stringify({ id: channel }));
  const { room, messages } = JSON.parse(
    execFileSync(
      "bb",
      [
        "plugin",
        "rpc",
        "call",
        "bot-teams",
        "room",
        "--input-file",
        input,
        "--json",
      ],
      { encoding: "utf8" },
    ),
  );
  if (
    room.name !== "Transcript paging QA" ||
    room.memberIds.length ||
    room.archived
  )
    throw new Error(
      "Use only the unarchived Transcript paging QA fixture with no member bots.",
    );
  const script = `const p=await browser.getPage("main"); await (${exercise.toString()})(p, ${JSON.stringify(origin)}, ${JSON.stringify(channel)}, ${JSON.stringify(messages.at(-1)?.id)});`;
  try {
    console.log(
      execFileSync(
        "bb",
        [
          "browser-automation",
          "run",
          session,
          "--script",
          script,
          "--timeout",
          "60s",
          "--json",
        ],
        { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 },
      ),
    );
  } catch (error) {
    console.error(error.stdout || error.message);
    process.exitCode = 1;
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}

async function exercise(p, origin, channel, latestId) {
  await p.setViewport({
    width: 1280,
    height: 900,
    isMobile: false,
    hasTouch: false,
  });
  await p.goto(`${origin}/plugins/bot-teams/channels/${channel}`);
  await p.waitForSelector("[data-channel-message]");
  await p.waitForFunction(
    (id) =>
      [...document.querySelectorAll("[data-channel-message]")].at(-1)?.dataset
        .channelMessage === id ||
      document.querySelector(".channel-latest button"),
    {},
    latestId,
  );
  if (
    await p.evaluate(() => !!document.querySelector(".channel-latest button"))
  )
    await p.click(".channel-latest button");
  await p.waitForFunction(
    (id) =>
      [...document.querySelectorAll("[data-channel-message]")].at(-1)?.dataset
        .channelMessage === id,
    {},
    latestId,
  );
  const initial = await p.evaluate(
    () => document.querySelectorAll("[data-channel-message]").length,
  );
  if (initial !== 50)
    throw new Error(
      `Initial transcript contained ${initial} messages, expected 50`,
    );
  await p.waitForFunction(() => {
    const root = document.querySelector(".bot-room-messages");
    return root.scrollHeight - root.scrollTop - root.clientHeight < 10;
  });
  console.log("Initial page and bottom position pass");
  for (const direction of [
    "older",
    "older",
    "older",
    "older",
    "older",
    "newer",
    "newer",
    "newer",
  ]) {
    const anchor = await p.evaluate((direction) => {
      const root = document.querySelector(".bot-room-messages");
      root.scrollTop =
        direction === "older"
          ? 100
          : root.scrollHeight - root.clientHeight - 100;
      const rows = [...root.querySelectorAll("[data-channel-message]")];
      const row = rows.find(
        (r) =>
          r.getBoundingClientRect().bottom > root.getBoundingClientRect().top,
      );
      return {
        id: row.dataset.channelMessage,
        top: row.getBoundingClientRect().top,
        edge: (direction === "older" ? rows[0] : rows.at(-1)).dataset
          .channelMessage,
        direction,
      };
    }, direction);
    await p.waitForFunction(
      (a) => {
        const rows = [...document.querySelectorAll("[data-channel-message]")];
        return (
          (a.direction === "older" ? rows[0] : rows.at(-1))?.dataset
            .channelMessage !== a.edge
        );
      },
      {},
      anchor,
    );
    await p.evaluate((a) => {
      const rows = [...document.querySelectorAll("[data-channel-message]")];
      const row = rows.find((r) => r.dataset.channelMessage === a.id);
      const delta = row ? row.getBoundingClientRect().top - a.top : Infinity;
      if (Math.abs(delta) > 3 || rows.length > 150)
        throw new Error(
          `Scroll anchor moved ${delta}px; mounted ${rows.length} messages`,
        );
    }, anchor);
    console.log(`Scrolled ${direction} with stable anchor`);
  }
  const target = `qa:${channel}:100`;
  await p.goto(
    `${origin}/plugins/bot-teams/channels/${channel}/message/${encodeURIComponent(target)}`,
  );
  await p.waitForFunction(
    (id) => document.activeElement.id === `channel-message-${id}`,
    {},
    target,
  );
  await p.evaluate((id) => {
    if (document.querySelectorAll("[data-channel-message]").length !== 50)
      throw new Error("Deep link loaded intervening history");
    const transcriptCalls = performance
      .getEntriesByType("resource")
      .filter((r) => r.name.endsWith("/rpc/transcript"));
    if (transcriptCalls.length !== 1)
      throw new Error(`Deep link used ${transcriptCalls.length} page requests`);
  }, target);
  console.log("Direct message link passes");
  // Delay one real history response to reproduce sending during pagination.
  await p.evaluate(() => {
    const original = window.fetch;
    window.__transcriptQaRestore = () => {
      window.fetch = original;
    };
    window.__transcriptQaSeen = false;
    window.fetch = async (...args) => {
      const response = await original(...args);
      if (
        String(args[0]).endsWith("/rpc/transcript") &&
        !window.__transcriptQaSeen
      ) {
        window.__transcriptQaSeen = true;
        await new Promise((resolve) => {
          window.__transcriptQaRelease = resolve;
        });
      }
      return response;
    };
    document.querySelector(".bot-room-messages").scrollTop = 80;
  });
  const text = `Transcript QA send during paging ${Date.now()}`;
  try {
    await p.waitForFunction(() => window.__transcriptQaSeen);
    await p.type('textarea[aria-label="Message channel"]', text);
    await p.click('button[aria-label="Send message"]');
    await p.waitForFunction(
      (text) =>
        [...document.querySelectorAll("[data-channel-message]")]
          .at(-1)
          ?.textContent.includes(text),
      {},
      text,
    );
    const edge = await p.evaluate(() => {
      const first = document.querySelector("[data-channel-message]").dataset
        .channelMessage;
      document.querySelector(".bot-room-messages").scrollTop = 80;
      return first;
    });
    await p.waitForFunction(
      (id) =>
        document.querySelector("[data-channel-message]")?.dataset
          .channelMessage !== id,
      {},
      edge,
    );
    console.log("Paging resumes while superseded response is still held");
  } finally {
    await p.evaluate(() => {
      window.__transcriptQaRelease?.();
      window.__transcriptQaRestore?.();
    });
  }
  console.log("Send during paging passes");
  await p.setViewport({
    width: 390,
    height: 844,
    isMobile: true,
    hasTouch: true,
  });
  await p.waitForFunction(
    (id) => document.activeElement.id === `channel-message-${id}`,
    {},
    target,
  );
  await p.evaluate((id) => {
    const message = document
      .getElementById(`channel-message-${id}`)
      .getBoundingClientRect();
    const root = document
      .querySelector(".bot-room-messages")
      .getBoundingClientRect();
    if (
      message.top < root.top ||
      message.bottom > root.bottom ||
      document.documentElement.scrollWidth > innerWidth
    )
      throw new Error(
        "Mobile deep-link target is not readable in the viewport",
      );
  }, target);
  const latest = await p.evaluate(() =>
    [...document.querySelectorAll(".channel-latest button")].map(
      (b) => b.textContent,
    ),
  );
  if (!latest.includes("Jump to latest"))
    throw new Error("Historical view has no route back to latest");
  await p.evaluate(() => {
    const original = window.fetch;
    window.__transcriptQaRestore = () => {
      window.fetch = original;
    };
    window.__transcriptQaSeen = false;
    window.fetch = async (...args) => {
      const response = await original(...args);
      if (
        String(args[0]).endsWith("/rpc/transcript") &&
        !window.__transcriptQaSeen
      ) {
        window.__transcriptQaSeen = true;
        await new Promise((resolve) => {
          window.__transcriptQaRelease = resolve;
        });
      }
      return response;
    };
    document.querySelector(".bot-room-messages").scrollTop = 80;
  });
  await p.waitForFunction(() => window.__transcriptQaSeen);
  try {
    await p.click(".channel-latest button");
    await p.waitForFunction(
      (text) =>
        [...document.querySelectorAll("[data-channel-message]")]
          .at(-1)
          ?.textContent.includes(text),
      {},
      text,
    );
    const edge = await p.evaluate(() => {
      const first = document.querySelector("[data-channel-message]").dataset
        .channelMessage;
      document.querySelector(".bot-room-messages").scrollTop = 80;
      return first;
    });
    await p.waitForFunction(
      (id) =>
        document.querySelector("[data-channel-message]")?.dataset
          .channelMessage !== id,
      {},
      edge,
    );
  } finally {
    await p.evaluate(() => {
      window.__transcriptQaRelease?.();
      window.__transcriptQaRestore?.();
    });
  }
  console.log(
    "PASS: 50 initial rows; bounded 150-row bidirectional scrolling; stable anchors; one-request deep link; historical send during paging; mobile target and jump to latest.",
  );
}
