# BB plugins

Plugins for [bb](https://github.com/patleeman/bb).

## Packages

- [`bb-plugin-agent-checklists`](packages/bb-plugin-agent-checklists/) — attach
  persisted structured checklists to threads, update them with agent tools,
  and continue incomplete work automatically.
- [`bb-plugin-agent-plugins`](packages/bb-plugin-agent-plugins/) — install Agent
  Plugins once in BB and flow their skills and approved MCP tools to providers.
- [`bb-plugin-gtd-sidebar`](packages/bb-plugin-gtd-sidebar/) — replace the thread
  list with a GTD-style inbox organized by workflow state.
- [`bb-plugin-plannotator`](packages/bb-plugin-plannotator/) — embed the upstream
  Plannotator plan-review app in BB's right panel and bridge its decisions back
  to agents.
- [`bb-plugin-cobalt2`](packages/bb-plugin-cobalt2/) — contribute the Cobalt2
  color palette to bb.
- [`bb-plugin-council`](packages/bb-plugin-council/) — convene advisor agents
  for independent review, discussion, and a verdict with dissent.
- [`bb-plugin-ds4`](packages/bb-plugin-ds4/) — run and administer a local
  DwarfStar (`ds4`) inference server from bb.
- [`bb-plugin-excalidraw`](packages/bb-plugin-excalidraw/) — create, edit, and
  attach Excalidraw drawings in conversations.
- [`bb-plugin-prime-agent`](packages/bb-plugin-prime-agent/) — register Prime
  Agent as an ACP-based bb provider (`acp-prime-agent`).
- [`bb-plugin-comprehension`](packages/bb-plugin-comprehension/) — turn messages,
  selections, and threads into clear HTML, audio, and podcast explainers.
- [`bb-plugin-emoji-react`](packages/bb-plugin-emoji-react/) — emoji reactions
  in the assistant-message text-selection menu; the reaction list is
  configurable in plugin settings.
- [`bb-plugin-traces`](packages/bb-plugin-traces/) — index local Codex, Claude,
  Pi, OMP, and DeepSeek Harness sessions in a private, searchable trajectory
  explorer.
- [`bb-plugin-copy-session-id`](packages/bb-plugin-copy-session-id/) — add a
  Copy session ID action to thread context menus in the left sidebar.
- [`bb-plugin-tok-speed`](packages/bb-plugin-tok-speed/) — show pooled provider
  generation speed in each assistant message's hover menu.
- [`bb-plugin-ua-fetch`](packages/bb-plugin-ua-fetch/) — fetch web content with
  adaptive user-agent probing and cached winners.

## Development

This is a pnpm workspace. Build or typecheck all packages with:

```sh
pnpm install
pnpm typecheck
pnpm build
```

Each package README documents its installation and runtime requirements.

Each plugin README also includes a screenshot captured from the running BB
application with staged plugin data. Capture all live surfaces after starting
BB and seeding a thread with:

```sh
BB_CAPTURE_PROJECT_ID=proj_... \
BB_CAPTURE_THREAD_ID=thr_... \
node scripts/capture-plugin-screenshots.mjs
```

The capture script drives the actual BB UI and writes PNG assets; it is not a
mockup or image-generation workflow.

## Installing every plugin

Install all packages as bb plugins (idempotent — safe to re-run):

```sh
pnpm plugins:install      # or: bash scripts/install-all.sh
```

This runs `bb plugin install <path> --yes` for every `packages/bb-plugin-*`
and prints the resulting installed list. To install just one, use its path:

```sh
bb plugin install ./packages/bb-plugin-agent-plugins
```
