# Studio Draw

> **Studio Draw** is part of **BB Studio**, a suite of plugins for writing, talking, drawing, tracking tasks, running bot teams, and keeping what your agents make: [Studio](../bb-plugin-studio), [Studio Pages](../bb-plugin-pages), [Studio Talk](../bb-plugin-talk), Studio Draw, [Studio Artifacts](../bb-plugin-artifacts), [Studio Tasks](../bb-plugin-studio-tasks), [Studio Chat](../bb-plugin-studio-chat), and [Studio Teams](../bb-plugin-bot-teams).

Create and edit [Excalidraw](https://excalidraw.com) drawings inside BB,
sketch alongside your agents, and attach drawings to conversations. The
plugin id stays `excalidraw`, so existing installs and drawings carry over.

## Staged preview

![Live BB screenshot of the Studio Draw editor](assets/staged-preview.png)

Captured from the running BB application: a drawing open in the Draw editor,
under Studio's shared item header, with staged shapes and labels.

## What you get

- **Drawings in Studio.** With the [Studio](../bb-plugin-studio) plugin
  installed, drawings join Studio's single collection next to pages and
  recordings: thumbnails, projects, search over the words on a drawing,
  archive, move, delete, and "Copy text". Without Studio, the **Drawings**
  panel shows the same collection on its own.
- **The editor** (`/plugins/excalidraw/drawings/<id>`) autosaves as you work.
  Its header matches every Studio item: back, an editable name, live sync
  status, **New thread** (starts a conversation that links the drawing), copy
  image, and a menu with Download PNG and Delete.
- **Attach from a thread.** In a conversation, open the right panel →
  **Drawings** and attach any drawing as an image, or use the composer's `+`
  menu → **Drawing**. Neither sends a message.
- **`@drawing` mentions.** The agent receives the drawing's scene as context.
- **Collaborative editing.** Keep a drawing open and ask an agent to change
  it: your editor applies its edits live, and its next read sees yours.
- **Server-rendered thumbnails.** Studio's cards show an SVG rendered from
  the saved scene, so they stay current after agent and CLI edits.
- **`bb excalidraw` CLI**: `list`, `create <name>`, `show <id> [--raw]`,
  `rename <id> <name>`, `delete <id>`, `merge <id> <scene-file.json>`,
  `remove-elements <id> <el-id…>`. The `draw` skill documents the tools and
  CLI for agents.

## Collaborative editing (how the agent works on your drawing)

Two entry points, both backed by the same element-level merge:

- **Native agent tools** — `excalidraw_list_drawings`,
  `excalidraw_get_drawing`, `excalidraw_create_drawing`,
  `excalidraw_update_drawing` (registered via `bb.agents.registerTool`).
  Available to providers that surface bb plugin tools (tool sets apply on the
  next provider session start).
- **`bb excalidraw` CLI** — works in *every* agent session (plain bash):
  `show <id>` returns the current scene JSON; `merge <id> <file>` upserts
  elements from a JSON file (an array of element objects or a full scene);
  `remove-elements <id> <el-id…>` deletes elements. This is the fallback path
  for custom ACP providers such as prime-agent.

The typical flow: you have a drawing open in the side panel and ask the agent
to change it. The agent runs `bb excalidraw list` / `show` (or the tool) to
see the latest scene, writes element JSON to a file, runs
`bb excalidraw merge <id> <file>`, and the open editor picks up the change
live — you see the new elements appear while the agent explains what it did.
While you sketch in the editor, the agent's next `show` sees your changes.
Deletions you make in the editor propagate to the agent's view (and vice
versa) via tombstones; edits to the *same* element resolve by Excalidraw's
`version` field (higher version wins).

- **Theme**: the editor follows bb's active theme. Editor chrome
  (toolbars, menus, dialogs) is re-mapped to bb's live theme tokens via
  `assets/excalidraw-theme.css` (imported after the vendored Excalidraw CSS),
  so it tracks the active palette — not just light/dark — and updates live on
  theme switches. Brand-new empty drawings start on the theme's canvas color
  (`--canvas`, resolved to hex); drawings with content keep their saved
  background so attached images stay scene-faithful.

## How it works

- Drawings are stored as serialized Excalidraw scenes (the same JSON format
  Excalidraw's "save to file" uses) in the plugin SQLite database at
  `~/.bb/plugins/excalidraw/data.db`.
- The editor embeds the real `@excalidraw/excalidraw` React component;
  changes are serialized (keeping deleted elements as tombstones so
  deletions propagate in multi-writer merges) and autosaved with a 1.2s
  debounce plus an ordered save chain, so rapid edits never race.
- Every successful write (editor autosave, agent tool, CLI) publishes a
  realtime `excalidraw` signal and tells Studio the collection changed; open
  editors fetch the latest scene on every signal, fill in element defaults
  with `restoreElements`, load new image files, and apply it with
  Excalidraw's own `reconcileElements` (in-progress local edits win) plus a
  5s polling fallback. The server merges concurrent writes element-wise
  (`lib/merge.ts`): agent and CLI upserts merge into the stored element, so
  a partial element (`{ id, type, x }`) changes only those properties.
  Tombstones for deletions are pruned after 30 days.
- Attaching renders the scene to a PNG in the browser
  (`exportToBlob` — no editor mount needed), base64-encodes it, and the
  server uploads the bytes with
  `bb.sdk.projects.attachments.upload`; it does not send a thread message. The
  `+` menu flow uses a host-rendered picker (`bb.ui.requestInput` +
  `pendingInteraction` slot).
- Thumbnails come from `GET /api/v1/plugins/excalidraw/http/thumbnail`,
  an SVG built on the server from the saved scene (`src/server/thumbnail.ts`)
  with a transparent background, served under a CSP that allows only inline
  data images. The URL carries the revision, so it caches forever.
- The Studio provider (`src/server/studio.ts`) implements the kit's
  `studio_*` methods on top of the drawing store (`src/server/store.ts`).
- Mention pills are backed by a server-side mention provider (`@drawing`)
  whose `resolve` attaches the current drawing scene to the message at send
  time.

## Development

```
bb plugin install .     # register (path install; server.ts loads from source)
bb plugin dev           # watch: rebuild frontend + reload on every save
bb plugin build .       # emit dist/ (server.js + app.js/app.css)
pnpm typecheck
pnpm test
```

Notes:

- `@excalidraw/excalidraw`'s CSS is vendored at `assets/excalidraw/`
  (the package's `exports` map doesn't expose the CSS subpath to the plugin
  bundler; the Assistant webfonts are inlined as data URLs because the
  bundler has no `.woff2` loader).
- The frontend bundle is large (~13 MB) because it embeds the full Excalidraw
  editor; it only loads when the plugin surfaces are mounted.
- `@bb-studio/kit` is a `file:../studio-kit` dependency. Keep
  `package-lock.json` current (regenerate it in a clean clone, not the pnpm
  workspace), because BB's Git install runs `npm install` from it.
