# External Agents

Work in progress: Hermes HTTP and OpenClaw ACP providers for stable BB 0.45.0
and Plugin SDK 0.6.15. Both provider bridges are implemented. Staged BB and successful live prompt
verification are not complete yet.

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
- Validate Hermes integration in a live BB thread.
- Run both providers against red4 in staged stable BB.
- Capture the staged provider surface and add its screenshot here.

## Settings and health

Hermes uses `hermesEnabled`, `hermesBaseUrl`, and `hermesTokenEnv`.
The token variable defaults to `RED4_HERMES_TOKEN` on the selected BB host.
The provider is disabled by default until its endpoint is configured.

The plugin RPC `health` accepts `{ hostId, provider: "hermes" }` and returns
`{ online, status, message }`. It runs the authenticated model probe on that
host. The office UI can use `online: false` for its Offline state.

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
