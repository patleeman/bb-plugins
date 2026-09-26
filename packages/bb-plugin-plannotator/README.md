# bb-plugin-plannotator

This is a thin BB adapter around the official [Plannotator](https://github.com/backnotprop/plannotator) runtime. Plannotator owns the review experience; BB launches it in the thread's right panel and sends the decision to the agent as a new thread message.

## Staged preview

![Live BB screenshot of Plannotator settings](assets/staged-preview.png)

Captured from the running BB application with the bundled runtime selected.

## Install

```sh
bb plugin install /Users/patrick/workingdir/bb-plugins/packages/bb-plugin-plannotator --yes
bb plugin reload plannotator
```

There is no separate Plannotator installation. On the first review, the plugin downloads the pinned official Plannotator release for the current OS/CPU, verifies its SHA-256 digest, and caches it under BB's plugin data directory. Later reviews use the cached runtime.

For development, offline use, or an independently updated upstream build, set **Plannotator binary** under BB → Extensions → Plannotator or set `PLANNOTATOR_BIN` for the BB server. Use `bundled` to restore the default.

Start a new agent session after installing or reloading. When the agent explicitly calls `plannotator_review_plan`, BB opens the upstream UI as a persistent right-panel tab. The tool returns a review ID promptly, and the agent ends its turn. Approve or annotate in the tab. BB then closes it and sends the decision as a new message in the same thread, which wakes the agent. The message is queued if the agent is still working. There is no BB review deadline or hidden interaction countdown: the review remains open until Plannotator returns a decision or you use **Cancel review** in the tab. Plannotator is optional, and its approval is not a permission grant. The child receives the current BB provider identity explicitly, rather than inferring it from unrelated host environment variables.

BB stores the review state until it delivers the decision. If the plugin restarts during a review, it sends a cancellation message after restarting. If delivery fails temporarily, it retries. The agent can call `plannotator_review_status` with the review ID to recover a missing result; it does not need to poll during a normal review.

Plannotator's plan history and configuration are stored under the plugin's BB data directory. Local child sessions use BB's session-scoped same-origin relay, and BB acknowledges the current upstream look-and-feel announcement before mounting the iframe, so the standalone setup wizard does not interrupt each review. The upstream plan UI remains otherwise unmodified. **Open externally** is available as a fallback, but external browser tabs may have a separate cookie jar from the BB panel.

## Remote BB and Tailscale access

When BB is configured with a non-loopback `BB_APP_URL` (for example, its
Tailscale hostname), or with `BB_SERVER_BIND_HOST=0.0.0.0`, the plugin starts
Plannotator in its supported remote mode. The upstream listener binds beyond
loopback and selects a port from `19432-19441`. The embedded panel uses a
session-scoped same-origin relay for local child listeners over both HTTP and
HTTPS, so a one-port Tailscale Serve endpoint is enough and the browser never
has to reach the upstream port directly. Local-only BB sessions use the same
relay while the review is open; **Open externally** can still use the direct
upstream port when the network allows it.

If you choose **Open externally** over plain HTTP, allow the `19432-19441` port
range between the Tailscale client and the BB machine. With the recommended
Tailscale Serve setup, no additional Plannotator port mapping is required; this
plugin does not modify the machine's Tailscale configuration.

## Boundary

BB does not intercept arbitrary provider text or require a plan review before
edits. The `plannotator_review_plan` tool is optional and opens the upstream UI
only when explicitly chosen. Native provider Plan mode is separate and remains
provider-controlled. Skipping or cancelling Plannotator does not authorize or
prohibit implementation.

The default runtime is pinned to the release listed in `src/bridge.ts`; upstream updates arrive through a plugin update. The upstream project is dual-licensed under Apache-2.0 or MIT, and the plugin does not copy or reimplement its UI.

The large platform binaries are intentionally provisioned on first use instead of committed to this repository. This keeps the plugin source and BB's own plugin artifacts manageable while preserving a one-plugin installation experience.
