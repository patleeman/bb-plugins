import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { Store } from "../store";
import {
  inspectMigration,
  prepareMigration,
  preparedMigration,
  recoverPreparation,
  finishMigration,
} from "../migration";

function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "bot-teams-migration-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const legacy = join(root, "plugins", "bots");
  mkdirSync(join(legacy, "homes", "bot_test"), { recursive: true });
  mkdirSync(join(legacy, "secrets"));
  writeFileSync(
    join(legacy, "homes", "bot_test", "MEMORY.md"),
    "Keep this memory.\n",
  );
  writeFileSync(
    join(legacy, "homes", "bot_test", "data.db"),
    "workspace database",
  );
  writeFileSync(join(legacy, "secrets", "zenApiKey"), "synthetic-key", {
    mode: 0o600,
  });
  const db = new Database(join(legacy, "data.db"));
  new Store(db);
  db.prepare("INSERT INTO bots VALUES (?,?)").run(
    "bot_test",
    JSON.stringify({
      id: "bot_test",
      projectId: "proj_test",
      home: join(legacy, "homes", "bot_test"),
    }),
  );
  db.prepare("INSERT INTO rooms VALUES (?,?)").run(
    "room_test",
    JSON.stringify({ id: "room_test", name: "My channel" }),
  );
  db.prepare("INSERT INTO conversations VALUES (?,?,?,?,?)").run(
    "c1",
    "bot_test",
    "group:room_test",
    "thr_test",
    JSON.stringify({ id: "c1", threadId: "thr_test" }),
  );
  db.prepare("INSERT INTO room_messages VALUES (?,?,?)").run(
    "message_test",
    "room_test",
    JSON.stringify({ id: "message_test", text: "Keep this reply" }),
  );
  db.close();
  const core = new DatabaseSync(join(root, "bb.db"));
  core.exec(`CREATE TABLE plugins(id TEXT PRIMARY KEY, source TEXT, enabled INTEGER, removed_at INTEGER);
    INSERT INTO plugins VALUES ('bots','path:/repo/packages/bb-plugin-bots',0,NULL);
    CREATE TABLE threads(id TEXT PRIMARY KEY,project_id TEXT,status TEXT,origin_plugin_id TEXT);
    INSERT INTO threads VALUES ('thr_test','proj_test','idle','bots'),('unrelated','other_project','idle','bots');
    CREATE TABLE plugin_kv(plugin_id TEXT,key TEXT,value TEXT,updated_at INTEGER,PRIMARY KEY(plugin_id,key));
    CREATE TABLE plugin_settings(plugin_id TEXT,key TEXT,value TEXT,updated_at INTEGER,PRIMARY KEY(plugin_id,key));
    CREATE TABLE plugin_schedules(plugin_id TEXT,name TEXT,cron TEXT,next_run_at INTEGER,PRIMARY KEY(plugin_id,name));
    CREATE TABLE thread_plugin_metadata(thread_id TEXT,plugin_id TEXT,metadata_json TEXT,PRIMARY KEY(thread_id,plugin_id));
    INSERT INTO plugin_kv VALUES('bots','projectId','"proj_test"',1);
    INSERT INTO plugin_settings VALUES('bots','jevModel','"jev-1.13"',1);
    INSERT INTO plugin_settings VALUES('unrelated','setting','"leave alone"',1);
    INSERT INTO plugin_schedules VALUES('bots','mission','0 * * * *',123);
    INSERT INTO thread_plugin_metadata VALUES('thr_test','bots','{"botId":"bot_test","conversationKey":"group:room_test"}'),('unrelated','bots','{"leave":"alone"}');`);
  core.close();
  return { root, legacy };
}

test("migration preserves IDs, private files, settings, schedules, metadata, and existing workspace paths", (t) => {
  const { root, legacy } = setup(t);
  const plan = inspectMigration(root);
  assert.equal(
    existsSync(join(root, "plugins", "bot-teams")),
    false,
    "dry run does not create target storage",
  );
  assert.equal(plan.counts.room_messages, 1);
  prepareMigration(root);
  assert.deepEqual(
    preparedMigration(root),
    plan,
    "committed state can resume without a separate phase-file write",
  );
  recoverPreparation(root);
  const target = join(root, "plugins", "bot-teams");
  assert.equal(
    realpathSync(join(target, "homes")),
    realpathSync(join(legacy, "homes")),
  );
  assert.equal(
    readFileSync(join(target, "homes", "bot_test", "MEMORY.md"), "utf8"),
    "Keep this memory.\n",
  );
  assert.equal(
    readFileSync(join(target, "secrets", "zenApiKey"), "utf8"),
    "synthetic-key",
  );
  const core = new DatabaseSync(join(root, "bb.db"));
  try {
    assert.equal(
      core
        .prepare(
          "SELECT value FROM plugin_settings WHERE plugin_id='bot-teams'",
        )
        .get()!.value,
      '"jev-1.13"',
    );
    assert.equal(
      core
        .prepare(
          "SELECT next_run_at FROM plugin_schedules WHERE plugin_id='bot-teams'",
        )
        .get()!.next_run_at,
      123,
    );
    assert.equal(
      core
        .prepare(
          "SELECT metadata_json FROM thread_plugin_metadata WHERE plugin_id='bot-teams'",
        )
        .get()!.metadata_json,
      '{"botId":"bot_test","conversationKey":"group:room_test"}',
    );
    assert.equal(
      core
        .prepare("SELECT origin_plugin_id FROM threads WHERE id='thr_test'")
        .get()!.origin_plugin_id,
      "bot-teams",
    );
    assert.equal(
      core
        .prepare("SELECT origin_plugin_id FROM threads WHERE id='unrelated'")
        .get()!.origin_plugin_id,
      "bots",
    );
    assert.equal(
      core
        .prepare(
          "SELECT count(*) AS n FROM thread_plugin_metadata WHERE plugin_id='bot-teams'",
        )
        .get()!.n,
      1,
    );
    assert.equal(
      core
        .prepare(
          "SELECT value FROM plugin_settings WHERE plugin_id='unrelated'",
        )
        .get()!.value,
      '"leave alone"',
    );
  } finally {
    core.close();
  }
  const data = new DatabaseSync(join(target, "data.db"));
  try {
    assert.equal(
      data.prepare("SELECT id FROM room_messages").get()!.id,
      "message_test",
    );
    assert.equal(
      JSON.parse(String(data.prepare("SELECT json FROM bots").get()!.json))
        .home,
      join(legacy, "homes", "bot_test"),
    );
  } finally {
    data.close();
  }
  assert.ok(existsSync(join(plan.backup, "host-state.json")));
  assert.ok(
    existsSync(join(plan.backup, "files", "homes", "bot_test", "MEMORY.md")),
  );
  assert.equal(
    readFileSync(
      join(plan.backup, "files", "homes", "bot_test", "data.db"),
      "utf8",
    ),
    "workspace database",
  );
  assert.throws(() => prepareMigration(root), /already has/);
});

