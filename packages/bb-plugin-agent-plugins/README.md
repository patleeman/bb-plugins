# Agent Plugins for BB

> Install from the [BB Community marketplace](https://github.com/get-bb/marketplace/pull/84) (entry pending review).

Install [Agent Plugins](https://agent-plugins.org) once in BB and use them everywhere — skills become `/skill` commands and MCP capabilities flow to Codex and other BB providers through one canonical bridge.

This is the Agent Plugins/spec-plugin integration for BB. It is not a Claude marketplace plugin and does not publish to, install from, or emulate Claude's marketplace.

Supports local paths, Git, and npm. MCP stdio, Streamable HTTP, and legacy SSE are handled by the official `@modelcontextprotocol/client` SDK.

## Staged preview

![Live BB screenshot of the Agent Plugins manager](assets/staged-preview.png)

Captured from the running BB application with a live installed-plugin record.

## Install

```sh
# from the bb-plugins workspace
pnpm install
bb plugin build packages/bb-plugin-agent-plugins
bb plugin install ./packages/bb-plugin-agent-plugins --yes
```

Or install directly from git:

```sh
bb plugin install git:https://github.com/patleeman/bb-plugins.git --subdirectory packages/bb-plugin-agent-plugins --yes
```

## Use

- **UI:** Open **Agent Plugins** in the sidebar → paste a location (`/abs/path`, `https://github.com/acme/my-plugin`, `npm:my-plugin@^1.0`) or **Browse…** for a local folder → **Install**. The page checks tracked paths, Git refs, and npm sources for updates; an installed row shows **Update available** and an explicit **Update** button when the source changes. Expand an installed plugin to enable or disable each skill and MCP server independently. Disabled skills are not materialized for the next session; disabled MCP servers are removed from the bridge catalog while their approval is preserved. Supported MCP servers still need **Approve & start**; OAuth-protected HTTP servers use BB's loopback callback and expose **Authenticate**, **Reconnect**, **Reauthorize**, and **Disconnect** controls. Reconnect reuses or refreshes stored credentials; Reauthorize clears BB's local credentials and starts a fresh consent flow; Disconnect clears BB's local credentials and stops the connection. Remote grant revocation remains provider-dependent.
- **Sign-in prompt:** when an MCP server needs to sign in again or fails to connect, a small panel appears in the bottom-left corner listing it with **Sign in** or **Reconnect**. It disappears once everything is connected; nothing is shown otherwise. **Close** hides it until another server breaks or BB restarts. Status refreshes every minute and whenever BB regains focus.
- **CLI:** `bb agent-plugins list --json` · `bb agent-plugins outdated --json` · `bb agent-plugins update <id>` · `bb agent-plugins show <id> --json` · `bb agent-plugins tools --json` · `bb agent-plugins tools --query "send message" --server slack` · `bb agent-plugins describe <opaqueId>` · `bb agent-plugins call <opaqueId> '{"text":"hello"}'`
- **Agents:** the bridge exposes `agent_plugins_list_tools`, `agent_plugins_describe_tool`, and `agent_plugins_call`. `agent_plugins_list_tools` searches the catalog (`query`, `serverId`, `limit`, `offset`) and returns compact entries without input schemas, plus a tool count per server, so large servers don't flood the context. Agents fetch schemas for the tools they pick with `agent_plugins_describe_tool`, then call them by opaque ID.

The MCP client delegates authentication to the official SDK, including protected-resource/authorization-server discovery, dynamic client registration, PKCE, refresh, `WWW-Authenticate`, insufficient-scope step-up, and OAuth callback completion. Tokens and PKCE state are stored in a BB secret setting; they are never placed in the database snapshot or frontend payload.

For OAuth-protected MCP servers such as Fastmail, the registered redirect uses `http://localhost` on BB's port. If BB runs on another machine, sign in with your normal browser, then copy the **full** localhost URL from its address bar after the connection fails and paste it into the matching server's **Finish sign-in** field in BB. The URL contains a short-lived, one-use authorization code: paste it only into BB, never into chat or logs. BB verifies the callback URL, state and PKCE grant before exchanging the code. If the browser runs on the BB host or you have a port forward, the callback completes normally without pasting. Fastmail's MCP dynamic registration does not accept arbitrary public HTTPS redirect URIs; setting `BB_APP_URL` does not change this callback.

This v0 release installs one package instance at a time. Remove an existing
plugin before installing the same package name again; removal keeps its data
unless you choose to purge it.

## Spec

Implements Agent Plugins 1.0.0 + 1.1.0 draft (tolerant closed `plugin.json`, per-server `mcp.json` isolation, `skills/` discovery, `${PLUGIN_ROOT}`/`${PLUGIN_DATA}` single-pass, `cwd` containment, header/CRLF checks). MCP tools, prompts, resources, resource templates, completions, subscriptions, structured tool output, metadata, and lifecycle/list-changed notifications are forwarded through the SDK gateway. The bridge advertises only BB capabilities it can answer; it does not claim sampling, elicitation, or roots until BB exposes those host callbacks. Vendored schemas are in `schemas/`.

## Development

```sh
pnpm --filter bb-plugin-agent-plugins typecheck
pnpm --filter bb-plugin-agent-plugins test
bb plugin build packages/bb-plugin-agent-plugins
```
