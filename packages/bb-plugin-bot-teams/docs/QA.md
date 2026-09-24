# Bots and Channels verification

## Channel row archive action — 2026-09-24

Removed the one-click Archive/Restore button from channel sidebar rows. Their
three-dot and right-click menus retain Archive/Restore. The row keeps one options
button on hover or keyboard focus, with no reserved space for the removed action.
The channel discovery QA script checks that row actions contain only the options
button and that an archived channel still offers Restore in its menu.

## Start channel from thread — 2026-09-23

The native thread sidebar menu now offers **Start channel from thread** after
**Copy thread link**. It uses the same channel handoff as the thread composer:
the new channel opens with an unsent, editable draft that links to its source
thread. The item appears from the row's three-dot menu and right-click menu.
ArrowDown from **Copy thread link** focuses it for keyboard selection.

Verified in the running BB app: the row menu showed the new item, selecting it
opened a channel, and its draft contained the exact source thread ID and link.
Right-click opened the same menu, and keyboard navigation focused the new item.
The disposable channel was deleted after the check. Package typecheck and build
pass.

## Channel list menu — 2026-09-23

The Channels heading now has a three-dot menu for organizing, sorting, and
switching between active and archived channels. Organize by activity groups
channels needing attention, working channels, and other channels. Sorting uses
Updated at, Created at, and Alphabetical; selecting the current sort reverses
its direction. Organize and sort choices persist locally.

Verified in the running BB app: both sort directions, organize grouping and
reload persistence, keyboard archive navigation, cross-view search, and the
390 px touch sidebar. The updated channel discovery QA script passes. Package
typecheck and build pass.
The header actions stay hidden on desktop until hover, focus, or an open menu;
the touch sidebar keeps them visible. Live style checks and the channel discovery
regression pass with this behavior.
The Channels section now uses the host thread section's 16 px inset, normal
12 px heading with 20 px line height, 28 px rows and header actions, and 13 px
row text. The hash glyph is 16 px. Live computed styles and desktop/touch
screenshots confirm the alignment; the discovery regression still passes.

## Channel workspace and reliability — 2026-09-21

Verified in the running BB application using a disposable Workbench QA bot and
channel, with existing owner bots and channels preserved.

- A plain Directed-mode message reached the only bot without a classifier call.
  The bot read the channel brief and published `release-check.csv` through the
  real `bots_publish_file` tool; the sent file appeared in Files and reference
  selection. No failed or unposted output appears in the file library.
- The exact ambiguous wording “Do not stop the current task. Why PostgreSQL
  instead of SQLite?” went through the configured classifier while the bot was
  busy. It chose a fork. The original task finished with `PRIMARY_UNCHANGED`,
  and the fork finished independently. Regression cases cover all three chat modes.
- Context drafts survived closing and reopening the workbench; Save, version
  comparisons, sent-reference selection, Files, Saved decisions, and editable
  hourly limits worked through the rendered UI. Stale saves and cross-channel
  reads/writes are covered by lifecycle tests.
- The UI created a paused weekday schedule, edited its name and cron/timezone,
  preserved the paused state, and manually ran it through the Automations plugin.
  Real responses appeared in the channel. Run history showed response completion
  and usable View response/View work actions. Live QA caught and fixed stale
  running status in open history; pending histories now reconcile on changes and
  poll while unfinished.
- Live UI testing caught strict-RPC rejection of an undefined first-page cursor.
  Context, document history, Files, and Saved decisions omit absent cursors now.
- Bot memory history displayed the old/new diff; restoring an earlier version
  loaded it into the editor and saved through the existing version check.
- Owner message editing preserved the original execution text and did not create
  another job. Channel-reference tests cover renames, colliding slugs, URL
  fragments, escaped references, Markdown links, and code blocks.
- Context fit a 390 × 844 viewport without horizontal overflow. The real capture
  asserts the report, saved reference, context values, revision differences, and
  rendered workbench instead of accepting an empty panel.
- Focused regressions cover deleted-fork recovery, cleanup despite rate limits,
  dispatching-phase tools, recursion guards, reference-file retention with ten
  current uploads, CAS revisions, artifact visibility, edited-message retry
  identity, bounded/indexed SQL, and invalidation during a shared read.
