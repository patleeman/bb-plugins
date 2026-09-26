---
name: smart-queue
description: Explain or troubleshoot why a message sent to a busy BB thread steered the running turn or waited as a follow-up, check Smart Queue's classifier setup, or dry-run a steer-or-follow-up decision with the bb smart-queue CLI.
---

# Smart Queue

Smart Queue classifies owner messages sent to a busy thread. It uses Jev
first, then the fallback provider model, then follow-up. It never acts on
messages sent by agents or other threads, so `bb thread tell` from inside a
thread is not classified.

## Commands

```sh
bb smart-queue status [--json]
bb smart-queue recent [--limit <n>] [--json]
bb smart-queue classify <thread-id> <message> [--json]
```

- `status` shows whether Smart Queue is on, whether Jev has a key, and which
  fallback model it uses.
- `recent` lists up to 30 decisions with the action, the classifier that
  decided (`Jev 86%`, `fallback model`, or `no classifier answered`), the
  thread, and a message preview.
- `classify` runs the classifier against a thread's current context and prints
  the decision. It does not send or queue anything. With no Jev key, it starts
  and deletes one hidden fallback-model thread.

## Settings

Change settings with `bb plugin config smart-queue set <key> <value>`:
`enabled`, `zenApiKey` (secret; ask the owner for it), `jevModel`,
`jevTimeoutMs`, `steerConfidence`, `fallbackProvider`, and `fallbackModel`.

## Troubleshooting

- `no classifier answered`: Jev has no key or failed, and the fallback model
  failed too. Read `bb plugin logs smart-queue` for the reason.
- A queued card that says *Smart Queue: follow-up after the current turn* is
  released when the thread goes idle. The owner can use the card's **Send now**
  or **Steer** button to override it.
- To stop all classification, run
  `bb plugin config smart-queue set enabled false`.
