---
name: draw
description: Use when the user refers to a Studio Draw (Excalidraw) drawing — a /plugins/excalidraw/drawings/<id> link, an @drawing mention, "the diagram", "sketch this" — or asks you to read, create, or change a drawing, or how Draw fits into BB Studio.
---

# Studio Draw

Drawings are Excalidraw scenes stored in BB. The user sketches in the Drawings
panel (or Studio, when it's installed) while you edit the same scene through
tools or the CLI. Writes merge element by element, so your changes and the
user's in-progress sketching both survive; the user's open editor shows your
changes live.

Drawings belong to a project or are global. Link to one as
`[Name](/plugins/excalidraw/drawings/<drawing-id>)`.

## Agent tools

| Tool | Use it to |
| --- | --- |
| `excalidraw_list_drawings` | List drawings with ids, names and element counts. |
| `excalidraw_get_drawing` | Read a drawing's current scene before changing it. |
| `excalidraw_create_drawing` | Create a drawing. Returns its id and a link to share. |
| `excalidraw_update_drawing` | Upsert elements, delete elements by id, or patch appState. An upsert of an existing id merges: send `id`, `type` and just the properties to change. |

## CLI (works in every agent session)

```sh
bb excalidraw list
bb excalidraw create <name>
bb excalidraw show <id> [--raw]
bb excalidraw rename <id> <name>
bb excalidraw delete <id>
bb excalidraw merge <id> <scene-file.json>      # array of elements or a full scene
bb excalidraw remove-elements <id> <element-id…>
```

## Working on a drawing

1. Read the latest scene first (`excalidraw_get_drawing` or `show`); the user
   may have changed it since you last looked.
2. Write only the elements you're adding or changing. Give new elements
   fresh ids; to change one, send it with its existing id. Elements you send
   win over the stored copy. The easiest way to get the shape right is to
   copy an existing element and change its id, position and text.
3. Delete with `deletedElementIds` / `remove-elements`, never by leaving
   elements out: omitted elements are kept.
4. Bind a label to a shape with the shape's `boundElements` and the text's
   `containerId`, as Excalidraw does.
5. Link the drawing in your reply so the user can open it.

## Studio

Draw is a BB Studio add-on. With the Studio plugin installed, drawings appear
in Studio's single collection next to pages and recordings, where they can be
moved between projects, archived, searched by the words written on them, and
deleted. Without Studio, the Drawings panel shows the same collection on its
own.
