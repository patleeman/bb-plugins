# Attention requests QA

Validated on 22 September 2026 with installed BB Nightly `0.43.4-nightly.35446468491.1`.

## Delivered plugin behavior

Bot Teams exposes channel attention markers, `bots_channel_notify`, and the inbox CLI. Decisions and blockers open real questions through `bb.ui.requestInput`. BB's existing `interaction.pending` listener sends their phone notifications. The plugin temporarily reveals hidden work threads it owns, then restores their visibility when the question settles. FYI updates remain on their channel messages.

Answers are durably queued before the question completes. Delivery replies to the original channel message and acknowledges the matching request revision. Failed replies retry independently, show an error in the channel, and can be discarded by their own ID when not being sent. One failed or archived-channel reply cannot block other replies or questions.

No BB core or mobile change is part of this feature. The local core checkout `/Users/patrick/workingdir/bb-channel-notifications` is clean, with pre-existing commit `95742c3a6` preserved. The earlier generic notification sender experiment was reverted. Ordinary channel reply push still requires an unavailable generic enqueue API; native decision and blocker questions do not.

## Live validation

The staged application ran from the installed BB app bundle, including its unchanged built-in Push notifications plugin:

- Server: `http://127.0.0.1:19825`.
- Isolated data: `/Users/patrick/.bb-dev/workingdir-bb-channel-notifications-305c8179fdb6`.
- Fixture: paused Atlas in **Attention QA**, asking which day to release ORBIT-42.
- Source work thread: `thr_rds87ijxtn`; no agent work ran for this fixture.
- Native question screenshot: [Channel question](../assets/channel-attention-question.png), captured by `bots-attention-question` in `scripts/capture-plugin-screenshots.mjs`.
- Current channel request screenshot: [Rail QA](../assets/channel-attention.png), captured by `bots-attention` after the separate page was removed.

The installed built-in sender delivered a mobile payload to a loopback relay with `kind: pending-interaction`, the exact source thread ID, project ID, registered server URL, and channel question text. The relay returned an accepted ticket. This proves the existing sender path, not physical phone receipt.

Submitting **Friday, please.** in the real form posted one owner reply to the original channel message, acknowledged its inbox request, and returned the work thread to hidden. **Snooze 1 hour** updated the durable inbox, and reopening generated a fresh question. At 390 × 844, the form had no horizontal overflow and its answer actions measured 44 pixels high.

Earlier inbox checks passed acknowledge, history, bring back, snooze, reload persistence, and reply navigation. Reading a channel left its requests open.

## Automated validation and installation

- Bot Teams: 235 tests passed in the isolated attention commit, including native-question lifecycle, sidebar counts, transcript status, and historical mention coverage. The shared checkout also passed its 240-test suite.
- Typecheck and plugin build passed.
- Independent read-only review verified fixes for outbox failure isolation, old pending requests, revision-safe acknowledgement, concurrent discard, and archived-channel queue starvation. Final targeted review found no blocking issues.
- Production Bot Teams was rebuilt and reloaded. Its `channel-questions` service and frontend bundle are running.
- Production mobile notifications are enabled and an iPhone is registered. The production relay remains the standard Expo endpoint.

Patrick confirmed that the live phone alert worked after a production test. The test question used the normal channel notify flow; the Expo relay accepted one send. No external notification service or BB app update is needed for this implementation.

## Visible pings and missed notification investigation

The Designer reply at 22:16 on 22 September was inserted while BB loaded `/private/tmp/bb-plugins-bot-teams-redesign/packages/bb-plugin-bot-teams`. That build only captured explicit `attentionReason` messages and lacked normal `@user` detection. The server log records the temporary source from 21:43:34 until 22:19:46. It queued an ordinary reply event instead of creating an attention request. The working source was restored before this fix. The owner had already answered, so no old question was replayed.

New open requests now highlight the message and display **Needs you** with an acknowledge action. A persistent bell replaces the channel hash in the sidebar, including selected/read channels. The bell is separate from running-work and ordinary unread indicators. Historical uncaptured pings show **Mentioned you** without creating a new alert.

Live staging checks passed: selected channel keeps its bell; acknowledge removes the bell and highlight; reopen restores them; snooze clears them; quoted `@user` remains ordinary text; 390-pixel layout has no horizontal overflow. A normal `@user` message (without `attentionReason`) created the native question and produced an accepted mobile payload through the installed built-in sender.

[Staged screenshot](../assets/channel-ping-highlight.png) was captured from the running application by `bots-ping-highlight`. A bounded independent review found no blocking issue.
