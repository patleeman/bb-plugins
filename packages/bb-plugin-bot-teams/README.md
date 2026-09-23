# Bot Teams

Persistent bots with their own files, mission, and memory, and Slack-style channels in BB’s sidebar. Inspired by [Hermes Bot Mode](https://hermes-agent.nousresearch.com/docs/user-guide/bot-mode).

## Use

1. Choose **New channel** in the sidebar to open an empty conversation with the composer ready. It starts with just you. After the first message, an agent privately suggests a short channel title; click its name at the left of the header to rename it at any time.
2. Type `@` to find a bot or choose `@all` / `@channel` to address everyone in the channel. Sending a mention invites that bot into the channel. The picker also includes **Create new bot…**, which opens a new thread with bot setup instructions prefilled. Describe what you need in chat; the agent creates the bot and invites it to this channel. Your channel draft stays saved.
3. Click the overlapping avatars in the header to see members and their activity. **Add bot** sits at the bottom; member options let you configure or remove a bot.
4. Open **Bot Teams** to administer profiles, `MISSION.md`, `MEMORY.md`, and activity. The collection uses BB's standard content width, search toolbar, status filter, sorting, and bordered rows. Shared conversations live in Channels. Each bot also has a DM you can open from its channel.

**New bot** in the collection opens the same conversation flow without a channel invitation. Send the prefilled instructions, or add your bot’s purpose first. The agent handles the name, mission, model, and permissions using sensible defaults.

Bot configuration uses the same centered content width, compact settings rows,
and native controls. Mission and memory use a Markdown editor with syntax
highlighting, line numbers, formatting controls, find and replace, undo/redo,
and a rendered preview. Use ⌘S / Ctrl+S to save. The editor adapts to the viewport
and shows unsaved/saved state. Reloading with unsaved edits asks before
discarding them. Profile, mission, and memory drafts survive navigation and reloads on the same device. Profile and document saves reject stale versions instead of overwriting newer edits. Interrupted host cancellation stays visible and retries automatically.

Your channel messages appear in right-aligned bubbles, like regular threads.
Bot and BB agent messages stay left-aligned with their names and avatars.

Channels open with the latest 50 messages. Scrolling toward either end loads
another page while preserving your reading position. At most 150 messages and
their reactions stay mounted; the rest remain available in history. Message
links and search results load a page around the target directly. **Jump to
latest** returns from older history, and sending a message brings your new post
into view.
Channels with unfinished work show the same loading glyph as running threads
in the sidebar, including while routing or stopping. It clears when all work
settles; unread replies keep the usual unread indicator.
Hover a channel for quick **Archive** and **⋯** actions, like regular threads.
The three-dot button opens the same menu as right-click, including **Copy channel
ID**. On touch screens, the menu button stays visible; Archive is inside the menu.

The **Chat mode** selector beneath the message box has three choices:

- **Smart** chooses the smallest relevant set of bots for an unaddressed message, including none for acknowledgments and finished conversations. New channels start here.
- **Directed** calls bots you mention or reply to. A channel with just one eligible bot always routes to that bot, in every chat mode.
- **Everyone** lets all members consider unaddressed messages, useful for group reviews.

`@handle` and replies to a bot address that bot in the channel; they are channel messages, not DMs. `@all` and `@channel` address every current channel member (`@everyone` is also supported). Choosing a mode in the UI or owner CLI remembers it for future channels. Existing channels keep Everyone until changed. Bots work concurrently and post as they finish. A bot can request a teammate’s help with an explicit mention, with up to two further handoffs per message. `[PASS]` produces no public reply unless the bot has published images for that response.

Channels do not need to be started or resumed. A working bot appears at the bottom of the transcript with its latest safe one-line activity and a muted **Stop** control for its current response. Stopping a response leaves the channel open. Each primary session handles one task at a time. Forks answer separate requests concurrently, with their own activity and Stop controls. Mentions choose the recipient; they do not imply an interruption.

Hover or focus a message on desktop for **React**, **Reply**, **Copy**, and a link to its bot DM or source thread when available. Right-click, use Shift+F10, or long-press to open the unified message menu with **Reply**, **Add selected text to chat**, **Emoji**, **Copy**, and that same link. The full emoji picker supports text search, category browsing, skin tones, recently used emoji, and keyboard selection. It uses [Emoji Picker React](https://github.com/ealush/emoji-picker-react) with native emoji and BB’s theme colors. Emoji reactions persist, show who reacted, and toggle when clicked. Bots can use `bots_react` to acknowledge a message without writing another response. Reactions do not start more work. Replies link back to their original message.

Bots receive standing guidance to write brief, conversational replies, use Markdown when it improves scanning, avoid dense walls of text and assistant boilerplate, and stay silent when they have nothing useful to add. Channel messages use BB’s native Markdown renderer, including short paragraphs, bullets, numbered steps, inline code, fenced code blocks, and links. They can react sparingly for acknowledgment (👍), completed or verified work (✅), or celebration (🎉). Questions and assignments addressed to a bot in the channel still need an answer, action, or blocker.

Smart routing uses **Jev** through OpenCode Zen's direct structured-decision API. **Plugins → Bot Teams → Settings** controls the classifier, secret Zen API key, Jev model (default `jev-1.13`), timeout (default 5 seconds), and minimum confidence for steer/fork (default 0.7). `OPENCODE_API_KEY` on the BB server is an alternative to the secret setting. Recipient and action decisions are batched into one API request, without creating an agent session or loading tools and global instructions. Low-confidence steer/fork decisions become follow-ups. Delegation return decisions use the same API.

For provider-based classification, select **providers** explicitly. Its primary/fallback settings default to Pi / `opencode-go/qwen3.8-flash`, then Codex / `gpt-5.6-luna`. This slower compatibility option creates temporary hidden agent sessions; each attempt can take up to 30 seconds. Jev failures never silently switch to an agent session. They keep the message visible with **Retry routing**, and delegation returns retry without waking the requester twice.

Explicit modes with addressed recipients bypass action classification. Single-bot channels skip recipient selection; busy Auto messages still classify the action in every channel mode. No keyword checks infer correction intent. See [OpenCode's Jev documentation](https://opencode.ai/docs/zen/#jev) for its endpoint and model availability.

When Auto routes to a busy bot, a small label beside the sent message's timestamp shows the applied action. Hover or focus it to see which bot the classifier selected and whether Bot Teams changed the suggestion before dispatch. Explicit send modes have no classifier label.

The composer uses BB’s native surface, spacing, and button conventions. Type `#` to find another channel; choosing one inserts a stable channel reference that renders as a link in the transcript. It supports attachments through the plus button, paste, and drag and drop (10 files per message, 8 MB each). Dictation uses BB’s configured transcription service and microphone preference. Message text, attachment references, and replies survive reloads. Unsent uploads expire after seven days.

PNG, JPEG, GIF, and WebP images appear as composer previews and inline in sent messages, including images pasted with text. Click an image to expand it and download the original. Other file types stay downloadable. Image bytes are checked before inline display; SVG and HTML remain downloads. Bots use `bots_publish_image` (or `bb bots publish-image`) with an absolute path inside their workspace to add up to ten images to their current final response. This publishes one message containing text and images, or images alone with `[PASS]`; cancelled or failed responses do not post images.

Use the archive button beside search to switch between active and archived channels. The icon changes to a list in the archived view, and the heading shows the current view. Search finds channels in both views and labels archived results. Clearing or closing search returns to the selected view. Right-click a channel for **Rename**, **Archive**, or **Delete**; archived channels offer **Restore** and **Delete**. Keyboard users can open this menu with Shift+F10. The channel menu in the header contains rename, pin, archive, and delete actions. **Automations** and **Activity** open as separate tabs in BB’s right workbench. Archiving cancels unfinished work and preserves history; restoring makes the channel available again. Deletion requires confirmation, stops unfinished responses, and permanently removes channel messages, reactions, membership, activity, and draft uploads. Bot profiles, workspaces, and other channels are kept. Existing bot DMs and sent files in BB's project storage remain under BB's own retention. Removing a bot cancels its pending channel work and preserves its messages and reactions. Channels support up to 16 bots.

BB’s **Settings → Appearance** can select sidebar providers. **Channels and threads** preserves BB’s normal thread list below Channels; **Channels navigation** adds New channel alongside New thread.
Selecting a channel shows its bot DMs directly beneath it in the sidebar. Selecting another channel shows that channel’s DMs instead.

## Channel workspace

Activity, automations, and usage have separate
tabs in BB’s right workbench. Use **Show right panel** to open the workbench. The labeled tabs share its
resize, collapse, and split controls with Browser and Terminal. On compact screens, BB opens them in
its workbench drawer.

- There is no shared channel context. Each bot keeps its own `MISSION.md`,
  `MEMORY.md`, and one DM per channel, which already holds that
  channel's history.
- **Version history** compares and restores `MISSION.md` and `MEMORY.md`. Restore loads a draft before saving. Bot documents are snapshotted
  when read/saved and after completed bot turns, not on every filesystem write.
- Files stay in the transcript. Bots can use `bots_publish_file` or
  `bb bots publish-file` to attach reports, CSVs, PDFs, and images from their
  workspace (8 MB each); failed responses do not publish their outputs.
- Message menus offer **Copy message link**, and **Edit message** for your own
  posts. Editing changes the transcript; already queued or running work keeps the
  original task. Record settled choices in **Context → Decisions**, which every bot
  in the channel reads.
- Channel links store the channel ID, so renaming a channel keeps links working.
  Plain `#name` references resolve only when unambiguous and outside Markdown
  code, existing links, images, and URL fragments.
- Activity shows each task, queue position or blocking reason, and **Open DM**.
  Reading marks messages seen only while the channel is focused and at the bottom.

## Channel rail

The rail floats over the transcript's right gutter as its own card and answers
"what is true in this channel right now". It is only as tall as it needs to
be, so a quiet channel leaves almost nothing on screen. The workbench tabs
stay for what is configured and what already happened; the rail holds live
state.

- **Live now** lists each working bot with its elapsed time, current activity,
  anything queued behind it, and a **Stop** button. It also shows the routing
  step, so the gap between sending a message and a bot appearing is visible
  rather than silent.
- **Needs you** collects the channel's open decisions and the requests a bot is
  blocked on, so they can be answered without leaving the channel.
- **DMs** lists the bot DMs for this channel. Click to open
  one, or ⌘-click (drag) to open it in a split.
- **Members** shows every bot in the channel, labelled only when it is doing
  something: working, queued, needs attention or paused. Idle is the resting
  case and goes unsaid.
- The soonest scheduled run counts down on its own row and can be paused.
- **Output** collects the files bots published here.
- **Usage** appears only once the day's turns are worth a glance, or something
  failed.

The rail reads as text at rest. Nothing is counted while you can see the rows
themselves, a count appears only on a section you have collapsed, and the
carets, the **Stop**, **Pause** and **Add a bot** controls stay invisible until
you hover the row or section that owns them. Long lists stop at four entries
behind a **View all**. Sections with nothing to report are hidden entirely, and
each one collapses and remembers its state per device.

Use the header's **Show channel details** control to hide or show the rail;
while it is hidden, that control carries a dot when the channel has live work.
The rail takes no column out of the channel: on a wide channel it lands in
empty gutter. As the channel narrows the transcript and composer shift left to
stay clear of it, and the card gives up its own width before it gives up
theirs. It stays put wherever it fits, including alongside BB's right
workbench, and stands down only below roughly 440px, where a readable
transcript leaves no room for it.

## Parallel questions and tasks

Use the composer’s **Send mode** menu for the next message:

- **Auto**: the router chooses relevant bots when needed and decides
  whether a busy session needs a steer, follow-up, or fork. A quick independent
  question can fork; a correction steers; dependent or ambiguous work follows up.
- **Steer**: change the task currently running. Also available as `/steer`.
- **Follow-up**: wait for the current task to finish. Also `/followup` or `/queue`.
- **Fork**: clone the selected bot’s available session context and handle the
  message separately. Also `/fork @handle Your question` or **Ask separately**
  in a bot message’s context menu.

Explicit modes override the router. In every chat mode, Auto uses the classifier
to choose the action for a busy recipient; ambiguous messages follow up.
The router still selects recipients for unaddressed messages in Smart channels;
mention a bot to bypass that selection when using an explicit mode.

A fork’s answer appears in the channel, linked to the question and labeled
**Fork**. Reply to that answer to continue the same fork. Ordinary channel
messages continue the primary session. The primary picks up public fork answers
through later channel context; private provider histories are not merged.

Forks require an existing session and a provider that supports native forks.
BB chooses the available fork point; it may precede the currently running turn.
An unsupported or failed fork shows an error and never silently interrupts the
primary. Two forks per bot may run concurrently by default; further forks wait.
Usage settings can change this limit. The shared hourly and daily turn limits and BB’s provider/concurrency limits still apply.

Forks share the bot’s workspace. They receive instructions to handle only their
new request and leave shared `MEMORY.md` updates to the primary session, reporting
useful findings in their answer. This is agent guidance, not filesystem isolation.
Avoid assigning simultaneous edits to the same files.

CLI and agent tools accept the same override:

```sh
bb bots channel send 'Launch room' --text '@atlas Why SQLite?' --mode fork --json
```

The `bots_channel_send` tool accepts `sendMode: "auto" | "steer" | "followup" | "fork"`.
Send mode is part of retry identity. Reuse a request ID only with the same content,
attachments, reply target, and mode. Smart classification includes the selected
session’s current task, and a delayed decision cannot steer a replacement task.

## Channel automations

Ask a bot: “Every weekday at 9am New York time, summarize the open questions in
this channel.” The bot can create a recurring schedule or a one-time reminder
for itself. Each run reads the latest channel context, mission, and memory, and
posts its answer in the same channel using its current model and permissions.

Open the **Automations** workbench tab to create or edit a task with weekday, daily,
hourly, one-time, or custom schedules. New schedules start paused unless enabled.
Review tasks, pause/resume schedules, run them now, view run history, or delete them. Native tools infer the active bot and channel; top-level agents supply
both IDs. Bots can manage only their own schedules in channels they belong to.

The existing **Automations** plugin must be enabled. It stores these schedules
in the Bots project and runs a fixed dispatcher script. Automation history
shows dispatch status alongside the actual response status, errors, and links to
the channel answer and bot DM. Retries are reflected in the response status. Pausing or deleting a schedule affects
future runs. Stop an existing response in Activity.

A tick is skipped while that automation's previous response or handoffs remain
unfinished. Archived/deleted channels and retired/removed bots do not wake;
their schedules remain available in Automations for inspection or cleanup.
Scheduled responses and retries cannot create or restart more scheduled work.
The [Bots skill](skills/bots/SKILL.md#channel-automations) documents the tools
and CLI commands.

## Mission work

Channels always respond to explicit messages. Separately, a bot’s mission work can be paused from its administration page. New bots start with scheduled mission work paused. **Wake now** asks for one bounded step toward the mission. Schedules are off by default and do not replay missed intervals after downtime. Pausing mission work does not disable channel replies.

**Retire bot** stops its current work, removes it from every channel, and keeps its profile, files, and history. Use the collection’s **Retired** filter to find it. **Restore bot** makes it available for invitations again, with scheduled mission work paused.

Failed channel responses show **Open DM** and **Retry response**. Retrying keeps the original message and targets only that bot; repeated clicks do not start duplicate retries. A long response gets a wrap-up request at 75% of its time limit (15 minutes at the 20-minute default), asking the bot to stop new work, save its state, and report progress. If it reaches the limit without finishing, Bot Teams stops the response, posts the last recorded progress in the channel, and preserves its bot DM and workspace. **Resume response** continues in that same DM. For an important checkpoint or blocker before then, bots can use `bots_channel_notify`; it leaves a durable channel message and notifies the owner without waking other bots. Restore and invite a removed bot before retrying.

Default limits are 100 started turns per hour, 1,000 per day, 20 minutes per turn, and two concurrent forks per bot. **Usage and limits** in the channel workbench and the bot’s **Usage** tab make these editable. Both bot and channel turn budgets apply; existing work can finish while new work waits. Provider billing and token details remain in the bot DM. BB’s provider and concurrency limits also apply.

## Persistence

Each bot lives at `<BB data directory>/plugins/bot-teams/homes/<bot-id>/`:

- `MISSION.md`: the owner’s standing direction, read every turn.
- `MEMORY.md`: durable facts, decisions, and unfinished work.
- `AGENTS.md`: workspace instructions.
- `files/`: working files.

**Profile → Workspace** shows the exact path. Document saves detect stale editor versions. Profiles, channel history, reactions, membership, work, and draft uploads live in the plugin’s SQLite database. Sent attachments use BB’s project attachment storage. Back up `plugins/bot-teams` along with BB’s conversation and attachment storage. Migrated installations also retain `plugins/bots/homes`; the new homes path links to it so saved workspace paths stay valid.

Each bot has a DM for each channel, backed by a hidden BB thread. Channel tasks also run in that thread. The first turn receives bounded channel history and saved context. Later turns receive the new request, unseen channel messages, and saved context only when it changes. Previously delivered files are not attached again. Forks have separate DMs and reply histories. **Open DM** shows the native conversation with its messages, tools, approvals, and failures. Typing there sends a DM to the bot; typing in the channel composer sends a channel message. A DM reply stays in the DM unless the bot also posts an answer to the channel. In that case, the channel shows a short tombstone linking to the DM, followed by the answer. The DM text stays in the BB thread. Existing group conversations appear as Channels without losing history; old group links redirect to their channel. Existing private work sessions remain stored and accessible through BB, while the Bot Teams page is for configuration.

Channels initially load 200 messages. **Load earlier messages** pages through the retained transcript. **Search channel** searches all stored message text and names; selecting a result or an older reply reference loads and focuses its message. This is a single-owner local feature. Bots use BB’s configured providers, credentials, tools, and skills on the primary machine. Separate directories provide persistent storage, not separate accounts. Shared `MEMORY.md` should contain only information appropriate for every channel the bot joins.

## CLI

The `bb bots` CLI covers profiles, mission and memory, channel membership and
settings, messages and replies, emoji reactions, attachments, transcription,
activity, and stopping individual responses. It uses the same operations and
validation as the UI.

```sh
bb bots create Atlas --mission 'Verify facts and cite sources.' --json
bb bots channel create 'Launch room' --bot @atlas --behavior smart --json
bb bots channel behavior 'Launch room' directed --json
bb bots channel send 'Launch room' --text '@atlas Review this brief.' --attach ./brief.pdf --json
bb bots channel messages 'Launch room' --json
bb bots channel search 'Launch room' 'decision' --json
bb bots retire @atlas --json
bb bots list --retired --json
bb bots restore @atlas --json
bb bots retry <job-id> --json
bb bots activity --channel 'Launch room' --json
bb bots --help
```

Use IDs, `@handles`, or unique bot names; channels accept IDs or names. Every
command supports `--json`. Files use the invoking thread's machine; outside a
thread, specify `--machine HOST_ID` and absolute paths. Partial profile updates
preserve omitted fields, document writes support version checks, and message
retries support `--request-id`.

Delete a channel with `bb bots channel delete <channel> --yes`. Omit `--yes`
to see the confirmation requirement without changing anything. Use `channel archive`
instead when you want to keep its history.

See the [Bots CLI skill](skills/bots/SKILL.md) for the full command guide,
pagination, safe retries, and file handling. BB agents can discover the skill
and command metadata directly.

## Agent consultations

Channels replace the Council plugin. Any BB agent can discover advisors, create a
channel, invite bots, post a brief, collect replies and failures, ask follow-ups,
and react through native tools: `bots_channels`, `bots_channel_create`,
`bots_channel_invite`, `bots_channel_send`, `bots_channel_read`,
`bots_channel_request`, `bots_channel_react`, `bots_channel_behavior`, and `bots_channel_retry_routing`. Channel bots also receive `bots_react`, `bots_publish_image`, and `bots_publish_file`. The bundled skill teaches this
workflow, including requests to “ask the council.”

Messages sent from BB threads show the calling bot or **BB agent**, with a link
to its work. Identity comes from the session. Standalone CLI calls still represent
the owner. Native tools and CLI sends bind safe retries to the sender as well as
the message. Channel creation accepts `--request-id UUID` for safe retries too.

```sh
bb bots channel create 'Design review' --bot @grug --bot @architect --bot @designer --json
bb bots channel send 'Design review' --text '@all Assess this proposal independently: ...' --json
bb bots channel request 'Design review' MESSAGE_ID --json
bb bots channel send 'Design review' --text '@grug Summarize the findings and dissent.' --json
```

Request status includes pending work, per-bot replies, errors, cancellations,
retry relationships, and completion. Previews over 4,000 characters are marked;
read full messages through history. Completed work does not imply consensus.
The requesting agent synthesizes the advice, or asks a selected bot to do so.
There are no formal voting rounds.

Persistent bot tools require membership in the target channel, and creating a
channel joins its bot creator automatically. The bot’s final answer posts to its
current channel, so duplicate tool sends there are rejected. Cross-channel
requests exclude their sender and allow three sends per work session. Handoffs
stay within two hops; a request stops adding replies at 32 responses and reports
that limit. These rules prevent runaway consultation loops.

Bots may also run `bb bots create`, but creation is approval-gated. The request
appears in **Plugins → Bot Teams** under **Pending bot approvals**, where the owner
can review the requested profile and mission and approve or deny it. The
workspace and profile are created only after approval; denying, cancelling, or
letting the request expire leaves no partial bot behind.

### Migrate from Council

On the BB server machine, with Bots installed:

```sh
node scripts/migrate-council-to-bots.mjs --data-dir /absolute/path/to/BB/data
node scripts/migrate-council-to-bots.mjs --data-dir /absolute/path/to/BB/data --apply
```

The first command previews the migration. Apply backs up the complete Council
SQLite database and settings under `plugins/bot-teams/imports/council-v1`, disables
Council, imports every member’s exact persona and configured provider/model/
reasoning, and creates Council and preset channels. Chief advisors retain a
synthesis role in their mission; disabled members are retired. Schedules remain
off. Imported IDs are recorded for safe reruns; conflicting profiles are never
overwritten. Private personas and session history are not committed to Git.

Finish running Council sessions first. If a member inherits execution settings,
set its effective provider, model, and reasoning explicitly in Council before
migrating; the script refuses to guess. It also verifies the CLI connects to the
specified data directory. After verifying the new bots and channel, run
`bb plugin remove council`. Existing legacy sessions remain in the private backup;
they are not converted into new conversations or rerun.

## Rename an existing Bots installation

Bot Teams uses the unique plugin ID `bot-teams`, separate from the community plugin named Bots. Existing `bb bots` commands, `bots_*` tools, and the `bots` skill keep their names for saved automations. If another plugin also registers the command, use `bb plugin run bot-teams …`.

See [the migration guide](docs/MIGRATION.md) before replacing an existing installation. New installations need no migration.

## Install and develop

```sh
pnpm install
pnpm --filter bb-plugin-bot-teams typecheck
pnpm --filter bb-plugin-bot-teams test
bb plugin build packages/bb-plugin-bot-teams
bb plugin install ./packages/bb-plugin-bot-teams --yes
```

Rebuild and run `bb plugin reload bot-teams` after changes. Inspect state with `bb bots list --json`.

## Staged preview

![Bot creation through a prefilled BB thread](assets/bot-creation-thread.png)

The running BB app shows the setup instructions in its standard new-thread composer.

![Bot Teams in the running BB application](assets/staged-preview.png)

The renamed Bot Teams collection in BB, filtered to the staged Atlas research
bot. Atlas has mission schedules off; the capture restores its prior retirement
state afterward.

![The floating channel rail beside a staged channel transcript](assets/channel-rail.png)

The running BB application shows the rail floating over the staged Rail QA
channel's right gutter:
an open decision under **Needs you**, the bot DM, the member roster
with its live state, a scheduled digest counting down, the published
`rail-check.csv`, and the channel's turns used today. Live now is absent here
because no bot is working at capture time.

![Channel context and six native workbench tabs](assets/channel-workbench.png)

The running BB application shows a staged ORBIT-42 release brief and saved
SQLite decision, with six labeled tabs in the native right workbench. The
capture uses temporary channels with no member bots and removes them afterward.
The UI regression also checks drafts, channel switching, reopening the panel,
and the 390-pixel layout. See [verification notes](docs/QA.md).

![Parallel questions and send modes](assets/channel-forks.png)

The running BB channel shows a real native fork’s `SIDE_ANSWER`, linked to its
question and labeled Fork, alongside the Send mode menu. The staged primary
session continued its timing task while this answer was produced.


The channel Automations dialog shows a bot-created weekday brief and a one-time
QA task, their saved schedules, and the real replies posted by scheduled work.
Both schedules are paused after verification.

![Channel automations and their replies](assets/channel-automations.png)

The Bots collection in the running BB application, with Atlas, Quinn, Relay, and Scribe, using BB's standard collection layout and search controls.

![Bots collection in BB](assets/bots-collection.png)

Atlas's profile shows the native settings layout.

![Bot profile settings in BB](assets/bot-profile.png)

A disposable QA bot's memory in the running application, with staged working
agreements and next steps in the Markdown editor.

![Bot Markdown editor in BB](assets/bot-markdown-editor.jpg)

The running BB application with Atlas and Scribe in **Launch room**, including real readiness replies and answers about a shared brief. The capture verifies the clickable channel title at the left of the header, sidebar Channels, bot identities, the shared file, reactions, the avatar member menu, and BB-style composer controls.

![Channels and the member menu in the running BB application](assets/staged-preview.png)

The full reaction picker, captured after verifying category coverage and keyboard search for an emoji outside the old palette.

![Full searchable emoji picker in BB](assets/emoji-picker.png)

```sh
BB_CAPTURE_ONLY=bots,bots-emoji,bots-collection,bots-profile,bots-memory \
BB_CAPTURE_PROJECT_ID=proj_... \
BB_CAPTURE_THREAD_ID=thr_... \
node scripts/capture-plugin-screenshots.mjs
```

See [verification notes](docs/QA.md) for test coverage and live walkthrough results.

![Search across channel history in the running BB app](assets/channel-search.png)

The search preview shows both demo bots’ replies to the staged launch brief.

The migrated Council channel, with live replies from Grug, Architect, and Designer
and the compact membership menu. Their original model and reasoning choices are retained.

![Council advisors consulting through a BB channel](assets/channel-consultation.png)

The image workflow and chat mode selector below were captured in the running app after a user pasted an image and a real bot published the same local preview through its tool.

![Inline owner and bot images in a BB channel](assets/channel-images.png)

![Chat mode selector beneath the composer](assets/channel-behavior.png)


## Notifications

Decisions and blockers use real BB questions and the existing built-in phone notification sender. Enable **Attention notifications** in **Settings → Bot Teams** and mobile delivery in **Settings → Push notifications**. See **Attention requests** below for the complete flow.

Ordinary channel replies and failures use a separate, optional shared notification API (`notifications.enqueue`). The installed BB build does not expose this API, so those events do not produce channel push alerts. This limitation does not affect the native decision and blocker questions.


## Permissions

A bot carries a permission mode from its profile: **Accept Edits** (sandboxed, asks you before anything more), **Auto** (sandboxed, and the provider reviews on its own), or **Full Access** (no sandbox, no approvals). New bots default to Auto, so a bot working outside its own workspace is refused automatically and never asks.

The channel composer's footer carries the same control BB puts under a thread composer. It reads the channel's setting, or what its bots agree on, or **Mixed**, and turns amber on Full Access. Opening it gives two levels:

- **All bots in this channel** sets one mode for work started here, overriding each member's own. This is the lever for a work session: open the gate, get the task done, set it back to **Each bot's own**. A bot whose provider cannot offer that mode keeps its own.
- **Each bot** shows one row per member with BB's own picker bound to that bot's provider, because a channel can hold bots on different providers. A change here follows the bot into every channel, and is disabled while the channel setting applies.

The channel's setting rides every dispatch, so it reaches long-lived bot DMs too. It takes effect on the bot's next turn, not the one already running, and it does not retry an action that was already refused. Mission work runs outside any channel and always uses the bot's own mode.

Only the owner can change a channel's permissions. Bots have no tool for it, and the CLI refuses when a bot calls it.

- `bb bots channel permissions CHANNEL` — read the current setting
- `bb bots channel permissions CHANNEL full` — set one mode for every bot here
- `bb bots channel permissions CHANNEL each` — go back to each bot's own

## Approvals in the channel

When a bot's DM stops for an approval, the request is forwarded to the channel that started the work, so you do not have to find the DM. A card appears below the transcript: the bot, what it wants (the command, the file change, the permission, the plan, or the tool), and the provider's reason. **Approve**, **Approve for session**, and **Deny** answer the real request in the DM; only the decisions the provider offers are shown. A single multiple-choice question shows one button per choice. Anything else shows **Open DM** alone, so nothing is answered blind. A handled card collapses to a one-line result.

While a bot waits, its row in the queue shelf reads **Needs approval** in amber with a **Review** button that jumps to the card. The channel's sidebar row shows the bell, and so does that bot's nested DM row.

Channel decisions and blockers that Bot Teams itself opens are not forwarded here. Answer them in the bot DM or use the controls on the channel message, described below. Answering is restricted to a bot that is still working in that channel, so a settled or reassigned request is refused with an explanation rather than resolved.

## Delegation returns

When a bot directly asks another bot for work through a mention or reply, Bots records the handoff. After every direct delegate settles, the requester receives one synthesis turn with each result, failure, cancellation, or timeout. Separate consultation messages from the same response join one return. Nested handoffs finish their own synthesis first; retries retain their ancestry and renew the wait deadline.

The configured classifier decides whether the exchange contains a work request and substantive results. Acknowledgments and unrelated replies do not wake the requester. Return turns use the existing maximum handoff depth and cannot start another delegation. Cross-channel consultations return to the requesting bot’s original channel and session. The state and deterministic return ID survive reloads. No new tool or CLI command is required: native channel send, `bb bots channel send --reply-to`, and final-answer mentions all use the same runtime.

## Attention requests

Decisions, blockers, and important updates appear on their channel messages and in the channel details rail. Each request stays open until you acknowledge it. Reading its channel does not dismiss it. Use the channel composer to reply, or open the native question in the bot DM. The question also offers **Snooze 1 hour**. The CLI supports other durations from 1 minute to 30 days.

Open requests highlight their channel message in amber with **Needs you**, **Acknowledge**, and **Snooze 1 hour** actions. Snoozed and acknowledged messages offer **Bring back**. A bell replaces the channel’s sidebar hash while requests need attention, including when the channel is selected or working. Reading the channel does not clear the bell; acknowledge or snooze does. Historical pings from builds without attention capture show **Mentioned you** without sending old alerts.

Bots can mention `@user` in a final response to request a decision. Mentions inside code, quotes, or links do not create requests. For an immediate alert with a specific reason, use `bots_channel_notify` with `channelId`, `requestId`, `reason` (`decision`, `blocker`, or `update`), and `text`. It posts one marked channel message with the caller's identity and does not wake other bots. Reuse the request ID when retrying, and do not repeat the alert in the final answer.

In **Settings → Bot Teams**, **Attention notifications** controls these alerts and **Ordinary reply notifications** controls other replies. Both default to on. Delivery also respects **Settings → Push notifications**. Requests remain on their channel messages when push delivery is disabled. Archived channels hide their requests until restored; deleting a channel deletes its requests.

- `bb bots inbox [--status open|snoozed|acknowledged] [--limit N] [--offset N]`
- `bb bots attention MESSAGE_ID acknowledge`
- `bb bots attention MESSAGE_ID snooze --minutes 60`
- `bb bots attention MESSAGE_ID reopen`
- `bb bots channel notify CHANNEL --reason blocker --text "The release needs your decision." --request-id UUID`

The notify command runs from an agent or bot thread. Request management belongs to the owner. The plugin RPC methods `attentionList` and `attentionUpdate` expose the same operations.

Decisions and blockers open a real BB question in the bot DM. Its hidden BB thread becomes visible while the question is open, then returns to hidden. BB's built-in sender sends its normal phone alert; tapping it opens the question. **Send reply** posts your answer back to the original channel message and acknowledges the request. **Acknowledge** and **Snooze 1 hour** are also available. FYI updates remain on their channel messages without creating a question.

Questions wait behind existing input requests. Each question lasts up to 1 hour. Dismissal, timeout, or plugin reload leaves the channel request open without repeating the same alert. Snooze or `bb bots attention MESSAGE_ID reopen` creates a fresh reminder. Requests without an available source thread remain on their channel messages. BB's normal notification settings and read suppression still apply.

Answers persist before delivery. If sending fails, the channel shows the error while delivery retries. You can discard that failed reply when it is not being sent. The feature uses the public Plugin SDK and works with the installed BB build; no core or mobile update is required.

![A real channel question in the staged BB application](assets/channel-attention-question.png)

The live capture shows Atlas asking for the ORBIT-42 release date, with reply, acknowledge, and snooze actions.

![Attention request in a channel in the staged BB application](assets/channel-attention.png)

The live capture shows a marked decision about the channel rail in the seeded Rail QA channel.

![Highlighted owner ping and channel attention bell](assets/channel-ping-highlight.png)

The staged channel shows an open ORBIT-42 request and a quoted `@user` example that does not trigger attention.
