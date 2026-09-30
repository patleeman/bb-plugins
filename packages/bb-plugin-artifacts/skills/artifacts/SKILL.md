---
name: artifacts
description: Use when you finish a deliverable the user will want to keep (a generated image, an HTML page, a report, a document, a data file), when the user asks to save something "to Studio" or "as an artifact", or when they refer to a Studio artifact: a /plugins/artifacts/artifacts/<id> link or an @artifact mention.
---

# Studio Artifacts

Artifacts are copies of the files agents make, kept in BB so they outlive the
thread's workspace. Saving copies the file's bytes at that moment. Saving the
same file from the same thread again adds a new version (unchanged bytes are
skipped), so the user can step back through versions.

Artifacts belong to the thread's project, or are global. Link to one as
`[Title](/plugins/artifacts/artifacts/<artifact-id>)`.

## When to save

Save finished outputs the user asked for or will obviously want: the final
image, the report, the page you built, an exported dataset. Don't save
scratch files, intermediate drafts, logs or source code the repo already
tracks. If unsure, finish the work and offer to save it.

Give each artifact a short, human title ("Q3 revenue chart", not
`chart_v2_final.png`) and, when useful, a one-line description.

## Agent tools

| Tool | Use it to |
| --- | --- |
| `artifacts_save` | Save a file by `path` (workspace or thread storage; relative paths are from the workspace root), or short text by `content` plus a file `name`. Pass `title`, optionally `description`, and `artifactId` to add a version to a specific artifact. |
| `artifacts_list` | List saved artifacts with ids and links; `thisThread` limits it to this thread. |
| `artifacts_read` | Read an artifact's details and, for text types, its contents. |

`artifacts_save` returns a line like `::artifact{id="art_…"}`. Put it on its
own line in your reply and the user sees a card that opens the artifact.

## CLI (works in every agent session)

```sh
bb artifacts save <path> [--title <title>] [--description <text>]
bb artifacts list [--thread]
bb artifacts show <id>          # print a text artifact
bb artifacts export <id> [path] [--force] # copy it into the workspace (default: its file name;
                                          # --force replaces a file already there)
bb artifacts delete <id>
```

## Types

The file name's extension decides how the viewer shows it: images (png, jpg,
gif, webp, svg), HTML (runs sandboxed, with scripts but no access to BB),
Markdown (rendered, with a source view), code and plain text, and PDF.
Anything else can be downloaded. The limit is 25 MB per file.

To change an artifact, export or rewrite the file, then save it again from
the same path (or pass `artifactId`). Saving to an archived artifact brings
it back out of the archive.

## Studio

Artifacts is a BB Studio add-on. With the Studio plugin installed, artifacts
appear in Studio's single collection next to pages, drawings and recordings,
where they can be moved between projects, archived, searched (by
description, file name and text) and deleted. The user can also save files
from any reply with its "Save to Studio" action, and turn a Markdown or text
artifact into a Studio page.
