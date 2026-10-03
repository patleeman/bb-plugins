# External Agents

Work in progress: Hermes HTTP and OpenClaw ACP providers for stable BB 0.45.0
and Plugin SDK 0.6.15. Both provider bridges are implemented and installed in
staged stable BB. Successful red4 prompt verification remains incomplete.

The provider process runs on the selected BB host and connects to a remote
agent server. The intended provider IDs are `hermes` and `openclaw`.

## Development

```sh
npm install --include=dev
npm run typecheck
npm test
```

The Hermes client implements `/v1/models`, `/v1/runs`, run event streaming,
and the run `/approval`, `/steer`, and `/stop` endpoints. Tests derive their
wire shapes from Hermes's `gateway/platforms/api_server_runs.py`.

Credentials come from a supplied secret or a named environment variable.
HTTP errors omit response bodies and underlying network error details to
keep credentials out of diagnostics. Redirects are refused.

Hermes tool events carry names without call IDs. The mapper assigns IDs and
matches completions in order for each tool name. Approval responses retain
the exact Hermes request ID and never broaden the choices the server offers.

## Remaining verification

- Verify OpenClaw ACP through staged BB.
- Complete successful live prompts after upstream credentials are configured.
- Implement the experimental Dot provider using the preserved
  [transport notes and probes](docs/dot-transport.md).

## Settings and health

Hermes uses `hermesEnabled`, `hermesBaseUrl`, and `hermesTokenEnv`.
The token variable defaults to `RED4_HERMES_TOKEN` on the selected BB host.
The provider is disabled by default until its endpoint is configured.

The plugin RPC `health` accepts `{ hostId?, provider: "hermes" }` and returns
`{ online, status, message }`. It runs the authenticated model probe on that
host. If `hostId` is omitted, it uses BB's local server host. Disabled providers
return `status: "disabled"` without a network probe. The office UI can use
`online: false` for its Offline state.

The fixture integration test covers session start/resume, run creation,
BB approval response routing, steering, and remote stop. These checks do not
substitute for the pending red4 live tests.

OpenClaw uses `openclawEnabled`, `openclawBaseUrl` (a `ws://` or `wss://`
Gateway URL), and `openclawTokenEnv` (default `RED4_OPENCLAW_TOKEN`). Install
`openclaw` on the BB host. `openclawStateDir` selects its paired client state;
`openclawAllowPrivateWs` permits the encrypted Tailscale route when enabled.
The same health RPC accepts `provider: "openclaw"`.

Gateway agents appear as `openclaw/<agentId>` models. Each BB thread gets a
stable, isolated Gateway session key under that agent. Credentials are written
to private temporary files and never put in ACP process arguments. Files are
removed when the bridge closes. No permanent OpenClaw configuration is edited.

The paired Gateway client needs `operator.read` for model discovery, plus its
normal ACP permissions. Gateway reachability does not prove that an upstream
model provider is authenticated. The turn can still fail with a provider error.

Optional live catalog test (load the token variables into the shell first):

```sh
BB_EXTERNAL_LIVE=1 npm test
```

Current red4 check: Gateway authentication succeeds, but `agents.list` reports
that the paired client lacks `operator.read`. Infrastructure remediation is
pending. Both agents also need upstream model credentials before the required
successful prompt checks can pass.

## Staged preview

![External Agents settings in stable BB](assets/staged-preview.png)

Captured from the full BB 0.45.0 application with both providers enabled,
the red4 Tailscale URLs, token variable names, and paired OpenClaw client
state configured. The screenshot contains paths and variable names, not
credential values.

If the BB host does not inherit the token variable, set `hermesTokenEnvFile`
or `openclawTokenEnvFile` to a dotenv file on that host. Only the named
assignment is used. The parser does not execute shell code or expand values;
the process environment takes precedence.

Both agents run tools remotely. OpenClaw rejects per-session MCP servers,
so its bridge does not pass BB's dynamic tool server to the Gateway. Configure
additional tools on the remote agent itself.

Staged evidence: the plugin installs from Git on stable BB 0.45.0. A real
Hermes BB thread reaches red4 and records the remote missing-credentials
error as a failed turn. OpenClaw's live probe currently reports the missing
`operator.read` scope. Neither required `ok` prompt has succeeded yet.

Hermes also passes the published BB provider-bridge conformance suite using
an HTTP fixture. OpenClaw routing tests cover cancellation during preflight
and rejection of a model change that would otherwise keep using the old
Gateway agent. Start a new BB thread to select another OpenClaw agent.

The deterministic `scripts/hermes-fixture.mjs` also passed an approval round-trip
through the full staged BB 0.45.0 runtime: a pending interaction appeared,
Allow once reached the exact Hermes request ID, and the thread completed with
`ok`. This fixture executes no commands. This verifies BB integration independently
of the pending red4 model credentials.
