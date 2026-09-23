// UI regression using two temporary bot-free channels, deleted in finally.
// BB_CHANNEL_QA_SESSION=<browser session> node scripts/qa-bot-teams-channel-discovery.mjs
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const session = process.env.BB_CHANNEL_QA_SESSION;
const origin = process.env.BB_CHANNEL_QA_ORIGIN ?? "http://127.0.0.1:38886";
if (!session) throw new Error("Set BB_CHANNEL_QA_SESSION.");
const cli = (...args) => JSON.parse(execFileSync('bb', ['bots', 'channel', ...args, '--json'], { encoding: 'utf8' }));
const created = [];
try {
  const suffix = randomUUID().slice(0, 8);
  const make = (name) => {
    const channel = cli('create', name, '--behavior', 'directed');
    created.push(channel.id);
    return channel;
  };
  const fixture = make(`Archive discovery QA ${suffix}`);
  const active = make(`Active discovery QA ${suffix}`);
  cli('archive', fixture.id);
  const result = JSON.parse(execFileSync("bb", [
    "browser-automation", "run", session, "--script",
    `const p=await browser.getPage("main"); await (${exercise.toString()})(p, ${JSON.stringify({ origin, fixture, active })});`,
    "--timeout", "60s", "--json",
  ], { encoding: "utf8" }));
  console.log(JSON.stringify(result, null, 2));
  if (result.exitCode) process.exitCode = 1;
} catch (error) {
  console.error(error.stdout || error.message);
  process.exitCode = 1;
} finally {
  for (const id of created) cli('delete', id, '--yes');
}