- The 148-test Bots suite, TypeScript, and plugin build passed. Independent
  backend and UI rereviews found no remaining medium-or-higher issues in scope.
- After plugin reload, context, limits, files, and restored memory persisted. All
  QA work settled; the bot was retired, channel archived, and schedule left paused.

Screenshot: [Channel workspace](../assets/channel-workbench.png).
Use `BB_CAPTURE_ONLY=bots-workbench` with a seeded Workbench QA channel.
`BB_CAPTURE_QA_ACTIONS=1` additionally exercises the draft, file, saved-message,
usage, schedule create/edit/run, and response-history flows. It deliberately runs
only a staged schedule, which stays paused. Restore and reinvite the disposable
QA bot/channel before rerunning actions after cleanup.


## Channel automations — 2026-09-20

Verified against the running BB app and its installed Automations plugin in
`Channel automations QA` with a temporary `Schedule QA` bot.

- The real bot used native tools to create and list a paused weekday schedule.
  Both channel and bot identity were inferred from its active response.
- A manual run dispatched through the existing Automations scheduler and posted
  `Scheduled channel verified: ORBIT-42.` under the bot's identity.
- An enabled one-shot timer fired without a manual run and posted
  `One-shot channel timer verified.` The schedule disabled itself afterward.
- The real channel menu/dialog exercised Resume, Pause, Run now, Delete/Cancel,
  and confirmed Delete. A UI-triggered run posted `CLI schedule verified.`
- Archive rejected a manual channel run; restore and plugin reload retained
  schedules and history. Test schedules were paused after verification.
- Live capture found that manual dispatches have a status without `lastRunAt`.
  The dialog now displays that status without requiring a scheduled-run timestamp.
  The capture asserts the real saved task, bot, timezone, state, and dispatch result.
- Nine regression tests cover inferred identity, membership/ownership,
  idempotent create and delivery, current context, overlapping work, one-shot CLI
  input, inactive targets, recursive schedules, retry provenance, and a run that
  expires while waiting for the channel lock, plus bounded run history.
- Read-only review caught lost automation provenance on retry and stale dispatch
  authorization after waiting for a lock. Both fixes passed regression tests and
  rereview. The full Bots suite has 101 passing tests, including concurrent channel
  title work, hostile-message isolation, restart-worker reuse, stale-worker selection,
  and the manual-rename race. Typecheck and build pass.

Screenshot: [Channel automations](../assets/channel-automations.png).
Capture with `BB_CAPTURE_ONLY=bots-automations`; restore the QA channel if archived.
`BB_CAPTURE_QA_ACTIONS=1` additionally exercises UI actions against a seeded paused
`CLI daily check` schedule and verifies the dialog at 390 × 844. It deletes that
disposable schedule after requesting a manual run.
`BB_CAPTURE_QA_LAYOUT=1` checks responsive layout without rerunning actions;
`BB_CAPTURE_QA_HISTORY=1` verifies the saved manual dispatch inside the dialog.
Live QA caught an unsupported cross-plugin navigation link; Run history now uses
the Automations RPC and displays bounded, paginated history within the channel.

Verified in the running BB application on 2026-09-20 using isolated QA Echo,
QA Review, and a QA channel. Existing owner bots and channels were preserved.

## Baseline

- New channel opens directly into an empty, focused composer.
- The first message in a blank channel is sent to a hidden, short title task;
  its result updates the sidebar and header without adding a second chat message.
  The task receives the first message as untrusted JSON data and has no Bots
  tools. A manual rename wins if it happens before the title task finishes, and
  startup recovery retries a title if BB restarts and reuses an in-flight hidden
  worker instead of spawning a duplicate.
- Header rename updates the sidebar and channel; membership uses stacked avatars,
  a member menu, and Add bot at the bottom.
- Mention search lists existing bots and Create new bot; sending a mention invites
  its recipient. The real agent returned the requested readiness sentence.
- Two real bots worked concurrently, read a local attachment, and independently
  returned its verification code. Replies appeared as they completed.
- Individual Stop cancelled the selected host response and removed its work stub;
  the channel remained usable.
