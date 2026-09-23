# Agent instructions

## Marketplace maintenance

Keep the root `marketplace.json` current in the same change as the plugins it
lists.

- When adding, renaming, moving, or removing a plugin, update both
  `marketplace.json` and `.bb/plugins.json`.
- When changing a plugin's display name, description, icon, or author, update
  its marketplace entry to match. Keep tags accurate for its capabilities.
- Keep each entry's ID aligned with the plugin's installed ID. Use this
  repository's Git URL, the correct package subdirectory, and the intended
  branch or release selector in its source.
- Before handoff, validate `marketplace.json` against BB's marketplace schema.
  Confirm that both indexes list the same plugins, IDs are unique, and all
  referenced package directories and local icon assets exist.

## Plugin documentation

All new plugins must include at least one screenshot captured from the running
BB application in a staged environment before handoff.

- Start the normal BB application and use its full rendered UI. Seed the
  plugin's primary workflow with safe, deterministic local data.
- Add the plugin to the capture definitions in
  `scripts/capture-plugin-screenshots.mjs`, including an assertion for the
  live surface and the data that must be visible. Run it with a seeded thread:

  ```sh
  BB_CAPTURE_PROJECT_ID=proj_... \
  BB_CAPTURE_THREAD_ID=thr_... \
  node scripts/capture-plugin-screenshots.mjs
  ```

- The script must drive the real BB nav panel, settings page, thread action,
  host surface, or CLI-backed surface and write
  `packages/<plugin>/assets/staged-preview.png`.
- For plugins without a frontend, capture the real settings, provider, host,
  or CLI surface where the plugin is used. Do not substitute image generation,
  hand-authored SVG/HTML mockups, diagrams, or placeholder artwork.
- Add the PNG to the plugin README under `## Staged preview` and describe the
  live surface and staged data shown.
- If an expected live label or data assertion fails, fix the staging workflow;
  do not weaken the assertion to make an empty or broken screen pass.

Before handoff, verify the live capture and README links:

```sh
for readme in packages/*/README.md; do
  base=${readme%/README.md}
  test -f "$base/assets/staged-preview.png" || exit 1
done
file packages/*/assets/staged-preview.png | grep -q 'PNG image data'
git diff --check
```
