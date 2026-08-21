# bb-plugin-prime-agent

Registers [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) as an
ACP-based provider in bb (`acp-prime-agent`).

## Install

```bash
bb plugin install ./packages/bb-plugin-prime-agent
bb prime-agent setup
```

`setup` is idempotent: it rewrites the shim/logo, reconciles the
`customAcpAgents` entry, and reloads the running server config. Run it again
any time to repair or refresh the integration.

## Distribution

Path installs are the supported route during local development. Current bb
versions can also install this package directly from the repository:

```bash
bb plugin install --subdirectory packages/bb-plugin-prime-agent git:https://github.com/patleeman/bb-plugins.git
```

## What it does

bb's plugin SDK has no provider-registration API (`bb.sdk.providers` is
read-only), so this plugin provisions the supported data-dir mechanism:

1. Writes the ACP shim to `<dataDir>/bin/pa-acp.sh`
2. Writes the provider logo to `<dataDir>/logos/prime-agent.svg`
3. Merges a `customAcpAgents` entry into `<dataDir>/config.json`
   (never clobbers other entries or config keys)
4. POSTs `/api/v1/system/config/reload` to apply it to the running server

## Why the shim is needed

- prime-agent prints `model list` to **stderr** (stdout is reserved for its
  protocol); bb parses only stdout, so the shim merges and reformats the table
  into bb's `id - name` model-list format.
- prime-agent cannot resolve a provider from a bare `--model <id>` (even when
  that provider is authenticated), so model ids are provider-qualified in the
  picker (`opencode-go/deepseek-v4-flash`) and the shim translates
  `--model provider/model` into `--model model --provider provider` at launch.

## Usage

```bash
bb prime-agent setup    # install/repair shim + logo + config entry, reload
bb prime-agent status   # show config/asset/provider registration state
bb provider list        # acp-prime-agent should appear
bb provider models acp-prime-agent
bb thread spawn --provider acp-prime-agent --model <provider>/<model> --prompt "..."
```

## Notes

- Requires the `prime-agent` CLI on PATH and prime-agent auth for the
  provider(s) you intend to use (`/login` inside prime-agent).
- This integration is host-local. Install the plugin and run setup on every BB
  host where Prime Agent threads will run.
- The provider's model picker lists everything prime-agent advertises; only
  models from providers you've authenticated with will actually run.
- This plugin is a stopgap: the cleaner long-term fix is adding prime-agent to
  bb's known ACP agents registry (auto-detection, no config), and upstream
  fixes in prime-agent for stdout usage and model→provider resolution.

## License

MIT

## Session restore

The shim launches prime-agent with `--continue`, so each fresh ACP process
re-attaches to the most recent prime-agent session transcript instead of
starting blank. This keeps BB chat history across stop/start and is harmless
for a first run (there is nothing to resume). The ACP `session/load` protocol
itself is implemented by prime-agent; this plugin cannot change that part.