test("interrupted preparation resumes without overwriting original data", (t) => {
  const { root, legacy } = setup(t);
  const { backup } = inspectMigration(root);
  mkdirSync(backup, { recursive: true });
  writeFileSync(join(backup, "attempt.json"), "{}");
  mkdirSync(join(root, "plugins", "bot-teams"));
  writeFileSync(join(root, "plugins", "bot-teams", "data.db"), "partial copy");
  recoverPreparation(root);
  assert.equal(existsSync(join(root, "plugins", "bot-teams")), false);
  prepareMigration(root);
  assert.equal(
    readFileSync(join(legacy, "homes", "bot_test", "MEMORY.md"), "utf8"),
    "Keep this memory.\n",
  );
});

test("pending and stopping core threads block migration even when no channel job is running", (t) => {
  const { root } = setup(t);
  const core = new DatabaseSync(join(root, "bb.db"));
  try {
    for (const status of ["pending", "starting", "active", "stopping"]) {
      core
        .prepare("UPDATE threads SET status=? WHERE id='thr_test'")
        .run(status);
      assert.throws(() => inspectMigration(root), /thread is still active/);
    }
  } finally {
    core.close();
  }
});

test("finalization resumes after removal and retains private backups and unrelated metadata", (t) => {
  const { root, legacy } = setup(t);
  const plan = prepareMigration(root);
  assert.throws(
    () => finishMigration(root, "/new/source", plan),
    /Remove the verified legacy registration/,
  );
  const core = new DatabaseSync(join(root, "bb.db"));
  try {
    core.exec("DELETE FROM plugins WHERE id='bots'");
  } finally {
    core.close();
  }
  finishMigration(root, "/new/source", plan);
  finishMigration(root, "/new/source", plan);
  assert.equal(existsSync(join(legacy, "data.db")), false);
  assert.ok(existsSync(join(plan.backup, "retired-data.db")));
  assert.ok(existsSync(join(plan.backup, "complete.json")));
  assert.equal(
    readFileSync(join(legacy, "homes", "bot_test", "MEMORY.md"), "utf8"),
    "Keep this memory.\n",
  );
  const result = new DatabaseSync(join(root, "bb.db"));
  try {
    assert.equal(
      result
        .prepare("SELECT count(*) AS n FROM plugin_kv WHERE plugin_id='bots'")
        .get()!.n,
      0,
    );
    assert.equal(
      result
        .prepare(
          "SELECT count(*) AS n FROM thread_plugin_metadata WHERE plugin_id='bot-teams'",
        )
        .get()!.n,
      1,
    );
    assert.equal(
      result
        .prepare(
          "SELECT metadata_json FROM thread_plugin_metadata WHERE plugin_id='bots'",
        )
        .get()!.metadata_json,
      '{"leave":"alone"}',
    );
  } finally {
    result.close();
  }
});

test("migration refuses live dispatch and preserves source on refusal", (t) => {
  const { root, legacy } = setup(t);
  const db = new DatabaseSync(join(legacy, "data.db"));
  db.prepare("INSERT INTO jobs VALUES (?,?,?,?,?)").run(
    "j",
    "bot_test",
    "running",
    1,
    JSON.stringify({ id: "j" }),
  );
  db.close();
  assert.throws(() => prepareMigration(root), /Finish active/);
  assert.equal(existsSync(join(root, "plugins", "bot-teams")), false);
  assert.ok(existsSync(join(legacy, "homes", "bot_test", "MEMORY.md")));
});

test("migration refuses a loaded source, a conflicting destination, and another publisher", (t) => {
  const { root } = setup(t);
  const core = new DatabaseSync(join(root, "bb.db"));
  try {
    core.exec("UPDATE plugins SET enabled=1 WHERE id='bots'");
    assert.throws(() => prepareMigration(root), /Disable Bots/);
    core.exec(
      "UPDATE plugins SET enabled=0 WHERE id='bots'; INSERT INTO plugin_kv VALUES('bot-teams','projectId','\"existing\"',1)",
    );
    assert.throws(() => prepareMigration(root), /Existing Bot Teams state/);
    core.exec(
      "DELETE FROM plugin_kv WHERE plugin_id='bot-teams'; UPDATE plugins SET source='git:https://github.com/prakashchokalingam/bb-plugin-bots.git' WHERE id='bots'",
    );
    assert.throws(() => inspectMigration(root), /not Patrick's/);
    assert.equal(existsSync(join(root, "plugins", "bot-teams")), false);
  } finally {
    core.close();
  }
});