- Reply prefills the bot mention and preserves the parent reference. Hover actions
  and keyboard focus expose the message toolbar. Emoji search found an otter,
  persisted a reaction, and CLI removal removed it.
- Sent attachment download matched the uploaded file byte for byte.
- CLI creation, profile edits, mission pause/resume, memory reads/writes, channel
  invites/removal, pin/unpin, archive/restore, history, activity and job lookup
  exercised the same service as the UI. Focused CLI tests cover argument validation,
  deletion confirmation, file handling, pagination, stale document versions, and
  request retry identity.
- Profile and memory drafts survived navigation and reload. Pause/resume did not
  invalidate a dirty profile. A newer CLI document edit preserved the old draft
  and disabled stale Save. Reload asks before discarding that draft.
- Collection search/filter/sort, profile controls, bounded document editors,
  full emoji categories/skin tones/keyboard selection, channel title placement,
  and native composer spacing are asserted by the live capture script.
- Full workspace typecheck, build, and existing test suites passed. The Bots
  baseline has 60 tests, including cancellation retry, unresolved dispatch cleanup,
  thread pagination recovery, stale thread removal, and stale profile saves.

Actual microphone recording and transcription are environment-dependent and were
not exercised end to end. The recorder error path is guarded against sending
partial audio; availability follows BB's voice configuration.

## Screenshots

The capture script drives the real BB UI with deterministic demo conversations.
Published images use BB's collapsed sidebar to omit unrelated local project names.

## Completion features

- A separate 215-message channel was seeded through the real CLI. Initial loading
  showed 200 messages plus Load earlier; search found the first message, selection
  loaded the missing page and focused it, and an old reply retained its reference.
- Retirement and restoration worked through both UI and CLI. Retirement removed
  channel membership; restoration kept mission work paused and required reinviting.
- A temporary bot using an invalid model produced a real failed response. View work
  opened its native BB thread. After correcting its model, Retry produced
  `RECOVERY VERIFIED.` without repeating the owner's message.
- Added focused tests for stable history cursors, literal search, cross-channel
  cursor rejection, old reply parents, retirement preservation/cleanup, filtered
  CLI commands, and idempotent response retry.
- Independent runtime and UI reviewers found no remaining major issues after fixes.

The completed suite has **67 passing tests**. Final typecheck and build pass.
The UI attachment input and removal flow, create-from-mention with draft preservation,
activity dialog, and confirmed channel deletion were also exercised live. Temporary
QA channels were deleted and QA bots retired after testing.

At a 390 × 844 viewport the channel header, composer, and populated search dialog
fit without horizontal overflow; the search dialog remains fully visible.

## Council replacement

- Migrated Grug, Architect, and Designer with full original personas and exact
  provider, model, and reasoning settings. Their schedules remain off. Verified
  the migration twice: no duplicate bots or channels. The private backup retains
  all 14 previous sessions, member configuration, and Council settings.
- All three answered a real, bounded channel-design question through their
  configured providers. Live QA found that bot spawning did not mark provider
  selections explicit; fixed it and verified both Pi members and Codex Architect.
  Dispatch failures now retain their original error instead of hiding the cause.
- Architect used native tools to discover Quinn, create a new channel, send a brief,
  read it, and check request status. Quinn replied in that channel. The test channel
  was archived afterward; the migrated Council channel remains available.
- Verified agent attribution and work links in the live transcript, compact member
  stack/menu, all three real advisor responses, and the Council channel in the sidebar.
- Removed Council from the installed application, package tree, collection manifest,
  dependency lockfile, and screenshot definitions. Its history backup remains local.
- Added regression coverage for tool discovery, forged identity rejection, safe send
  and create retries, channel membership access, creator membership, per-caller
  reactions, cross-channel limits, bounded mention fan-out, errors/PASS/cancellation,
  retry status, and bot CLI ownership of private documents and work.
- Independent read-only review completed with no remaining major findings after
  the CLI ownership fix. The expanded suite has **75 passing tests**.

## Smart responses and inline images

Verified on 2026-09-20 in `Chat polish QA` with Atlas and a temporary QA Channel
Guide. The QA bot has no scheduled work; existing bot profiles and missions were
preserved.

