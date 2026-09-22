// One-time owner-run migration. Never imported by the plugin runtime.
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ownedTables = [
  "plugin_kv",
  "plugin_settings",
  "plugin_schedules",
  "thread_plugin_metadata",
] as const;
const dataTables = [
  "bots",
  "rooms",
  "conversations",
  "room_messages",
  "jobs",
] as const;
const migrationKey = "migration:bots-to-bot-teams:v1";
const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;
const open = (path: string, readOnly = true) =>
  new DatabaseSync(path, { readOnly });
function paths(dataDir: string) {
  const root = resolve(dataDir);
  return {
    root,
    core: join(root, "bb.db"),
    legacy: join(root, "plugins", "bots"),
    target: join(root, "plugins", "bot-teams"),
    backup: join(root, "migrations", "bots-to-bot-teams-v1"),
  };
}
function counts(db: DatabaseSync) {
  return Object.fromEntries(
    dataTables.map((t) => [
      t,
      db.prepare(`SELECT count(*) AS n FROM ${t}`).get()!.n,
    ]),
  ) as Record<string, number>;
}
function assertIdle(db: DatabaseSync) {
  const jobs = db
    .prepare(
      "SELECT count(*) AS n FROM jobs WHERE status IN ('queued','dispatching','running') OR json_extract(json,'$.cancellationPending')=1",
    )
    .get()!.n;
  const runs = db
    .prepare(
      "SELECT count(*) AS n FROM room_runs WHERE json_extract(json,'$.status') IN ('queued','running')",
    )
    .get()!.n;
  if (jobs || runs)
    throw new Error(
      "Finish active channel work before migrating. No responses are stopped by this migration.",
    );
}
function legacyRegistration(core: DatabaseSync) {
  const row = core
    .prepare("SELECT * FROM plugins WHERE id='bots' AND removed_at IS NULL")
    .get();
  if (!row) throw new Error("The legacy Bots installation was not found.");
  // A different community plugin has the same ID. Do not import its state.
  const source = String(row.source);
  const local = /^path:.*\/packages\/bb-plugin-bots\/?$/.test(source);
  const managed =
    /^git:https:\/\/github\.com\/patleeman\/bb-plugins(?:\.git)?(?:@[^#]+)?#packages\/bb-plugin-bots$/.test(
      source,
    );
  if (!local && !managed)
    throw new Error(
      "The installed Bots source is not Patrick's plugin. Migration refused.",
    );
  return row;
}
function assertLegacySchema(db: DatabaseSync) {
  for (const table of [
    ...dataTables,
    "room_runs",
    "routing_sessions",
    "reactions",
    "channel_notifications",
    "bot_create_requests",
  ]) {
    if (
      !db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
        .get(table)
    )
      throw new Error(
        "This is not the Bot Teams predecessor's channel database. Migration refused.",
      );
  }
  const columns = db
    .prepare("PRAGMA table_info(conversations)")
    .all()
    .map((r) => r.name);
  if (!["bot_id", "key", "thread_id", "json"].every((c) => columns.includes(c)))
    throw new Error("Unknown legacy conversation schema. Migration refused.");
}

export function inspectMigration(dataDir: string) {
  const p = paths(dataDir);
  const core = open(p.core),
    data = open(join(p.legacy, "data.db"));
  try {
    const registration = legacyRegistration(core);
    assertLegacySchema(data);
    assertIdle(data);
    if (
      core
        .prepare(
          "SELECT 1 FROM plugins WHERE id='bot-teams' AND removed_at IS NULL",
        )
        .get() ||
      existsSync(p.target)
    )
      throw new Error(
        "Bot Teams already has an installation or data directory. Existing data will not be overwritten.",
      );
    const projects = data
      .prepare(
        "SELECT DISTINCT json_extract(json,'$.projectId') AS id FROM bots",
      )
      .all()
      .map((r) => r.id);
    const threads = core
      .prepare(
        "SELECT id, project_id, status, origin_plugin_id FROM threads WHERE origin_plugin_id='bots'",
      )
      .all()
      .filter((r) => projects.includes(r.project_id));
    if (threads.some((r) => !["idle", "error"].includes(String(r.status))))
      throw new Error(
        "A legacy bot thread is still active or waiting. Finish it before migrating.",
      );
    return {
      source: String(registration.source),
      counts: counts(data),
      backup: p.backup,
      enabled: !!registration.enabled,
      threadIds: threads.map((r) => String(r.id)),
      origins: threads.map((r) => ({
        id: r.id,
        origin_plugin_id: r.origin_plugin_id,
      })),
      botIds: data
        .prepare("SELECT id FROM bots ORDER BY id")
        .all()
        .map((r) => String(r.id)),
      roomIds: data
        .prepare("SELECT id FROM rooms ORDER BY id")
        .all()
        .map((r) => String(r.id)),
    };
  } finally {
    data.close();
    core.close();
  }
}

export function preparedMigration(
  dataDir: string,
): ReturnType<typeof inspectMigration> | null {
  const p = paths(dataDir),
    core = open(p.core);
  try {
    const marker = core
      .prepare(
        "SELECT value FROM plugin_kv WHERE plugin_id='bot-teams' AND key=?",
      )
      .get(migrationKey);
    if (!marker) return null;
    if (marker.value !== JSON.stringify(p.backup))
      throw new Error("Unrecognized migration marker.");
    return JSON.parse(readFileSync(join(p.backup, "host-state.json"), "utf8"))
      .plan;
  } finally {
    core.close();
  }
}

// A crash before the core transaction commits leaves source data untouched.
// Retain the partial backup and discard only this attempt's unregistered copy.
export function recoverPreparation(dataDir: string) {
  if (preparedMigration(dataDir)) return;
  const p = paths(dataDir);
  if (!existsSync(join(p.backup, "attempt.json"))) return;
  const core = open(p.core);
  try {
    if (
      core
        .prepare(
          "SELECT 1 FROM plugins WHERE id='bot-teams' AND removed_at IS NULL",
        )
        .get()
    )
      throw new Error(
        "An unverified Bot Teams installation exists. Resolve it before resuming.",
      );
    for (const table of ownedTables)
      if (
        core
          .prepare(`SELECT 1 FROM ${table} WHERE plugin_id='bot-teams' LIMIT 1`)
          .get()
      )
        throw new Error(
          "Unexpected Bot Teams state after interrupted preparation; nothing was overwritten.",
        );
    if (legacyRegistration(core).enabled)
      throw new Error("Disable Bots before resuming preparation.");
  } finally {
    core.close();
  }
  if (existsSync(p.target)) rmSync(p.target, { recursive: true });
  renameSync(p.backup, `${p.backup}.incomplete-${Date.now()}`);
}

/** Copy only after BB has unloaded the old plugin. All originals are backed up.
 * The new homes directory links to the existing homes: saved BB environments
 * and bot files keep their exact paths. No bot IDs, thread IDs, or message content are rewritten.
 */
export function prepareMigration(dataDir: string) {
  const plan = inspectMigration(dataDir),
    p = paths(dataDir);
  if (plan.enabled)
    throw new Error("Disable Bots through BB before preparing the migration.");
  if (existsSync(p.backup))
    throw new Error(
      `A migration backup already exists at ${p.backup}. Resume or restore that migration; do not overwrite it.`,
    );
  const core = open(p.core, false),
    data = open(join(p.legacy, "data.db"));
  let targetCreated = false,
    committed = false;
  try {
    core.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
    if (legacyRegistration(core).enabled)
      throw new Error("Bots was re-enabled during preparation.");
    for (const table of ownedTables)
      if (
        core
          .prepare(`SELECT 1 FROM ${table} WHERE plugin_id='bot-teams' LIMIT 1`)
          .get()
      )
        throw new Error(
          `Existing Bot Teams state in ${table}; refusing to overwrite it.`,
        );
    assertIdle(data);
    mkdirSync(p.backup, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(p.backup, "attempt.json"),
      JSON.stringify({ target: p.target }),
      { mode: 0o600 },
    );
    const state = Object.fromEntries(
      ownedTables.map((t) => [
        t,
        core
          .prepare(`SELECT * FROM ${t} WHERE plugin_id='bots'`)
          .all()
          .filter(
            (r) =>
              t !== "thread_plugin_metadata" ||
              plan.threadIds.includes(String(r.thread_id)),
          ),
      ]),
    );
    writeFileSync(
      join(p.backup, "host-state.json"),
      JSON.stringify(
        { registration: legacyRegistration(core), state, plan },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    data.exec(`VACUUM INTO ${quote(join(p.backup, "data.db"))}`);
    const excluded = new Set(
      ["data.db", "data.db-wal", "data.db-shm"].map((f) => join(p.legacy, f)),
    );
    cpSync(p.legacy, join(p.backup, "files"), {
      recursive: true,
      filter: (src) => !excluded.has(src),
    });
    mkdirSync(p.target, { mode: 0o700 });
    targetCreated = true;
    cpSync(join(p.backup, "data.db"), join(p.target, "data.db"));
    if (existsSync(join(p.legacy, "secrets")))
      cpSync(join(p.legacy, "secrets"), join(p.target, "secrets"), {
        recursive: true,
      });
    if (existsSync(join(p.legacy, "homes"))) {
      symlinkSync(join(p.legacy, "homes"), join(p.target, "homes"), "dir");
    }
    for (const table of ownedTables)
      for (const row of state[table]!) {
        const fields = Object.keys(row);
        core
          .prepare(
            `INSERT INTO ${table} (${fields.join(",")}) VALUES (${fields.map(() => "?").join(",")})`,
          )
          .run(
            ...fields.map((f) => (f === "plugin_id" ? "bot-teams" : row[f]!)),
          );
      }
    for (const id of plan.threadIds) {
      const result = core
        .prepare(
          "UPDATE threads SET origin_plugin_id='bot-teams' WHERE id=? AND origin_plugin_id='bots'",
        )
        .run(id);
      if (result.changes !== 1)
        throw new Error(
          "A bot thread changed during preparation; retry from the retained backup.",
        );
    }
    const copy = open(join(p.target, "data.db"));
    try {
      if (
        JSON.stringify(counts(copy)) !== JSON.stringify(plan.counts) ||
        copy.prepare("PRAGMA integrity_check").get()!.integrity_check !== "ok"
      )
        throw new Error("Copied database did not pass verification.");
    } finally {
      copy.close();
    }
    // This marker commits with the copied host state. It makes a crash between
    // COMMIT and the next CLI call resumable without copying over the target.
    core
      .prepare(
        "INSERT INTO plugin_kv(plugin_id,key,value,updated_at) VALUES ('bot-teams',?,?,?)",
      )
      .run(migrationKey, JSON.stringify(p.backup), Date.now());
    core.exec("COMMIT");
    committed = true;
    return plan;
  } catch (error) {
    if (!committed) {
      try {
        core.exec("ROLLBACK");
      } catch {}
      if (targetCreated) rmSync(p.target, { recursive: true });
    }
    throw error;
  } finally {
    data.close();
    core.close();
  }
}

export function finishMigration(
  dataDir: string,
  source: string,
  plan: ReturnType<typeof inspectMigration>,
) {
  const p = paths(dataDir);
  const core = open(p.core, false);
  try {
    core.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
    if (
      core
        .prepare("SELECT 1 FROM plugins WHERE id='bots' AND removed_at IS NULL")
        .get()
    )
      throw new Error(
        "Remove the verified legacy registration through BB before finalizing.",
      );
    for (const table of ownedTables) {
      if (table === "thread_plugin_metadata") {
        for (const id of plan.threadIds)
          core
            .prepare(
              "DELETE FROM thread_plugin_metadata WHERE plugin_id='bots' AND thread_id=?",
            )
            .run(id);
      } else core.prepare(`DELETE FROM ${table} WHERE plugin_id='bots'`).run();
    }
    core.exec("COMMIT");
  } finally {
    core.close();
  }
  // Retire the old database so installing the unrelated community Bots later
  // cannot read our frozen channel records. Existing workspaces stay at their original paths.
  for (const file of ["data.db", "data.db-wal", "data.db-shm"])
    if (existsSync(join(p.legacy, file)))
      renameSync(join(p.legacy, file), join(p.backup, `retired-${file}`));
  writeFileSync(
    join(p.backup, "complete.json"),
    JSON.stringify({ completedAt: Date.now(), source }, null, 2),
    { mode: 0o600 },
  );
}

async function main() {
  const { values } = parseArgs({
    options: {
      "data-dir": { type: "string" },
      source: { type: "string" },
      apply: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help || !values["data-dir"]) {
    console.log(
      "Usage: tsx migration.ts --data-dir /absolute/BB/data [--apply --source /absolute/bb-plugin-bot-teams]\nDry run by default. Apply backs up state, disables Bots, installs Bot Teams, verifies health, and removes the old registration.",
    );
    return;
  }
  const p = paths(values["data-dir"]);
  const bb = (args: string[]) =>
    JSON.parse(
      execFileSync(process.env.BB_CLI || "bb", args, {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      }),
    );
  if (resolve(bb(["status", "--json"]).dataDir) !== p.root)
    throw new Error("The CLI is connected to a different BB data directory.");
  if (existsSync(join(p.backup, "complete.json"))) {
    console.log("This Bot Teams migration is already complete.");
    return;
  }
  if (values.apply) recoverPreparation(p.root);
  const savedPlan = preparedMigration(p.root);
  let plan = savedPlan ?? inspectMigration(p.root);
  console.log(
    JSON.stringify(
      {
        source: plan.source,
        counts: plan.counts,
        backup: p.backup,
        prepared: !!savedPlan,
      },
      null,
      2,
    ),
  );
  if (!values.apply) return;
  if (!values.source)
    throw new Error(
      "--source is required with --apply. Build the Bot Teams package first.",
    );
  const source = resolve(values.source);
  const manifest = JSON.parse(
    readFileSync(join(source, "package.json"), "utf8"),
  );
  if (
    manifest.name !== "bb-plugin-bot-teams" ||
    manifest.bb?.name !== "Bot Teams"
  )
    throw new Error("The selected source is not Bot Teams.");
  if (!savedPlan) {
    bb(["plugin", "disable", "bots", "--json"]);
    plan = prepareMigration(p.root);
  }
  const list = () =>
    bb(["plugin", "list", "--json"]).plugins as {
      id: string;
      status: string;
      source: string;
    }[];
  let entry = list().find((v) => v.id === "bot-teams");
  if (entry && entry.source !== `path:${source}`)
    throw new Error(
      "Bot Teams is installed from another source. Nothing was replaced.",
    );
  if (entry?.status !== "running") {
    bb(["plugin", "install", source, "--yes", "--json"]);
    entry = list().find((v) => v.id === "bot-teams");
  }
  if (entry?.status !== "running")
    throw new Error(
      "Bot Teams is not healthy. The old installation remains disabled and backed up; fix startup, then rerun this command.",
    );
  const bots = new Set<string>(),
    rooms = new Set<string>();
  for (let offset = 0; ;) {
    const page = bb([
      "plugin",
      "run",
      "bot-teams",
      "list",
      "--all",
      "--offset",
      String(offset),
      "--limit",
      "100",
      "--json",
    ]);
    page.bots.forEach((b: { id: string }) => bots.add(b.id));
    page.rooms.forEach((r: { id: string }) => rooms.add(r.id));
    if (page.nextOffset === null) break;
    offset = page.nextOffset;
  }
  if (
    plan.botIds.some((id) => !bots.has(id)) ||
    plan.roomIds.some((id) => !rooms.has(id))
  )
    throw new Error(
      "The live plugin is missing migrated bots or channels. Legacy registration retained.",
    );
  if (list().some((v) => v.id === "bots"))
    bb(["plugin", "remove", "bots", "--yes", "--json"]);
  finishMigration(p.root, source, plan);
  console.log(
    "Bot Teams is healthy. Existing state was preserved; the old Bots registration is removed.",
  );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
