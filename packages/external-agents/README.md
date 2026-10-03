# External Agents

Work in progress: Hermes HTTP and OpenClaw ACP providers for stable BB 0.45.0
and Plugin SDK 0.6.15. Hermes registration and fixture integration are implemented. OpenClaw
and live verification are not complete yet.

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

- Add OpenClaw registration and the ACP bridge.
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