- Smart selected Atlas alone for a fact-check question and selected nobody for
  “Thanks, that is all.” Atlas answered in one sentence.
- Directed was selected in the live menu and persisted through the CLI. An ordinary
  message produced no jobs. Replying to QA Channel Guide without an @mention
  targeted that bot alone. Switching back to Smart restored the new-channel default.
- Temporarily made the primary routing provider unavailable. The configured Codex
  fallback selected QA Channel Guide for a grammar question; it answered concisely.
  Restored the primary Pi provider afterward. Hidden routing sessions were cleaned up.
- A real clipboard paste containing PNG bytes and text showed a loaded draft preview,
  kept the caption, and sent an inline image. Expansion opened the original with a
  Download action. A real bot called `bots_publish_image`; its final response contained
  the image and caption together, without a second channel message. Both displayed
  at the original 2:1 aspect ratio.
- The bot used `bots_react` to add 👍 and finished with `[PASS]`. The reaction appeared
  with the bot's name, with no public text reply. A later reply correctly recognized
  the shared image as four color swatches.
- Added regression coverage for Directed/reply/@all routing, asynchronous Smart
  subset/silence, idempotent sends, failure/retry, archive/delete cancellation,
  provider-specific reasoning/permissions and fallback cleanup, byte-based media
  classification, workspace containment, image-only replies, and default settings.
- Independent review caught workspace containment, deletion cancellation, and
  host-specific provider lookup issues; all were fixed. **85 Bots tests pass**,
  along with full workspace typecheck, test suites, and build.

Live screenshots: [inline images](../assets/channel-images.png) and
[chat mode beneath the composer](../assets/channel-behavior.png). Restore the archived QA channel
before rerunning `BB_CAPTURE_ONLY=bots-images,bots-behavior` captures. Its bot is
retired after verification, with workspace and history preserved.


## Channel notifications — 2026-09-21

Tested the Bots workspace together with BB source branch `bots/channel-notifications` in `/Users/patrick/workingdir/bb-channel-notifications` (based on upstream `97c376b33`). The isolated normal `pnpm dev` application ran at `http://localhost:11825`, API `http://127.0.0.1:19825`; no production notification preferences or push subscriptions were changed.

Seeded a disposable Notification QA bot/channel with deterministic public reply data. Captured the browser Notification constructor in the headless QA page: the real Bots outbox → cross-plugin RPC → shared sender → realtime overlay produced one notification with the channel/bot title and reply text. Invoking its click handler opened the exact channel permalink and focused the reply, shown in `assets/channel-notifications.jpg`. A second reply marked read before delivery produced zero notifications. This verifies browser delivery/navigation, not physical OS banners or actual phone delivery.

Regression coverage checks owner/system exclusions, attachment-only replies, duplicate insertion, read/archive/removal/retirement, timestamp ordering, terminal errors superseded by retries, pending input read/answer suppression, durable source recovery, settings fanout, mobile server selection, live/cold-start taps, and invalid link rejection. The shared sender reuses the regular thread Expo and desktop/web transport. BB’s reserved built-in plugin and the mobile client require a BB build to deploy these source changes.


## Implicit delegation returns — 2026-09-21

Focused runtime tests use the real SQLite store and SDK fake host. They cover a single delegate without a return mention; fan-out waiting for all delegates; mixed success/failure/cancellation; queued and nested timeouts; unrelated replies; classifier-rejected acknowledgments; explicit ancestor mentions; synthesis loop prevention; cross-channel reply targeting and multi-message aggregation; classifier outages/restart; archive races; delegate retry ancestry, renewed deadlines, and stale classifier results; requester retry and cancellation during classification; and nested A → B → C synthesis. The existing three-step handoff-depth regression remains covered. Classifier decisions are deterministic fixtures in these tests; live model judgment is not a deterministic guarantee.

Final verification: **173 Bots tests**, **35 shared notification tests**, and **318 mobile tests** pass. All three typechecks pass, and the Bots plugin and shared notification bundle build successfully. Independent review verified the delegation retry, ancestor, cross-channel, and nested timeout fixes. The screenshot and README link checks and both worktrees' `git diff --check` pass.

