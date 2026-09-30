---
name: studio
description: Use when the user refers to BB Studio or "my stuff" across pages, Talk recordings, drawings, artifacts and tasks — finding an item they made, "the doc about X", "that recording from Tuesday", "what's in Studio" — or asks how Studio and its add-ons (Studio Pages, Studio Talk, Studio Draw, Studio Artifacts, Studio Tasks) fit together.
---

# Studio

BB Studio is a suite of plugins for making things with agents. **Studio** is
the core: one collection that lists every item from every installed add-on.

| Add-on | Plugin id | Items | Open with |
| --- | --- | --- | --- |
| Studio Pages | `pages` | Pages | the `pages` skill and `pages_*` tools |
| Studio Talk | `talk` | Recordings, dictations | the `talk` skill and `bb talk` |
| Studio Draw | `excalidraw` | Drawings | the `draw` skill and `excalidraw_*` tools |
| Studio Artifacts | `artifacts` | Artifacts: saved images, HTML, reports, files | the `artifacts` skill and `artifacts_*` tools |
| Studio Tasks | `studio-tasks` | Tasks on a board you can hand to agents | the `studio-tasks` skill and `tasks_*` tools |

Items belong to a BB project or are global. Every item has a link
(`/plugins/<plugin id>/<panel>/<item id>`); put it in replies as
`[Title](link)` so the user can open it.

## Finding items

- Agent tool `studio_list_items`: this project's and global items, newest
  first, each with its kind and link. Pass `query` to match titles and
  content, `kind` (`page`, `recording`, `dictation`, `drawing`, `artifact`, `task`) to narrow, and
  `allProjects: true` to look everywhere, and `tag` to list one tag's items.
  Archived items are left out. Each line shows the item's `#tags`; an item
  that matched `query` on its content has the matching text on a `>` line
  below it (`snippet` in `--json`).
- CLI: `bb studio list [--all] [--kind <kind>] [--query <text>] [--tag <tag>] [--json]`;
  `bb studio tags` lists the tags and how many items each has.
- `bb studio providers` shows which add-ons are installed and whether each is
  ready; an add-on that's stopped contributes nothing to the list.

Then read or change the item with its add-on's own tools. Studio doesn't edit
content itself.

## Tags

Tags group items across add-ons, like a "Launch" tag on a page, a drawing and
a task. Studio keeps them; add-ons don't. Use `studio_tag_items` with
`items` (item links, or `<plugin id>:<item id>`), `add` and `remove` (tag
names). Adding a name that doesn't exist yet creates the tag. Tag when the
user asks to group, file or label items; don't invent tags on your own.

## In the app

The Studio panel is the collection: search, kind, project and tag filters, list or
grid, archive, move to project, delete, **New ▾** for any kind, and
**New thread** to start a conversation that mentions the selected items. With
Studio installed, each add-on's own collection hands over to Studio filtered
to its kind; the add-ons' sidebar rows can be hidden from Studio's ⋯ menu.
Cmd/Ctrl+Shift+K (palette: **Studio: Search items**) opens Studio search over
any page, matching titles and content; point the user there to find an item
quickly. Cmd/Ctrl+K is BB's thread search, not Studio's.
