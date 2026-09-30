# BB Studio

BB Studio is a suite of plugins for making things with your agents: documents,
recordings, and drawings. **Studio** is the core plugin. It owns one place,
the Studio collection, where every item from every Studio add-on lives
together. The add-ons (**Studio Pages**, **Studio Talk**, **Studio Draw**)
each contribute one kind of item and its editor.

## Goals

- **One collection.** With Studio installed, there is a single collection page
  for pages, recordings, and drawings, with one search, one project filter, one
  selection model, and one **New** menu.
- **Add-ons still work alone.** Without Studio, each add-on keeps a simple
  collection of its own kind, built from the same shared components. Installing
  Studio takes over: the add-on's collection hands off to Studio, filtered to
  that kind.
- **One design language.** The collection, rows, cards, item headers, badges,
  empty states, and menus look and behave the same in every Studio plugin,
  because they are the same code.
- **Projects are the container.** Items belong to a BB project or are global.
  No new "space" concept.
- **Stable IDs.** Existing plugin IDs (`pages`, `talk`, `excalidraw`) stay, so
  nobody loses data. Only display names carry the suite brand.

## The plugins

| Plugin | ID | Kind | Item view |
|---|---|---|---|
| Studio | `studio` | — | The Studio collection |
| Studio Pages | `pages` | Page | Block editor |
| Studio Talk | `talk` | Recording, dictation | Transcript with playback |
| Studio Draw | `excalidraw` | Drawing | Excalidraw canvas |

Each add-on keeps owning its data, its item view, its agent tools, its CLI, and
its @-mentions. Studio owns only the collection and the cross-kind actions.

## How Studio finds items

Every add-on implements the same small RPC surface, the **Studio provider
contract**, defined once in `packages/studio-kit/src/contract.ts`:

| Method | Input | Output |
|---|---|---|
| `studio_describe` | — | The kinds this plugin provides: id, labels, icon, whether it can create, and where its items open |
| `studio_list` | — | Every item as a `StudioItem` |
| `studio_search` | `{ query }` | Ids of items whose content matches (titles are matched by Studio), and optional `snippets` of the matching text by id |
| `studio_create` | `{ kind, projectId }` | The new item and where to open it |
| `studio_move` | `{ ids, projectId }` | Per-id results |
| `studio_archive` | `{ ids, archived }` | Per-id results |
| `studio_delete` | `{ ids }` | Per-id results |
| `studio_action` | `{ action, ids }` | A message, and text to copy for `copy` actions |

Add-ons register these with `registerStudioProvider` from
`@bb-studio/kit/server`, which publishes them for RPC discovery. Each plugin
passes its own `zod` into `studioSchemas(z)`, so the kit has no runtime
imports of its own on the server.

A `StudioItem` is the same shape for every kind:

```ts
{
  id, kind,                 // "page" | "recording" | "dictation" | "drawing"
  title, icon,              // icon: an emoji the user picked, or null
  projectId, parentId,      // parentId: nesting within the same plugin
  createdAt, updatedAt,
  preview,                  // one line of text, or null
  facts: [{ id, value, sort }] // e.g. "12 min", "4,210 words", "38 elements"
  badge: { label, tone } | null,  // "Recording", "3 failed", "Kept updated"
  thumbnailUrl,             // drawings: an SVG the add-on renders on its server
  href,                     // /plugins/<id>/<path>/<item id>
  archived,
}
```

Studio's server finds add-ons with
`bb.sdk.plugins.experimental_discoverRpc({ method: "studio_describe" })`
(plus the suite's own ids, so an add-on too old to be a provider can be named
as needing an update), calls each with `bb.sdk.plugins.callRpc`, merges the
results, and hands them to its frontend. A stopped or failing add-on shows as
unavailable and contributes nothing.

**Freshness.** When an add-on's items change, its server tells Studio through
the kit's `createStudioNotifier`, a debounced, best-effort
`callRpc("studio", "studio_changed", { pluginId })`. Studio publishes a
realtime event to its open collection, which refetches.

## The Studio collection

- **Header:** "Studio", search, **New ▾** (Page, Recording, Drawing — whatever
  is installed), and list/grid toggle.
- **Filters:** kind pills (All, Pages, Recordings, Drawings), a project
  dropdown (All projects, Global, each project), and Archived.
- **List view:** one table for every kind. Columns: Name (with kind icon or
  thumbnail, preview line, parent line), Kind, Project, Last activity. Sorting
  by name or activity. Rows open the item.
- **Grid view:** cards. Drawings show their thumbnail; pages show their emoji
  tile; recordings show a waveform glyph and their length.