## Jev classifier — 2026-09-21

Replaced the default temporary agent classifier with OpenCode Zen's direct
`jev-1.13` System One API. The existing OpenCode credential was verified against
the endpoint, then saved through BB's settings API as a Bots secret. No credential
was written into source or printed. Provider sessions remain an explicit setting.

Ten live API checks took **380–647 ms** (median **505 ms**). Fixtures covered the
PostgreSQL/SQLite comparison, negated stop, a real correction, ambiguous follow-up,
thanks, one relevant expert, two requested experts, a substantive return,
acknowledgment-only return, and a failed delegate. The comparison and negated stop
did not steer; the explicit correction did. A separate mixed busy/idle recipient
check verified the one-option decision for an idle, explicitly addressed bot.

The normal running BB server classified a disposable two-bot channel message in
**399 ms**, recording a completed routing decision with zero responses and zero
classifier agent sessions. Its native HTTP path used the configured secret. The
channel was archived and both QA bots retired afterward. Two retained earlier
provider-route durations were 9,774 and 14,547 ms; these are historical samples,
not a matched benchmark or a latency guarantee.

**181 Bots tests**, typecheck, and plugin build pass. New tests cover one-request
batching, required recipients, idle actions, confidence fallback, malformed
answers, HTTP failures without secret disclosure or provider fallback, caller
cancellation, deadlines, settings validation, and delegation return predicates.
Independent review found no remaining blocker. Bots was reloaded with
`routingEngine=jev`, the default five-second deadline, and confidence threshold
0.7. These measurements check representative cases, not all possible model errors.


## Compact channel activity — 2026-09-21

Replaced the stacked active-response card with one line: small avatar, bot name,
truncated activity, and an accessible stop icon. Removed the repeated task title
and inline View work buttons. Queue reasons and stopping state replace stale
activity; raw `[PASS]` control markers are suppressed.

Verified in the running BB application with a disposable bot performing a bounded
wait: the row is 32 px high at 1280 px desktop width and 40 px high at a 390 px
touch viewport. Long activity text truncates, the stop target remains 36 × 36 px
on touch screens, and the page has no horizontal overflow. Clicking Stop cancelled
the real response and removed its row. The QA channel was archived and the bot
retired after verification. [Mobile screenshot](../assets/channel-status-mobile.jpg).

All **183 Bots tests**, typecheck, and build pass. Focused regressions cover silence
markers and stale activity during queueing, dispatch, and cancellation.

## Channel reading width — 2026-09-21

Matched the running regular thread's 760 px outer column: channel messages and
the composer are centered, with 728 px inside the standard gutters. The transcript
scrollbar remains at the pane edge. Verified the actual Command Center channel at
1728 px desktop width, 390 px touch width, and 1280 px with Channel context open.
Mobile messages and composer both use the available 358 px inside 16 px gutters.
The side panel reduces the column naturally; neither the page nor transcript
overflows horizontally. The CSS bundle builds, was reloaded, and `git diff --check`
passes. No new logic tests were added for this CSS-only layout change.

## Markdown file editor — 2026-09-21

Replaced the Mission and Memory textareas with CodeMirror: Markdown highlighting,
line numbers, wrapping, formatting controls, find and replace, undo/redo, and an
Edit/Preview switch using BB's Markdown renderer. The existing save, draft,
conflict, reload confirmation, and version-history flows remain connected.

Verified in the running BB application using a paused disposable QA bot:

- Editing, keyboard save, persisted reload, search/replace, formatting, and
  undo/redo across Edit/Preview switches.
- Draft recovery after switching to Mission and returning to Memory.
- Restoring a saved version and undoing that restoration.
- Concurrent file changes reject stale saves and preserve the local draft.
- Reload offers Keep editing or Discard and reload.
- A 64,001-character paste shows the limit, disables saving, and remains undoable.
  The exact immediate-paste-after-reload regression now restores the saved
  baseline with one Undo, without restoring the discarded draft.
- Desktop at 1440 px and touch layouts at 390 and 320 px, including search and
  preview. No horizontal overflow; editor height remains stable between modes.
  Mobile Reload and Save stay on one row.

