# bb-plugin-ds4 — DwarfStar

Configure a local **DwarfStar** (`antirez/ds4`, a.k.a. ds4.c) inference
server for BB. Once the setup is complete, choose its model in BB's model
picker: the plugin starts `ds4-server` for matching turns and stops it after
the configured idle grace period. Current DwarfStar builds support DeepSeek V4
Flash/PRO, GLM 5.2, and GLM 5.3 Flash GGUFs. GLM 5.3 Flash vision is supported
when its encoder sidecar is available.

## Staged preview

![Live BB screenshot of the DwarfStar settings](assets/staged-preview.png)

Captured from the running BB application with the live DwarfStar configuration.

Requires a DS4 checkout with a built `ds4-server` binary and a downloaded
model (see the [ds4 README](https://github.com/antirez/ds4#readme)):

```sh
git clone https://github.com/antirez/ds4 ~/workingdir/ds4
cd ~/workingdir/ds4 && make
./download_model.sh ds4f-q2      # or another target for your hardware
./download_model.sh ds4f-dspark  # optional, for Flash DSpark acceleration
# For GLM 5.3 Flash vision:
./download_model.sh glm53-q2
./download_model.sh glm53-vision
```

## Install

```sh
cd bb-plugin-ds4
bb plugin install .
bb plugin build      # optional: precompile the frontend
```

## What you get

- **DwarfStar setup** (Settings → Plugins → DwarfStar): checkout/model paths,
  GLM 5.3 vision encoder path, BB model selector, optional provider filter, idle
  grace period, runtime tuning, and optional external-agent configuration.
- **GLM 5.3 Flash vision**: `visionPath=auto` finds the standard
  `gguf/GLM-5.3-Flash-Vision-Encoder.gguf` sidecar when the selected model is
  GLM 5.3 Flash. Set an absolute or DS4-relative path to override it, or clear
  the setting to keep vision disabled.
- **Demand-driven supervision**: the local server starts when BB resolves a
  matching model for a turn, stays warm while matching turns are active, and
  stops after the last one is idle. Plugin-owned processes also stop as part of
  plugin reload/disable and BB shutdown.
- **Disconnect recovery**: if the BB host daemon disconnects after starting
  DwarfStar, the plugin records the managed PID and can reclaim that exact
  server on the next matching turn instead of starting a second copy. It also
  recognizes a compatible DS4 server already listening on the configured port,
  including one that is still loading its model. Unmarked existing servers are
  used but treated as external and are left running at idle; an explicit
  `bb ds4 stop` can terminate one. Its original endpoint is retained when
  settings change, so the explicit stop remains safe and effective.
- **Lifecycle feedback**: BB shows a host toast for lifecycle transitions and
  a host-framed status banner above the composer while DwarfStar is starting,
  stopping, or unavailable. It also confirms when the server becomes ready.
  Startup feedback is especially useful because loading a large GGUF can take
  several seconds.
- **`bb ds4` diagnostics** (kept for troubleshooting):
  - `bb ds4 status` — state, pid, uptime, health, served models
  - `bb ds4 start | stop | restart`
  - `bb ds4 logs [-n N]` — recent process output (also persisted to
    `~/.bb/plugins/ds4/process.log`, rotated at 50 MB)
  - `bb ds4 agents [status|apply [pi|opencode|codex …]]`
  - `bb ds4 agent` — launch the interactive `ds4-agent` TUI in a BB terminal
  - `bb ds4 complete <prompt>` — one-shot completion against the local server
- **Agent tools** (available to every BB agent): `ds4_status` and
  `ds4_complete` — BB agents can check the server and run prompts on the local
  DwarfStar model directly.
- **Agent connections**: write/merge provider configs so external agents can
  reach the server:
  - Pi/BB → `~/.pi/agent/models.json` (provider `ds4`, selected DwarfStar model)
  - opencode → `~/.config/opencode/opencode.json` (provider `ds4`, agent `ds4`)
  - Codex CLI → `~/.codex/config.toml` (`[model_providers.ds4]`, Responses
    wire API)
  Existing files are merged (never clobbered) and a timestamped
  `.ds4bak-<ts>` copy is kept before each write.
  When vision is enabled, the generated GLM 5.3 Pi and opencode models
  advertise both text and image input. DwarfStar's OpenAI Chat, Responses, and
  Anthropic endpoints accept inline PNG/JPEG image data; remote image URLs and
  file paths are not accepted.

## Supervision behavior

A background `supervisor` service:

- starts the server when BB resolves a selected model matching
  **`modelSelector`** for a turn,
- restarts after a crash while a matching turn still needs it when
  **`restartOnCrash`** is on (exponential backoff
  2 s → 30 s, reset after a healthy run),
- restarts automatically when settings that affect the command line change
  (port, ctx, model, backend, …) for plugin-owned processes. An external
  process is left alone and reports an explicit `bb ds4 stop` instruction,
- polls `/v1/models` every 2 s and flips the status to **ready** (green) once
  the HTTP API answers, showing "loading model…" while a big GGUF is still
  being read,
- stops after `idleTimeoutSeconds` with no active matching turn,
- stops the server cleanly (SIGTERM → SIGKILL after 12 s) on plugin
  reload/disable and BB shutdown,
- persists process metadata in `~/.bb/plugins/ds4/server.json` so an orphan can
  be verified by PID, executable, full command line, and start signature before
  it is reclaimed. Known external processes are recorded too, but remain
  `ownership: external` and are not stopped by idle supervision.
- keeps a recovered server in the loading state through transient health
  failures while its process identity is still valid, then retries/restarts
  only after the recovery grace period expires.

The first matching turn starts the process asynchronously; subsequent turns
reuse it while it is warm. BB surfaces the model-loading window with a host
toast and composer banner so it is clear that the local server is working. The
BB model configuration callback is synchronous, so a provider/client that does
not retry while a local server warms up can still report a first-request
connection error; retrying that turn uses the now-warm server.

## Settings (`bb plugin config ds4`)

| Key | Default | Meaning |
| --- | --- | --- |
| `ds4Dir` | `""` | DS4 checkout dir. Empty = auto-detect (`DS4_DIR`, `~/workingdir/ds4`, `~/ds4`, …) |
| `modelPath` | `""` | GGUF path; absolute or relative to `ds4Dir`. Empty = `ds4flash.gguf` |
| `visionPath` | `auto` | GLM 5.3 vision encoder path; auto-detects the standard sidecar, absolute/DS4-relative paths override it, and empty disables vision |
| `modelSelector` | `ds4/` | Exact model id or namespace from BB's model picker; matches DwarfStar's DeepSeek V4, GLM 5.2, and GLM 5.3 Flash ids by default |
| `providerId` | `""` | Optional exact BB provider id filter; empty matches the model across providers |
| `idleTimeoutSeconds` | `300` | How long to keep the server warm after the last matching turn |
| `backend` | `auto` | `metal` \| `cuda` \| `rocm` \| `cpu` |
| `host` | `127.0.0.1` | Bind address |
| `port` | `8000` | Bind port |
| `ctx` | `100000` | Context tokens (`-c`) |
| `maxTokens` | `384000` | Default maximum output tokens (`-n`) |
| `kvDiskDir` | `/tmp/ds4-kv` | Disk KV cache dir; empty disables it |
| `kvDiskSpaceMb` | `8192` | KV cache disk budget |
| `power` | `""` | GPU duty cycle (`--power 1..100`) |
| `extraArgs` | `""` | Extra flags appended to the command line |
| `dspark` | `false` | Enable the Flash-only DSpark optimization; requires the matching 0731 support GGUF |
| `dsparkSupportPath` | `""` | Absolute or DS4-relative support GGUF path; empty auto-detects `gguf/DeepSeek-V4-Flash-DSpark-support-0731.gguf` |
| `dsparkConfidence` | `""` | DSpark threshold (`0..1`); empty uses DwarfStar's backend default (Metal `0.6`, CUDA/ROCm `0.7`) |
| `restartOnCrash` | `true` | Restart after a crash (backoff) |
| `configurePi` / `configureOpencode` / `configureCodex` | `true`/`false`/`false` | Which agent configs `bb ds4 agents apply` writes by default |

## Notes

- The plugin manages **`ds4-server`** (the OpenAI/Anthropic/Responses HTTP
  server). The interactive **`ds4-agent`** TUI is launched into a BB terminal
  (`bb ds4 agent`) where you drive it directly — sessions save under
  `~/.ds4/kvcache` via `/save`.
- DSpark is opt-in for `ds4-server` and `ds4-agent`, using
  `--mtp-model <support.gguf> --dspark`. For the current Flash checkpoint, download
  it with `./download_model.sh ds4f-dspark`; the plugin refuses to start while
  the configured support file is missing or the model path is not recognizable
  as Flash, so it cannot silently run an incompatible DSpark combination.
  Leave `dspark=false` for GLM 5.2, DeepSeek V4 PRO, or a baseline run. Older
  checkouts using the pre-0731 support filename are still detected as a
  compatibility fallback.
- GLM 5.3 Flash vision uses a separate encoder GGUF. The plugin passes
  `--vision <encoder.gguf>` to both `ds4-server` and `ds4-agent`; the latter
  exposes the native `view_image` tool. The native `ds4_complete` input accepts
  up to 16 inline PNG/JPEG data-URI images, capped at 16 MiB per image and
  32 MiB combined by the plugin, with prompt and system text capped at 8 MiB
  and all completion content capped at 40 MiB. Serialized completion request
  bodies are capped at 60 MiB, below the upstream 64 MiB HTTP limit. Download
  the sidecar with
  `./download_model.sh glm53-vision`; `visionPath=auto` then enables it for a
  GLM 5.3 model in the same checkout. Run `bb ds4 agents apply` afterward to
  refresh managed agent configs in an existing BB session.
- The native `ds4_complete` tool also accepts an optional `imageUrls` array of
  inline PNG/JPEG data URIs when the encoder is configured.
- Vision startup requires a recognizable GLM 5.3 model path (a symlink may
  carry the recognizable name) and a GPU backend; CPU vision is rejected.
  While vision is enabled, model/backend/vision overrides are rejected in
  `extraArgs`, and `--chdir` is rejected so process recovery remains cwd-safe.
  Vision also rejects explicit multi-GPU placement flags because the current
  upstream GLM 5.3 path does not support multi-GPU vision startup.
- The plugin runs on the machine that runs the BB server (full-trust plugin
  code); it spawns the process locally and writes agent configs on the same
  host.
- Start is refused with an actionable error when the model file is missing
  (e.g. while `download_model.sh` is still running).
