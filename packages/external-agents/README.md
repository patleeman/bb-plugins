# External Agents

Work in progress: Hermes HTTP and OpenClaw ACP providers for stable BB 0.45.0
and Plugin SDK 0.6.15. Provider registration and live verification are not
complete yet.

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

- Connect both providers to the BB bridge lifecycle and settings.
- Verify session continuity, stop, steering, and BB pending interactions.
- Run both providers against red4 in staged stable BB.
- Capture the staged provider surface and add its screenshot here.