QA caught unsupported host glyph names, an italic action that could strip bold,
and undo events merging formatting/reloads with adjacent edits. These are fixed.
Six focused regressions cover formatting selections, placeholders, nested
emphasis, line boundaries, link destinations, read-only state, and undo isolation.
All **189 Bots tests**, typecheck, build, and focused independent review pass.
Bots was reloaded and the disposable bot retired after verification.

[Desktop editor](../assets/bot-markdown-editor.jpg) ·
[Mobile preview](../assets/bot-markdown-preview-mobile.jpg)

## Channel message alignment — 2026-09-21

Owner messages now use right-aligned bubbles with the same surface, border,
radius, and desktop width as regular thread messages. Timestamps sit above the
bubble; the redundant user avatar and visible You label are removed. Bot and
external BB agent messages retain left alignment, names, and avatars. Reply
references and attachments remain inside the message; reactions remain beneath it.

Verified the existing Command Center conversation in the running BB app at
1440 px desktop width and 390/320 px touch widths. All owner messages reach the
right edge of their column, bot avatars remain present, and neither the page nor
message content overflows horizontally. The mobile message menu remains usable
from keyboard focus. Typecheck, plugin build, and `git diff --check` pass; Bots
was reloaded. No new logic tests were added for this presentation change.

## Sidebar channel activity — 2026-09-21

Added the host's Loading glyph beside channels with unfinished work. The list
RPC returns active channel IDs from indexed queries over routing runs and jobs;
it does not load per-channel history. Activity includes queueing, dispatch,
execution, and pending host cancellation. Multiple replies keep one indicator
until all work settles. The sidebar reconciles on reconnect, focus, visibility,
and visible polling in addition to realtime changes.

Verified in the running BB app with a disposable channel and bounded bot waits:
the spinner appears while another page is open, remains in the selected channel,
and clears after both natural completion and confirmed cancellation. A long
channel name truncates while the 15 × 15 px glyph remains visible on desktop and
in the 390 px mobile sidebar; no horizontal overflow. Reduced-motion styling
keeps the glyph visible without rotation.

Independent review caught a stale CSS selector adding padding to the new icon
and a status assertion masked by a second running job. Both were fixed and the
focused rereview was clean. Four new tests cover routing-only work, individual
job states, multiple responses, terminal states, pending cancellation, channel
isolation, and active work older than a page of completed history. All **193
Bots tests**, typecheck, and build pass. Bots was reloaded; the disposable channel
was archived and the bot retired after QA.

[Live sidebar activity](../assets/channel-sidebar-activity.jpg)

## Copy channel ID — 2026-09-21

Added Copy channel ID to the sidebar context menu, between Rename and Archive.
Verified an actual right-click and clipboard read in the running application:
the copied value exactly matches the selected channel's ID. Keyboard context-menu
activation also works. Injected clipboard denial produces a visible error instead
of an unhandled rejection. Typecheck, plugin build, and `git diff --check` pass;
Bots was reloaded. No new unit test was added for this small clipboard action.

## Channel hover controls — 2026-09-21

Channel rows now reveal Archive and a three-dot menu on hover or keyboard focus,
matching the thread sidebar. Both menu entry points use the same Radix context
menu and action handlers. Navigation and action buttons are siblings. The idle
status indicator gives way to the controls while hovered, and long titles truncate.
Touch layouts keep a 36 px menu button visible and put Archive inside the menu.

Verified in the running app with the disposable sidebar QA channel: idle/hover
visibility, quick archive and restore without navigation, right-click and ellipsis
menu parity, exact clipboard contents, Tab/Enter and Shift-F10 activation, and
Escape focus restoration. At 390 px, an actual touch tap opens the menu, Rename
opens its dialog, all menu options fit onscreen, and the page has no horizontal
overflow. Typecheck, build, and focused independent review pass. Bots was reloaded
and the QA channel archived afterward. No new unit test was added for this UI change.

[Live channel hover controls](../assets/channel-hover-controls.jpg)

## Portable message links — 2026-09-22