- **Selection:** checkboxes with shift-click ranges. Bulk actions shared by all
  kinds: **New thread** (mentions every selected item), **Move to project**,
  **Delete**. Kind-specific actions appear only when the selection is all one
  kind (for example Talk's **Retry failed** and **Copy transcripts**).
- **Deep links:** the kind filter is the panel's sub-path
  (`/plugins/studio/studio/recording`), so an add-on can hand off to "Studio,
  filtered to my kind".

## Hand-off from add-on collections

Each add-on's nav item stays, because BB derives item URLs from a plugin's nav
panel (`/plugins/talk/recordings/<id>`). What changes is the panel root:

- **Studio installed:** the add-on's collection root redirects to the Studio
  collection filtered to that kind. Item pages still open in the add-on.
  Back buttons on item pages return to Studio.
- **Studio not installed:** the add-on shows its own collection, rendered with
  the same `studio-kit` components, limited to its kind.

The add-on's frontend learns whether Studio is present with the kit's
`useStudioPresent()`, which checks `sdk.plugins.list()` for an enabled,
healthy `studio` plugin and caches the answer for 30 seconds.

**Sidebar.** The add-ons' nav panels must stay registered, because BB derives
item URLs from them. Studio's ⋯ menu instead hides their sidebar rows by
writing BB's `sidebar.visiblePluginPanels` preference, and a one-time tip in
the collection offers the same. A BB nav panel option to register a route
without a sidebar row would make this automatic.

## studio-kit: the shared design language

`packages/studio-kit` (`@bb-studio/kit`) is a source package, not a plugin.
Each Studio plugin depends on it as `file:../studio-kit` and `bb plugin build`
bundles it in.

BB installs a Git plugin by cloning the repository and running
`npm install --omit=dev` in the plugin's directory, so the `file:` link
resolves inside the clone. Each plugin's `package-lock.json` must include the
kit; regenerate locks in a clean clone rather than the pnpm workspace, which
leaks `.pnpm` paths. The kit ships `clsx` and `tailwind-merge` as
dependencies; React, Radix, sonner and the SDK are host shims.

- **Tokens:** BB theme variables only (`--background`, `--foreground`,
  `--muted-foreground`, `--border`, `bg-state-hover`, `bg-state-active`).
  One type scale: 28px page titles, 14px body, 12px meta.
- **Collection:** `CollectionPage` renders the header, search, filters, list and
  grid views, selection bar, and empty states from a list of `StudioItem`s and a
  small config. Studio and every standalone add-on collection use it.
- **Standalone collection:** `AddOnCollection` wraps `CollectionPage` for an
  add-on's own panel, backed by the add-on's own `studio_*` methods, and hands
  over to Studio when it's present.
- **Item chrome:** `ItemHeader` is the top bar every item view uses: back
  pill, title or breadcrumb, status, and the view's own buttons. It floats
  over content by default; Draw pins it above the canvas with `relative`.
- **Pieces:** button classes (`PRIMARY_BUTTON`, `FLOATING_BUTTON`,
  `ICON_BUTTON`, …), `ItemTile`, `Badge`, `EmptyState`, `Checkbox`,
  `useProjects`, `relativeTime`, `mentionPrompt`, and the vendored menu
  primitives.

## What changes in each plugin

**Studio (new)**
- Nav item **Studio**, the collection, the aggregator, the `changed` hook.
- `studio_list_items` agent tool and `bb studio list` CLI so agents can find
  any item of any kind.

**Studio Pages**
- Implements the provider contract; its collection becomes `CollectionPage`.
- Item header moves into `ItemHeader` (same look it has today).
- **Explore** is a Pages feature: agents end answers with findings they
  noticed along the way (`::explore{items="…"}`), and a click writes an
  explainer page under the project's "Explore" page, tagged `Explore` in
  Studio.

**Studio Talk**
- Implements the provider contract; its table becomes `CollectionPage` with
  its extra columns (Length, Words) and bulk actions.
- The recording page adopts `ItemHeader` and the Pages type scale.

**Studio Draw**
- Migrates to the npm SDK so it matches the others.
- Drawings gain a project, and the gallery becomes `CollectionPage` with
  thumbnails.
- Drawings get their own URL (`/plugins/excalidraw/drawings/<id>`) instead of
  in-memory navigation, so Studio can open one.
- The server renders an SVG thumbnail from the saved scene, served over HTTP
  under a strict CSP, so Studio shows drawings without bundling Excalidraw and
  thumbnails stay current after agent and CLI edits. The URL carries the
  revision, so it caches forever.
- The editor adopts `ItemHeader`. The thread panel keeps a gallery for
  attaching drawings to the conversation.
- Its storage appends a migration; BB checks recorded migrations by hash, so
  the released statement stays byte for byte (a test pins it). A package
  `.npmrc` sets `legacy-peer-deps`, because Excalidraw's Radix peers stop at
  React 18 while the SDK's are React 19.

## Status

Built: the kit, the Studio plugin, and all three add-ons on the provider
contract, `AddOnCollection`, and `ItemHeader`. Each package has tests, and a
simulated Git install (clean clone, `npm install --omit=dev`, `bb plugin
build`) succeeds for all four plugins.
