---
name: pages
description: Use when the user refers to a BB Page — a /plugins/pages/pages/<id> link, a page mention, "the launch page", a doc they want written or kept up to date — or asks you to read, write, comment on, or restructure a page, or how Pages and its Studio Teams integration work.
---

# Pages

Pages are collaborative documents inside BB. The user edits them live in the
Pages panel while agents and Studio Teams bots edit the same document through
tools. Every change merges in real time (Yjs), so nobody's typing is
overwritten.

Pages belong to a project or are global, and nest into a tree. Link to one as
`[Title](/plugins/pages/pages/<page-id>)`.

## Agent tools

| Tool | Use it to |
| --- | --- |
| `pages_list` | List this project's pages and global pages as a tree. Pass `query` to search titles and content. |
| `pages_read` | Read a page as Markdown. Each block is preceded by a `<!-- ^id -->` marker naming it; use those ids in edits. |
| `pages_create` | Create a page from Markdown. Set `global` for a global page, `parent` to nest it. |
| `pages_edit` | Apply small edit operations to a page (see below). |
| `pages_comments` | List comment threads with their ids, commented text, and replies. |
| `pages_comment` | Start a comment thread on a block, optionally on an exact quote from it. |
| `pages_comment_reply` | Reply in a comment thread. |
| `pages_comment_resolve` | Resolve or reopen a thread. |

Pages can be referenced by id (`pg_…`) or exact title.

### Editing without clobbering the user

Always `pages_read` first, then edit with targeted operations that reference
block ids (the full id or its first 8 characters):

- `insert_after` / `insert_before` a block, `replace` a block, `delete` a block
- `append` / `prepend` Markdown to the page
- `set_checked` on a checklist item
- `replace_text` inside one block, or the first match in the page
- `replace_all` — only when the user asks to rewrite the whole page

Pages saves a restore point before an agent's or bot's first edit in a
while, so the user can roll back from **Version history**.

## Markdown

Pages reads and writes GitHub-flavoured Markdown plus:

- **Callouts:** `> [!NOTE] text` (also `TIP`, `WARNING`, `CAUTION`, `IMPORTANT`).
- **Charts:** a fenced ` ```chart ` block holding JSON:
  `{"type":"bar|line|area|pie","title":"…","x":"label","series":["Revenue"],"stacked":false,"unit":"$","data":[{"label":"Q1","Revenue":10}]}`.
  `x` and `series` default to the first text column and the numeric columns.
- **Stats:** a fenced ` ```stats ` block holding 1–6 items:
  `[{"label":"ARR","value":"$1.2M","delta":"+8%","trend":"up","caption":"vs last month"}]`.
- **Mermaid:** a fenced ` ```mermaid ` block renders as a diagram.
- **Embeds:** a fenced ` ```embed ` block:
  `{"kind":"bookmark|thread|page|drawing|artifact|recording|task|item","target":"https://… or an id","title":"…"}`.
  Bookmarks may also carry `description` and `image`; leave them out and the
  editor fetches the link's preview when the page opens. `drawing`,
  `artifact`, `recording`, and `task` take the item's id in Excalidraw,
  Artifacts, Talk, or Studio Tasks. `item` embeds anything in Studio, with
  `plugin:id` as the target (`studio_list_items` lists ids). A drawing shows
  its picture, an artifact its content, and the rest a card.
- **Mentions:** `@[Name](bot:bot_id)`, `@[Title](page:pg_id)`,
  `@[Title](thread:thr_id)`, `@[Title](item:plugin:id)`,
  `@[2026-10-01](date:2026-10-01)`.

Tables, checklists (`- [ ]`), headings, quotes, and images work as in GFM.
Code fences keep their language and are highlighted for TypeScript,
JavaScript, JSON, Python, shell, Go, Rust, SQL, HTML, CSS, YAML, Markdown,
diffs, Java, Kotlin, Swift, C, C#, TOML, Dockerfile, GraphQL, and XML.

## Working from a page

The "Work with this page…" box at the bottom of a page is BB's new-thread
composer. Sending starts a normal agent thread in the page's project, shown
in a card on the page. The thread also appears in the sidebar, and its header
links back to the page. That thread's first message carries the page id and
its Markdown with block ids as hidden context. The copy can go stale as the
user types, so read the page again right before you edit it with
`pages_edit`. This works without Studio Teams.

## Studio Teams integration

These need the Studio Teams plugin. Each request runs in the bot's own DM thread
with its configured model and reasoning level.

- **@mention a bot in a page.** Typing `@` and picking a bot in the page
  sends it the surrounding block as a request, plus the page. The bot edits
  the page and usually leaves a comment on that block saying what it did.
- **@mention a bot in a comment.** The bot answers in the same thread. Bots
  that have already replied in a thread see every new human reply there.
- **Hand off from the page composer.** Mentioning a bot in the page's
  "Work with this page…" box sends it that message as a request about the
  page.
- **Keep updated.** A page can have an owner bot, a cron schedule, and
  instructions. On each run the bot brings the page up to date. **Refresh
  now** runs it immediately.

Requests show in the page's **Activity** menu as queued, working, done, or
failed. Picking one opens its thread in a card on the page.

When you are a bot handling one of these requests, follow its instructions:
edit with `pages_edit`, then reply in the named comment thread with
`pages_comment_reply` or start one with `pages_comment`.

## Dictation

With the Talk plugin installed, the user can dictate into a page: **Dictate**
in the header, `/dictate`, or *Talk: Start or finish dictation* while the
cursor is in the page. Talk records and transcribes, and Pages inserts the
text at the cursor, or at the end if the user hasn't clicked into the page.
Text finished elsewhere is added when the user goes back to the page.
Dictation edits the page as the user, not an agent. Recordings are in Talk's
Recordings page (`bb talk list`).

## CLI

Output is bounded and tab-separated where it is a list.

```sh
bb pages list [--all]                                   # this project + global; --all for every project
bb pages show <page-id|title> [--ids]                   # Markdown; --ids adds block id markers
bb pages create <title> [--global] [--markdown <text>]  # prints the new page id
bb pages append <page-id|title> <markdown…>             # "\n" in arguments becomes a newline
```

## Limits

- Uploaded files (images, video, audio, files) are limited to 15 MB each.
- `pages_read` returns up to 60,000 characters.
- Deleting a page deletes its sub-pages. Archive it instead to keep it.