Copy message link now copies a readable Markdown reference with a relative BB
route, preserving the message ID without embedding the desktop's localhost URL.
A plugin overlay routes ordinary channel-link clicks through BB navigation,
including existing localhost links and host-rewritten port variants for channels
known to this server. Other servers, modified clicks, downloads, malformed links,
and credentials in URLs retain their normal handling.

Reproduced the old absolute clipboard value in the running app. Verified copied
references, legacy links from another desktop port, and portable links in a
disposable channel on desktop and a 390 px touch viewport. Navigation retains the
same document and makes no external-window calls. Six focused regressions cover
Markdown escaping, encoded return-job IDs, origin boundaries, localhost rewrite,
malformed routes, and uppercase channel IDs. The integrated 200-test suite,
typecheck, build, and focused review pass. Concurrent bot-creation changes were
excluded from this fix's commit.

## Bot Teams rename — 22 September 2026

- Renamed the package and installed identity to `bb-plugin-bot-teams` / `bot-teams`, with matching marketplace and collection entries. Preserved the scoped `bots` administration panel, CLI/tool names, and draft/event keys.
- Ran the owner migration on the local BB installation after confirming no active bot work. Verified all 27 bot IDs, 18 channels, 82 conversations, 419 messages, 266 jobs, 4 reactions, 17 attachments, 230 runs, and 5 approval records survived. All 100 thread metadata records and nonsecret settings matched the private snapshot. Legacy workspace paths still resolve through the new homes symlink.
- The predecessor registration was removed after the new plugin reported running and the live CLI returned the migrated bots and channels. The private backup remains in `<dataDir>/migrations/bots-to-bot-teams-v1`.
- Real BB UI showed Bot Teams in navigation and its administration header. Desktop and touch/mobile (390 × 844) navigation from the owner's legacy channel/message URL resolved to the new route, focused the exact `return:job:…` message, and showed no horizontal overflow.
- This check found and fixed a pre-existing double-encoding bug: `toPluginPanel` encodes subpath segments itself, so the link parser now supplies the decoded message ID. The same colon-containing message was visible and focused after the fix.
- Regenerated `assets/staged-preview.png` through `scripts/capture-plugin-screenshots.mjs` using `BB_CAPTURE_ONLY=bot-teams`; the real UI was filtered to the staged Atlas bot. The capture restored Atlas's prior retired state.
- Final verification: **210 tests pass**, package typecheck/build pass, and the independent migration review is clean.
- Migration tests cover state preservation, metadata scope, existing workspace databases, active/pending/stopping refusals, destination conflicts, publisher mismatch, interrupted preparation, and repeated finalization. Marketplace validation uses BB's current schema and checks all 17 index entries against package identity, display metadata, source directories, and local icons.

## Channel header spacing — 22 September 2026

- Corrected two host-header selectors left on the old `bots` identity. In the live 1600 px BB window, the trailing gap after the channel controls fell from 905 px to the expected 36 px beside the panel toggle.
- At widths of 480 px and below, the member button shows a bot icon and count. Desktop keeps the avatar stack; the accessible label and member list stay intact.
- Verified the installed build at 1600 px, with the right panel open, and at 390 px and 320 px touch widths. Checked an eight-member channel and an empty archived channel, with no overlapping header buttons or horizontal overflow. Search, options, and the eight-member popover open correctly.
- Added live capture assertions for right alignment and nonoverlapping controls. Package typecheck/build, capture-script syntax, marketplace schema/index checks, and the focused read-only review pass.

## Lazy channel transcripts — 22 September 2026

