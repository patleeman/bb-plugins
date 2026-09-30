# Agent instructions

## BB Studio packages are frozen

`packages/studio-kit` and the Studio plugins (`bb-plugin-studio`,
`bb-plugin-studio-chat`, `bb-plugin-pages`, `bb-plugin-talk`,
`bb-plugin-excalidraw`, `bb-plugin-artifacts`, `bb-plugin-studio-tasks`,
`bb-plugin-bot-teams`, `bb-plugin-thread-list-plus`) are maintained in
https://github.com/patleeman/bb-studio. Don't change them here; make the
change in bb-studio. They will be removed from this repository.

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

## Stable BB compatibility

Every plugin must install on the current stable BB release. npm's `latest`
tag for `@get-bb/plugin-sdk` tracks BB Nightly, so `npm install`, `pnpm add`,
and plugin scaffolding all default to an SDK that stable BB does not ship yet.
Stable BB then refuses the plugin with "requires bb plugin SDK ...".

- Pin `@get-bb/plugin-sdk` to an exact version no newer than the SDK in the
  current stable release (`pnpm check:compat` prints it), for example
  `pnpm add -D -E @get-bb/plugin-sdk@<stable-sdk>`. Typecheck against that
  version so nightly-only APIs fail to compile.
- Keep `engines.bbPluginSdk` at or below that version and `engines.bb` at or
  below the stable app version. Don't copy the version the scaffold or
  `bb plugin build` on Nightly writes.
- Run `pnpm check:compat` before handoff. It prints the current stable app and
  SDK versions and fails on any plugin that stable BB would refuse. Don't
  raise a floor past stable to make it pass; wait for the API to ship in
  stable instead.

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
