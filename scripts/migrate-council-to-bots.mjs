#!/usr/bin/env node
// Run on the BB server machine. No external dependencies; Node >=22.19.
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  chmodSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    "data-dir": { type: "string" },
    apply: { type: "boolean" },
    help: { type: "boolean" },
  },
});
if (values.help || !values["data-dir"]) {
  console.log(
    "Usage: node scripts/migrate-council-to-bots.mjs --data-dir /absolute/BB/data [--apply]\nDry run by default. Apply backs up Council, disables it, and imports members/presets through bb bots. It does not uninstall Council.",
  );
  process.exit(values.help ? 0 : 2);
}
const dataDir = resolve(values["data-dir"]);
const directory = join(dataDir, "plugins", "bot-teams", "imports", "council-v1");
const snapshot = join(directory, "council.db");
const source = join(dataDir, "plugins", "council", "data.db");
const bb = (args, json = true) => {
  const text = execFileSync(process.env.BB_CLI || "bb", args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return json ? JSON.parse(text) : text;
};
if (resolve(bb(["status", "--json"]).dataDir) !== dataDir)
  throw new Error(
    "The CLI is connected to a different BB data directory. Connect to the intended server before migrating.",
  );
const readDb = (path) => new DatabaseSync(path, { readOnly: true });
const roster = (db) =>
  db.prepare("SELECT * FROM members ORDER BY created_at_ms").all();
const saved = existsSync(snapshot);
if (!saved && !existsSync(source))
  throw new Error(
    "Council database not found. Run this on the BB server machine.",
  );
let db = readDb(saved ? snapshot : source);
const members = roster(db);
if (members.some((m) => !m.provider_id || !m.model || !m.reasoning_level))
  throw new Error(
    "Some Council members inherit execution settings. Set each member to its effective provider, model, and reasoning in Council before migrating; no defaults are guessed.",
  );
const presets = db.prepare("SELECT * FROM presets ORDER BY name").all();
const sessions = db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n;
if (
  db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE status='running'").get()
    .n
)
  throw new Error(
    "Council has running sessions. Finish or stop them before migration.",
  );
console.log(
  JSON.stringify(
    {
      members: members.map((m) => ({
        name: m.name,
        provider: m.provider_id,
        model: m.model,
        reasoning: m.reasoning_level,
        chief: !!m.is_chief,
        enabled: !!m.enabled,
      })),
      presets: presets.map((p) => p.name),
      sessions,
      backup: directory,
      apply: !!values.apply,
    },
    null,
    2,
  ),
);
if (!values.apply) {
  db.close();
  process.exit(0);
}
// Private directory: personas, session transcripts, and settings stay out of Git.
mkdirSync(directory, { recursive: true, mode: 0o700 });
chmodSync(directory, 0o700);
if (!saved) {
  const settings = bb(["plugin", "config", "council"], false);
  writeFileSync(join(directory, "settings.txt"), settings, { mode: 0o600 });
  bb(["plugin", "disable", "council"], false);
  db.exec(`VACUUM INTO '${snapshot.replaceAll("'", "''")}'`);
  chmodSync(snapshot, 0o600);
}
db.close();
const ledgerPath = join(directory, "migration.json");
const ledger = existsSync(ledgerPath)
  ? JSON.parse(readFileSync(ledgerPath, "utf8"))
  : { version: 1, members: {}, channels: {} };
const save = () => {
  writeFileSync(ledgerPath + ".tmp", JSON.stringify(ledger, null, 2), {
    mode: 0o600,
  });
  renameSync(ledgerPath + ".tmp", ledgerPath);
};
const allBots = () => {
  let result = [],
    offset = 0;
  do {
    const page = bb([
      "bots",
      "list",
      "--all",
      "--offset",
      String(offset),
      "--json",
    ]);
    result.push(...page.bots);
    if (page.nextOffset === null) break;
    offset = page.nextOffset;
  } while (true);
  return result;
};
for (const m of members) {
  const mission = [
    m.persona,
    "",
    "## Channel consultation",
    "Give independent, concise advice grounded in evidence. State your recommendation, concrete risks, and the smallest useful next step. Preserve disagreement; do not change your view just to agree with other members.",
    "Read the supplied brief and relevant sources. Review only; do not edit project files or perform external actions unless the owner explicitly requests that work.",
    m.is_chief
      ? "When asked to synthesize the group, attribute the distinct findings and dissent, report missing or failed responses, and give a clear recommendation. Do not claim a formal vote or consensus that did not occur."
      : "When asked for a follow-up, respond to the specific question. Avoid repeating earlier answers.",
    "Your final answer is posted to the current channel. Mention another bot only to request a specific follow-up.",
    "",
  ].join("\n");
  const expected = {
    providerId: m.provider_id,
    model: m.model,
    reasoningLevel: m.reasoning_level,
  };
  let bot = ledger.members[m.id]
    ? bb(["bots", "show", ledger.members[m.id], "--json"])
    : undefined;
  if (!bot) {
    // Recover an interrupted create only when the entire imported identity matches.
    const candidates = allBots().filter((b) => b.name === m.name);
    if (candidates.length) {
      const matches = candidates.filter(
        (b) =>
          Object.entries(expected).every(([k, v]) => b[k] === v) &&
          bb(["bots", "mission", b.id, "--json"]).text === mission + "\n",
      );
      if (matches.length !== 1)
        throw new Error(
          `Existing bot name ${m.name} conflicts. Resolve it before retrying; nothing was overwritten.`,
        );
      bot = matches[0];
    } else {
      bot = bb([
        "bots",
        "create",
        m.name,
        "--mission",
        mission,
        "--provider",
        expected.providerId,
        "--model",
        expected.model,
        "--reasoning",
        expected.reasoningLevel,
        "--description",
        m.is_chief
          ? "Independent advisor and group synthesis"
          : "Independent review and advice",
        "--avatar",
        m.is_chief
          ? "🪨"
          : m.name === "Architect"
            ? "🏛️"
            : m.name === "Designer"
              ? "🎨"
              : "🤖",
        "--interval",
        "0",
        "--json",
      ]);
    }
    ledger.members[m.id] = bot.id;
    save();
  }
  if (
    !Object.entries(expected).every(([k, v]) => bot[k] === v) ||
    bb(["bots", "mission", bot.id, "--json"]).text !== mission + "\n"
  )
    throw new Error(
      `Imported ${m.name} differs from the backup. Stopping without overwriting edits.`,
    );
  if (!m.enabled && !bot.retired) bb(["bots", "retire", bot.id, "--json"]);
  console.log(`Verified ${m.name}: ${bot.id}`);
}
const groups = [
  {
    id: "council",
    name: "Council",
    memberIds: members.filter((m) => m.enabled).map((m) => m.id),
  },
  ...presets.map((p) => ({
    id: p.id,
    name: `Council · ${p.name}`,
    memberIds: JSON.parse(p.member_ids),
  })),
];
for (const group of groups) {
  const memberIds = [
    ...new Set(
      group.memberIds
        .filter((id) => members.some((m) => m.id === id && m.enabled))
        .map((id) => ledger.members[id]),
    ),
  ];
  if (group.name.length > 80 || memberIds.length > 16)
    throw new Error(
      `Channel ${group.name} exceeds Bots limits; backup retained.`,
    );
  const entry = ledger.channels[group.id] ?? {
    id: randomUUID(),
    name: group.name,
  };
  ledger.channels[group.id] = entry;
  save();
  const channel = bb([
    "bots",
    "channel",
    "create",
    entry.name,
    "--request-id",
    entry.id,
    ...memberIds.flatMap((id) => ["--bot", id]),
    "--json",
  ]);
  if (
    channel.id !== entry.id ||
    JSON.stringify(channel.memberIds) !== JSON.stringify(memberIds)
  )
    throw new Error("Channel verification failed.");
  console.log(`Verified channel ${channel.name}: ${channel.id}`);
}
ledger.completedAt = new Date().toISOString();
save();
console.log(
  `Migration verified. Legacy history and settings: ${directory}\nAfter checking the new channel, remove Council with: bb plugin remove council`,
);
