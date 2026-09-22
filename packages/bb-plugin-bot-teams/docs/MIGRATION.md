# Bots → Bot Teams

The package is now `bb-plugin-bot-teams`, installed as `bot-teams`. The marketplace entry and `.bb/plugins.json` use the same ID. This resolves the collision with the unrelated community plugin called Bots.

The administration label is **Bot Teams**. Channels keep their own sidebar section. The CLI remains `bb bots`, agent tools remain `bots_*`, and the bundled skill remains `bots`, so saved automation scripts keep working. If another plugin registers the same CLI name, use `bb plugin run bot-teams` followed by the usual arguments.

## Existing installations

Run the migration on the BB server machine from this package directory, with Node 22.19 or newer and the package's development dependencies installed:

```sh
npm run build
node --import tsx migration.ts --data-dir /absolute/path/to/BB/data
node --import tsx migration.ts --data-dir /absolute/path/to/BB/data \
  --apply --source /absolute/path/to/packages/bb-plugin-bot-teams
```

The first command after the build is a dry run. Apply verifies the source and channel schema, refuses active work and conflicting destination state, and then:

1. Disables the legacy plugin through BB.
2. Creates a private SQLite snapshot and copies files, secrets, and the affected host rows into `<dataDir>/migrations/bots-to-bot-teams-v1`.
3. Copies the plugin database, settings, schedules, KV, and thread metadata into the new namespace. Existing bot threads retain their IDs and receive the new origin plugin ID in the same host transaction.
4. Links `plugins/bot-teams/homes` to the existing `plugins/bots/homes`. Bot profiles, BB projects, and thread environments keep their saved absolute paths.
5. Installs Bot Teams, checks its running status and bot/channel IDs through the live CLI, then removes the legacy registration. Old channel data is retained in the private backup instead of being left for the unrelated community plugin to open.

The database snapshot preserves channel messages, unread state, attachments, reactions, delegations, jobs, document revisions, and approvals. Existing automation records use stable bot/channel IDs and the unchanged CLI command. Existing channel and message links under `/plugins/bots/channels/…` redirect only when the channel belongs to this installation. New links use `/plugins/bot-teams/channels/…`.

## Recovery and backups

Preparation uses a host transaction and a commit marker. If interrupted, rerun the same apply command: incomplete preparation retains its partial backup, and committed preparation resumes without overwriting the destination. Installation or verification failures leave the old plugin disabled and backed up. Fix the reported startup problem and rerun. Completed migrations return without changing anything.

Do not uninstall either plugin manually during an incomplete migration. Preserve the entire migration backup until the new installation is verified. `host-state.json` records the original registration, all copied host rows, and original thread origins; `data.db` is the consistent plugin snapshot; `files` includes the original private files and secrets. These are local private backups and must not be committed.

After migration, back up both `plugins/bot-teams` and `plugins/bots/homes`, plus BB's normal thread and attachment storage. Do not delete the legacy homes directory: saved environments still use it.