- Initial history is 50 messages; adjacent pages load on scroll, and the mounted window never exceeds 150 messages. Evicted messages, reply parents, and reactions leave client state. Indexed rowid cursors preserve order even when timestamps match or new messages arrive.
- Old links and search results fetch a 50-message window around their target, including near either end, instead of loading intervening history. Historical polling refreshes the visible window and its reactions. Sending or choosing **Jump to latest** supersedes pending history requests.
- Seeded a separate, empty-member **Transcript paging QA** channel with 1,200 variable-height messages and reactions. Real BB desktop and 390 px touch UI checks covered repeated paging in both directions, the 150-row cap, zero measured scroll-anchor drift, a one-request jump to message 100, and returning to latest.
- Held real history responses in the browser to reproduce sending and jumping to latest during an outstanding page request. In both cases, latest content appeared immediately and another page could load before releasing the superseded response. Late responses did not replace the current window.
- Repeat the browser regression with an open Browser Automation session and the staged fixture described in `scripts/qa-bot-teams-transcript.mjs`: `BB_TRANSCRIPT_QA_SESSION=<session> BB_TRANSCRIPT_QA_CHANNEL=<fixture-uuid> node scripts/qa-bot-teams-transcript.mjs`. The script refuses channels with bots, another name, or an archived state; it sends only to the empty test channel. Restore the archived fixture before rerunning.
- All **213 tests**, package typecheck/build, and focused read-only review pass. New regressions cover bounded bidirectional windows, associated-data eviction, direct seeks, cross-channel/hidden/missing cursor rejection, historical refreshes, reactions, and indexed query plans.

## Native channel workbench — 22 September 2026

Context, files, saved decisions, activity, automations, and usage each have a
labeled native tab. A lifecycle-managed content script reveals BB’s existing
tab labels because BB currently replaces every plugin tab icon with the same
branding icon. BB retains tab selection, resizing, splits, and the mobile drawer.

The live UI regression verifies all six tabs, opening with Show right panel,
a channel menu containing only management actions, selection when closing/reopening
the panel, local context drafts, channel
switching, the 390px mobile layout, and saved-message and automation-response
navigation, including jumps to the message already in the URL. A simulated
completed automation run checks drawer dismissal without
creating a schedule or dispatching bot work. Current BB
resets these fixed tabs to the first tab on a full page reload.

```sh
BB_WORKBENCH_QA_SESSION=<browser-automation-session> \
BB_WORKBENCH_QA_ORIGIN=http://127.0.0.1:38886 \
node scripts/qa-bot-teams-workbench.mjs
```

The script creates two temporary channels without member bots, seeds a release
brief and saved decision, then deletes its fixtures. It never requests bot work.
Set `BB_WORKBENCH_QA_CAPTURE=1` and the normal `BB_CAPTURE_PROJECT_ID` /
`BB_CAPTURE_THREAD_ID` variables to run the `bots-native-tabs` capture definition.
The README screenshot shows that ORBIT-42 brief and saved decision in the full
BB UI with six labeled workbench tabs.

Plugin build, TypeScript checks, marketplace schema/index checks, and focused
read-only review passed.


## Bot creation through a thread

- All creation entry points use BB’s native new-thread composer: the collection,
  the channel member picker, and the composer’s mention picker.
- Live capture `bots-creation` checks the prefilled instructions, focus, direct
  links, reload, mobile width, channel invitation context, and return to the
  unchanged channel draft. Standalone and channel setup drafts use separate keys.
- A simulated failed submission keeps the draft, shows the error, and enables
  retry. The capture does not dispatch an agent or create a bot.
- `test/bot-creation.test.ts` checks that the setup RPC forwards the selected
  provider, model, permissions, environment, prompt, and attachments. It also
  checks dispatch proceeds without managed-bot registration and propagates failure.
- The saved screenshot is `assets/bot-creation-thread.png`.

## Channel archive discovery — 22 September 2026

Replaced the hidden Channels-heading toggle with an archive icon beside search.
In the archived view, a list icon returns to active channels.
The heading shows Channels or Archived channels, and the button has a matching
tooltip, accessible action label, and pressed state. Searching includes both
active and archived channels and labels archived results. Clearing or closing
search restores the selected view; toggling the archive view clears the query.

Verified in the running BB app at 1440 px desktop and 390 px touch widths:
keyboard activation, both view directions, searching from either view, mixed-case
and padded queries, no matches, whitespace and closing search, archived result
Restore/Delete actions, delete cancellation, and the empty archive state. The
mobile regression waits for the host drawer overlay to stop covering the button
before tapping. Temporary bot-free channels are deleted after each run.

Repeat with `BB_CHANNEL_QA_SESSION=<browser-automation session> node
scripts/qa-bot-teams-channel-discovery.mjs`. Package typecheck/build, the focused
read-only review, marketplace schema/index checks, and `git diff --check` passed.
