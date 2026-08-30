# Tok Speed

Tok Speed displays a small `tok/s` label in each assistant message's hover
action row. The number is visible provider-output speed for that turn: visible
output tokens divided by active assistant-message time. It deliberately
excludes hidden reasoning, commands, tool results, and other host work, so it
answers “how quickly did the provider stream the text I saw?”

The plugin reads BB's provider item lifecycle events and
`thread/tokenUsage/updated`. Providers that do not report usable visible-output
usage or completed assistant-message timings simply have no label. The label's
tooltip includes the visible output tokens and usage samples included in the
pooled rate.

## Staged preview

![Tok Speed shown above assistant messages in the running BB application](assets/staged-preview.png)

This screenshot is captured from BB's rendered thread UI with seeded local
conversation data, a hovered assistant message, and a live `tok/s` decoration
in the bottom action row.

## Install

```sh
bb plugin install ./packages/bb-plugin-tok-speed --yes
```

## Development

```sh
pnpm --dir packages/bb-plugin-tok-speed test
pnpm --dir packages/bb-plugin-tok-speed typecheck
pnpm --dir packages/bb-plugin-tok-speed build
```
