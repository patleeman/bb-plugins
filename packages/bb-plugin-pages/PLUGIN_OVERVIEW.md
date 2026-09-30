Write documents together with your agents. Pages is a Notion-style editor
inside BB where you, your agents, and your Studio Teams bots edit the same page
live.

## What you get

- **A block editor.** Type `/` for headings, checklists, tables, images,
  callouts, charts, stat rows, and embeds of links, threads, and other pages.
- **Live collaboration.** Agents' edits stream into the page, with cursors,
  while you keep typing.
- **A collection of pages.** The Pages nav item lists every page with search,
  filters, and a project filter. **New page** opens a full-page document.
- **Work with this page.** Start an agent thread from the box at the bottom
  of a page. The agent gets the page as context, and the thread opens in a
  card beside your writing.
- **Comments.** Comment on any text, reply, and resolve threads.
- **Bots that do the work.** @mention a Studio Teams bot in a page or a comment
  and it edits the page and replies. Give a page an owner bot and a schedule,
  and it keeps the page up to date.
- **Dictation.** With the Talk plugin installed, press **Dictate** or type
  `/dictate` and speak. The transcript goes in at your cursor.
- **Explore.** Agents end answers that read code with a few things they
  noticed along the way. Click one and a page explaining it is written in
  the background, under an **Explore** page, and opens beside the thread.
- **Projects and nesting.** Pages per project plus global pages, nested to
  any depth, with version history you can restore from.

## How it works

Pages are stored in this plugin's database on the BB server. Bot requests run
in each bot's own Studio Teams thread. Pages works without Studio Teams, but you
need it for the bot features. Page chats are ordinary BB threads. Requests made while Studio Teams is briefly
unavailable wait and go out once it's back.

## For agents

Agents read pages as Markdown and make small edits by block id, so they never
overwrite what you are typing. They can also create pages and work in comment
threads. The bundled skill documents the tools, the chart and stats formats,
and the `bb pages` command.
