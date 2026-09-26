Send a message to a busy thread without choosing between steer and queue.

## What you get

- Corrections, cancellations, and urgent changes steer the running turn now.
- New or later tasks wait as follow-ups until the turn ends.
- The queued card shows when Smart Queue is deciding and why a message waits.
- `bb smart-queue recent` lists each decision, and `bb smart-queue classify`
  dry-runs one.

## How it works

Jev classifies each message you send while a thread works. Without an
OpenCode Zen key, or when Jev fails, a fast model from your provider catalog
decides in a hidden, temporary thread. If neither answers, the message waits
as a follow-up.

Smart Queue acts only on your own messages. It leaves agent messages, plugin
messages, retries, scheduled sends, and Bot Teams threads alone.
