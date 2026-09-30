---
name: studio-tasks
description: Use when the user asks to track, add, list or update a task or to-do ("add a task", "what's on my board", "hand this to an agent"), when a thread was handed a task from Studio Tasks (its first message says "Work on this task from Studio Tasks"), or when they refer to a /plugins/studio-tasks/tasks/<id> link or an @task mention.
---

# Studio Tasks

Studio Tasks starts with four workflow columns: **To do**, **In
progress**, **Review** and **Done**. The user can rename and reorder them
and add custom columns with **Columns** on the board. `tasks_list` returns
the current column labels and IDs. Use those IDs for custom statuses; the
workflow IDs (`todo`, `in_progress`, `review`, `done`) stay the same after
renaming. A task has a title, a Markdown
description, a due day, an assignee (the user, an agent, or nobody), a
project (or none, for global), and links to threads and Studio items (pages,
artifacts, drawings, recordings). Link to a task as
`[Title](/plugins/studio-tasks/tasks/<task-id>)`.

## Handoffs

The user can hand a task to an agent. That starts a thread whose first
message is the task, with its links as mentions. The task then follows the
thread:

| Thread | Label on the task | Column |
| --- | --- | --- |
| Starting | Starting agent | In progress |
| Working | Agent working | In progress |
| Asked a question or needs a permission | Agent needs your input | stays |
| Turn ended | Agent replied, check its answer | Review |
| Agent called `tasks_update` with status "review" | Agent says it's ready for review | Review |
| Failed | Agent failed | stays |
| Archived / deleted | Thread archived / Thread deleted | stays |

Only the task's newest handoff moves it, and only between In progress and
Review. A task the user moved to To do or Done stays there.

**If you're working on a handed-off task:** when the work is ready, call
`tasks_update` with `status: "review"` and a one-line `note` saying what you
did. Link what you made with `addLinks` (for a saved artifact,
`{ pluginId: "artifacts", itemId: "art_…", label: "…" }`). Don't mark the
task done: the user does that after reviewing. The user may send feedback
back into your thread, which moves the task to In progress again.

## Agent tools

| Tool | Use it to |
| --- | --- |
| `tasks_list` | List tasks with ids, status, assignee, due day and handoff state. Filter by `status` or `query`. |
| `tasks_get` | Read a task's description, links and handoffs. Without `id`, the task this thread was handed. |
| `tasks_create` | Add a task (To do unless you pass `status`) in this thread's project. Only when the user asks to track something, not for your own plan. |
| `tasks_update` | Change status (not Done), title, description, due, add links, or set your handoff's `note`. Without `id`, this thread's task. |

`tasks_create` returns a line like `::task{id="tsk_…"}`. Put it on its own
line in your reply and the user sees a card that opens the task.

## CLI (works in every agent session)

```sh
bb studio-tasks list [--status <column-id>]
bb studio-tasks add <title> [--description <text>] [--due <YYYY-MM-DD>] [--me]
bb studio-tasks show <id>
bb studio-tasks move <id> <todo|in_progress|review|done>
bb studio-tasks hand <id> [--note <text>] [--folder]   # new thread, project's default agent
bb studio-tasks done <id>
```

## Settings

**Archive threads when a task is done** (off by default): moving a task to
Done archives the threads it was handed to. With it off, the board offers
**Archive threads** after you mark a task done.

## Studio

Tasks is a BB Studio add-on. With the Studio plugin installed, tasks also
appear in Studio's collection (kind `task`) with Status, Due and Assignee
columns and **Mark done** / **Move to To do** actions. The Tasks panel keeps
its own board either way.