async function exercise(p, { origin, fixture, active }) {
  const input = '.channels-sidebar input[aria-label="Search all channels"]';
  const activeButton = '.channels-sidebar [aria-label="Show active channels"]';
  const archivedButton = '.channels-sidebar [aria-label="Show archived channels"]';
  const hasRow = (name) => [...document.querySelectorAll('.channel-nav-name')]
    .some((e) => e.textContent === name);
  const waitRow = (name) => p.waitForFunction(hasRow, {}, name);
  const clickView = async (selector) => {
    await p.click(selector);
    await p.waitForSelector(selector === activeButton ? archivedButton : activeButton);
  };
  await p.setViewport({ width: 1440, height: 1000, isMobile: false, hasTouch: false });
  await p.goto(`${origin}/plugins/bot-teams/channels/${fixture.id}`);
  await p.waitForSelector(archivedButton);
  await waitRow(active.name);
  if (await p.evaluate(hasRow, fixture.name)) throw new Error('Archived channel leaked into Active view.');
  if (await p.evaluate(() => [...document.querySelectorAll('.channels-sidebar header button')].some((b) => b.textContent === 'Channels')))
    throw new Error('Channels heading is still a hidden toggle.');
  if (await p.evaluate(() => !!document.querySelector('.channel-nav-expand')))
    throw new Error('Channel rows still expose a bot-thread dropdown.');
  await p.evaluate((name) =>
    [...document.querySelectorAll('.channel-sidebar-row > .channel-nav-row')]
      .find((row) => row.querySelector('.channel-nav-name')?.textContent === name)?.click(),
    active.name,
  );
  await p.waitForFunction((name) =>
    document.querySelector('.channel-sidebar-row[data-selected] .channel-nav-name')?.textContent === name &&
    document.querySelectorAll('.channel-thread-empty').length === 1,
    {}, active.name,
  );
  if (await p.evaluate(() => document.querySelectorAll('.channel-thread-list').length > 1))
    throw new Error('Bot threads appeared under more than the selected channel.');

  // Archive is visible and reachable with keyboard input.
  console.log('Checking keyboard archive toggle');
  await p.focus(archivedButton);
  await p.keyboard.press('Enter');
  await waitRow(fixture.name);
  if (await p.evaluate(() => !!document.querySelector('.channel-thread-list, .channel-thread-empty')))
    throw new Error('Hidden channel kept its bot threads visible.');
  if (await p.evaluate(hasRow, active.name)) throw new Error('Active channel leaked into Archived view.');
  await clickView(activeButton);
  await p.click('.channels-sidebar [aria-label="Search channels"]');
  await p.fill(input, `  ${fixture.name.toUpperCase()}  `);
  await waitRow(fixture.name);
  await p.waitForSelector('.channel-nav-archived');
  await p.waitForFunction(() => document.querySelector('.channels-search-scope')?.textContent.includes('active and archived'));

  console.log('Checking search result actions');
  // Search results retain archive actions and a cancellable delete dialog.
  await p.click(`[aria-label="${fixture.name} options"]`);
  await p.waitForSelector('[role="menuitem"]');
  const options = await p.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].map((e) => e.textContent.trim()));
  if (!options.includes('Restore') || !options.includes('Delete')) throw new Error('Archived result actions missing.');
  if (options.some((label) => /bot threads/i.test(label))) throw new Error('Context menu still exposes a bot-thread toggle.');
  await p.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].find((e) => e.textContent.trim() === 'Delete').click());
  await p.waitForSelector('[role="dialog"]');
  await p.evaluate(() => [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === 'Cancel').click());
  await p.waitForSelector('[role="dialog"]', { hidden: true });
  await waitRow(fixture.name);

  console.log('Checking empty search and reset');
  await p.fill(input, 'no-channel-matches-this-query-qa');
  await p.waitForFunction(() => document.querySelector('.channels-sidebar').textContent.includes('No matching channels'));
  await p.fill(input, '   ');
  await waitRow(active.name);
  await p.fill(input, fixture.name);
  await waitRow(fixture.name);
  await p.click('.channels-sidebar [aria-label="Search channels"]');
  await waitRow(active.name);
  if (await p.evaluate(hasRow, fixture.name)) throw new Error('Closing search retained its filter.');

  console.log('Checking active search from archive');
  // Search from Archived also finds active channels; clearing restores Archived.
  await clickView(archivedButton);
  await p.click('.channels-sidebar [aria-label="Search channels"]');
  await p.fill(input, active.name);
  await waitRow(active.name);
  if (await p.evaluate(() => !!document.querySelector('.channel-nav-archived'))) throw new Error('Active result labeled Archived.');
  await p.fill(input, '');
  await waitRow(fixture.name);
  await p.click('.channels-sidebar [aria-label="Search channels"]');

  console.log('Checking mobile header');
  // Narrow touch sidebar keeps the archive toggle beside search and in bounds.
  await p.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await p.goto(`${origin}/plugins/bot-teams/channels/${fixture.id}`);
  await p.waitForLoad();
  await p.waitForSelector('button[aria-label^="Toggle sidebar"]');
  await p.evaluate(() => document.querySelector('button[aria-label^="Toggle sidebar"][aria-expanded="false"]')?.click());
  await p.waitForSelector(archivedButton, { visible: true });
  await waitRow(active.name);
  await p.waitForFunction(() => {
    const drawer = document.querySelector('.channels-sidebar')?.closest('[role="dialog"]');
    return drawer && Math.abs(drawer.getBoundingClientRect().left) < 1;
  });
  await p.waitForFunction((selector) => {
    const button = document.querySelector(selector);
    const r = button?.getBoundingClientRect();
    return r && button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
  }, {}, archivedButton);
  await p.tap(archivedButton);
  await waitRow(fixture.name);
  if (await p.evaluate(() => [...document.querySelectorAll('.channels-sidebar header button')].some((b) => {
    const r = b.getBoundingClientRect();
    return r.left < 0 || r.right > innerWidth || r.width < 24;
  }))) throw new Error('Header controls overflow the touch sidebar.');
  console.log('PASS: selected-channel thread list, no thread toggle, archive navigation, keyboard activation, search across both states, status labels, delete cancellation, empty/whitespace search, search reset, mobile layout.');
  await p.shot({ type: 'jpeg', maxEdge: 1000, quality: 80 });
}
