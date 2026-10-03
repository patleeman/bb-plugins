# Provider marks

These unmodified SVGs identify the connected services in BB's provider picker.
They are not External Agents branding and do not imply sponsorship or endorsement.
Retrieved 3 October 2026 from the official repositories:

- `hermes.svg`: Nous Research's unframed Nous Girl mark used by Hermes Agent,
  [assets/nous-girl-black.svg](https://github.com/NousResearch/hermes-agent/blob/main/assets/nous-girl-black.svg).
  Repository MIT license: `LICENSE-hermes.txt`.
- `openclaw.svg`: OpenClaw's lobster mark,
  [ui/public/favicon.svg](https://github.com/openclaw/openclaw/blob/main/ui/public/favicon.svg).
  Repository MIT license: `LICENSE-openclaw.txt`.
- `openai.svg`: OpenAI's logomark,
  [client/assets/openai-logomark.svg](https://github.com/openai/openai-realtime-console/blob/main/client/assets/openai-logomark.svg).
  Repository MIT license: `LICENSE-openai-realtime-console.txt`.
  The mark belongs to OpenAI and identifies its Dot service. OpenAI's
  [brand guidelines and mark usage terms](https://openai.com/brand/) apply.

Trademark rights remain with their respective owners. The MIT notices cover
repository distribution; they do not transfer ownership of these marks.

Registration uses the stable SDK's plugin-relative `icon` field. BB exposes
`/api/v1/system/providers/{hermes,openclaw,dot}/logo` automatically, the same
mechanism as its built-in Codex provider. The plugin's own branding stays separate.
