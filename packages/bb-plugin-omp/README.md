# bb-plugin-omp — Pi-style OhMyPi provider

Standalone BB provider for [OhMyPi (omp)](https://github.com/can1357/omp). It keeps OMP's provider/model identities (for example, openai-codex/gpt-5) and runs one persistent OMP RPC process per BB thread.

This replaces the bundled ACP view of OMP when you want provider-qualified model names and OMP's native Pi-compatible session behavior.

## Install

    bb plugin install ./packages/bb-plugin-omp --yes
    bb plugin disable provider-acp   # optional: hide acp-cursor/acp-omp/acp-opencode/acp-hermes-agent
    bb provider list
    bb provider models omp | head

Re-enable ACP later with bb plugin enable provider-acp.

## How it works

- server.ts registers provider id omp, host-scoped model discovery, health checks, manual compaction, and the explicit reasoning levels BB can represent.
- model/list refreshes OMP's persistent catalog before running omp models --json on a cache miss, maps each entry to provider/model, preserves routeProviderId, and forwards the model's available thinking levels. This keeps newly loaded LM Studio models discoverable after the bridge cache expires or the plugin is reloaded. On the current installation this exposes the full 509-model catalog.
- thread/start and thread/resume launch a persistent omp --mode rpc child with a per-thread session directory. Resume uses OMP's session-file path, and thread/discard removes only that bridge-owned session path.
- Model, thinking level, working directory, environment variables, and system instructions are forwarded at process construction. BB's none/low/medium/high/xhigh map to OMP's off/low/medium/high/xhigh; OMP's minimal is normalized to BB low.
- OMP text, reasoning, native tool, compaction, usage, context, and error events are translated into BB thread deltas. Steer, manual /compact, interrupt/stop, and safe model/thinking replacement are wired through the same session.
- Local image attachments are base64-encoded and sent to OMP. The child process owns OMP-native tools and their execution lifecycle.

OMP itself accepts --thinking off|minimal|low|medium|high|xhigh|auto. The BB provider intentionally exposes none, low, medium, high, and xhigh: there is no max OMP level, and auto is not advertised as a stable BB reasoning choice.

## Known boundaries

- BB-injected dynamicTools and disallowedTools are not forwarded. OMP-native tools remain provider-owned.
- skills/configure is not implemented; the bridge does not inject BB skill roots into OMP.
- Interactive BB approvals and native user questions are not bridged. The provider advertises only full permission mode and starts OMP with --auto-approve --approval-mode yolo so native tools do not block on a terminal prompt.
- Remote image URLs are passed as text descriptions rather than downloaded; local file attachments are described by path.
- Provider usage reporting, OMP installation, fork, archive, rename, and session rewind are not implemented.
- Unknown future OMP event types are ignored until they have a safe BB delta mapping.

## Environment

- BB_OMP_BRIDGE_COMMAND — override the OMP executable path.
- BB_OMP_BRIDGE_ARGS — JSON array of extra OMP arguments, for example ["--profile", "work"].
- OMP_API_KEY — passed through to OMP; the normal OMP profile/session authentication also applies.

## Staged preview

[assets/staged-preview.png](assets/staged-preview.png) is captured from the running BB composer. It shows the live OpenRouter GLM 5.3 Flash OMP route selected in the model picker with None, Low, Medium, and High reasoning choices visible.
