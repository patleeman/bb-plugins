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
bb smart-queue check [--json]
bb smart-queue fallback [thread | off | <provider-id> <model> [<reasoning-level>]] [--json]
```

- `status` shows whether Smart Queue is on, the Jev providers it will try in
  order, configuration problems, and the fallback model.
- `recent` lists up to 30 decisions with the action, the classifier that
  decided and through which provider (`Jev 86% via TypeSafe`,
  `fallback model via pi/…`, or `no classifier answered`), the
  thread, and a message preview.
- `classify` runs the classifier against a thread's current context and prints
  the decision. It does not send or queue anything. With no Jev provider, it
  starts and deletes one hidden fallback-model thread.
- `check` sends a fixed sample message to Jev and reports which provider
  answered and how long it took. It never reads a thread.
- `fallback` shows or sets the model used when no Jev provider answers:
  `thread` (the busy thread's provider and default model), `off`, or a provider
  ID and model from `bb provider models`, with an optional reasoning level.

## Settings

Change settings with `bb plugin config smart-queue set <key> <value>`.

- `jevProvider`: `auto` (default), `typesafe`, `vercel`, `openrouter`,
  `opencode-zen`, or `custom`. `auto` tries each configured provider in that
  order and moves on when one fails.
- Provider keys are secrets: `typesafeApiKey`, `vercelApiKey`,
  `openRouterApiKey`, `zenApiKey`, and `customJevApiKey`. Ask the owner for
  them; never print them. Environment fallbacks are `TYPESAFE_API_KEY`,
  `AI_GATEWAY_API_KEY`, `OPENROUTER_API_KEY`, and `OPENCODE_API_KEY`.
- `typesafeModel`: `jev-latest` (default), `jev-preview`, or `jev-1.13.0`.
- A custom provider needs `customJevEndpoint` (full HTTPS URL of a System One
  endpoint, or HTTP on localhost) and `customJevModel`.
- `jevTimeoutMs`, `steerConfidence`, and `enabled`.
- The fallback model is not a `bb plugin config` setting. Use
  `bb smart-queue fallback`, or the picker on the settings page.

Run `bb smart-queue status` after a change. It lists the Jev routes in order
and any configuration problems.

## Troubleshooting

- `no classifier answered`: no Jev provider answered, and the fallback model
  failed too. Read `bb plugin logs smart-queue` for the reason.
- A queued card that says *Smart Queue: follow-up after the current turn* is
  released when the thread goes idle. The owner can use the card's **Send now**
  or **Steer** button to override it.
- To stop all classification, run
  `bb plugin config smart-queue set enabled false`.
