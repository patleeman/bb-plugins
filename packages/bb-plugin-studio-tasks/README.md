# Studio Tasks

> **Studio Tasks** is part of **BB Studio**, a suite of plugins for writing, talking, drawing, tracking tasks, and keeping what your agents make: [Studio](../bb-plugin-studio), [Studio Pages](../bb-plugin-pages), [Studio Talk](../bb-plugin-talk), [Studio Draw](../bb-plugin-excalidraw), [Studio Artifacts](../bb-plugin-artifacts), and Studio Tasks.

A board of tasks you can do yourself or hand to an agent. A handed-off task
follows its thread: it moves to In progress while the agent works and to
Review when the agent replies or says it's ready. Its card says who acts
next, such as "Needs your input" or "Ready for review". You mark it done.

## Staged preview

![Live BB screenshot of the Studio Tasks board](assets/staged-preview.png)

The Tasks board in a staged BB with five seeded tasks in the "Acme app"
project: two in To do (one of them yours, due Oct 6), one each in In progress
and Review assigned to an agent, and a finished one in Done. The header has
the project and assignee filters, the Board/List toggle, Columns, and New task.

![Live BB column editor](assets/columns-preview.png)

The saved column editor with To do renamed to Backlog, a custom Waiting
column moved before Done, and a seeded task waiting for design approval.

## What you get

- **The board** (`/plugins/studio-tasks/tasks`): To do, In progress, Review and
  Done. Drag cards between and within columns, add a task with **+** at the
  top of a column, and filter by project and assignee (both remembered).
  Cards show the handoff's state, the agent's last note, the due day (red
  when overdue), the assignee, links and project. Done shows 20 at a time.
  **Columns** opens an editor to add, rename, reorder, and remove empty custom
  columns. Names and order are saved for all projects. The four workflow
  columns can be renamed and reordered but stay available for agent handoffs.
  Move tasks out of a custom column before removing it, including archived
  tasks. **List** switches to the same tasks as a sortable Studio collection.
- **A task** (`/plugins/studio-tasks/tasks/<id>`): editable title, status,
  assignee, due day and project; a Markdown description; links to threads,
  pages, artifacts, drawings and recordings; and the agent section. The
  header has **Hand off**, **Mark done** / **Reopen**, and a menu with Mark
  done and archive threads, New thread about this, Archive threads, Move to
  project, Archive task and Delete.
- **Hand off to an agent.** Pick the project, the agent and model (the
  project's default is preselected), a new worktree or the project folder,
  and an optional note. BB starts a thread with the task, its description and
  its links as mentions. The agent section shows the handoff's state in
  words ("Agent replied, check its answer", "Agent says it's ready for
  review"), its last note, **Open thread**, and **Send back** to reply with
  feedback, which moves the task back to In progress. Earlier handoffs are
  listed below it.
- **Archive on done**, an option in the plugin's settings, off by
  default. When it's off, marking a task done offers **Archive threads** in
  the toast.
- **Agents use it too.** `tasks_list`, `tasks_get`, `tasks_create` and
  `tasks_update`, and the `studio-tasks` skill. A handed-off agent calls
  `tasks_update` with status "review" and a note when it's done, and links
  what it made. `::task{id="tsk_…"}` in a reply shows a task card.
- **`@task` mentions** give the agent the task's details, links and handoff
  state.
- **`bb studio-tasks` CLI**: `list`, `add`, `show`, `move`, `hand`, `done`.
- **In Studio.** With the [Studio](../bb-plugin-studio) plugin installed,
  tasks join Studio's collection with Status, Due and Assignee columns and
  Mark done / Move to To do actions.

## How it works

- Tasks, links and handoffs live in the plugin's SQLite database
  (`src/server/store.ts`), along with column names and order. Board order is a fractional rank per column.
- BB's thread events (`thread.active`, `thread.idle`, `thread.failed`,
  archive and delete, and `interaction.pending`) become signals that
  `src/server/handoff.ts` turns into the handoff's next state and the task's
  column. The rules are pure and tested. Only a task's newest handoff moves
  it, and only between In progress and Review. On startup the plugin
  reconciles open handoffs with their threads, since events aren't replayed
  while it's off.
- The handoff's first message (`src/server/prompt.ts`) mentions each linked
  item through its add-on's mention provider, so the agent gets the item's
  contents.
- The Studio provider (`src/server/studio.ts`) implements the kit's
  `studio_*` methods on top of the store.

## Development

```
bb plugin install .     # register (path install; server.ts loads from source)
bb plugin dev           # watch: rebuild frontend + reload on every save
bb plugin build .       # emit dist/ (server.js + app.js/app.css)
pnpm typecheck
pnpm test
```

`@bb-studio/kit` is a `file:../studio-kit` dependency. Keep
`package-lock.json` current (regenerate it in a clean clone, not the pnpm
workspace), because BB's Git install runs `npm install` from it.
