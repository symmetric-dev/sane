# SANE App operator guide

## Setup and launch

From a cloned installation checkout, install workspace dependencies with `bun install`, then:

```sh
bun run setup:app --cwd /path/to/project --port 6700
bun run start:app
```

Setup explicitly initializes fresh App history/catalog in `packages/sane-app/.data`
and saves `packages/sane-app/.config.json`. Repeating a matching setup preserves
existing state. Partial, incompatible, or source-mismatched stores are rejected;
there is no reset, import, or migration. Setup does not initialize a project's
`.sane`. Project initialization is a separate explicit action in the selected Git
repository; linked worktrees share its project authority. Projects need not be
inside the SANE installation.

`bun run start`, `bun run start:app`, package `bun run start`, and direct
`bun packages/sane-app/server.ts` use the same config-driven launch. No installer,
background App service, or global App configuration is required. One server owns
each installation checkout, regardless of port or selected data directory.

## Configuration

Use `bun run start:app --help` for options. `--config PATH` selects another saved
config; setup can create that file in an existing parent directory. CLI settings
override saved settings. CLI paths resolve against invocation cwd; saved paths
resolve against the config directory. Setup saves absolute paths. Without a saved
execution cwd, the default is invocation cwd, not the App package directory.

Setup will not overwrite an existing config with changed settings. Edit that
config explicitly, or choose a new config file. Launch overrides are temporary.
Native source changes must still match the store's source pins.

Local Claude uses `claude` on PATH by default; `--claude-bin` and
`--claude-profile` select its executable and profile. OpenCode uses managed-local
discovery via `--opencode-registration`. Endpoint and credentials come from that
registration together; explicit remote endpoints are unsupported. Setup and launch
do not install, start, or reconfigure native services. Contradictory native selector
environment variables are rejected. Unavailable native sources do not require
discarding App history.

The listener defaults to `127.0.0.1:8787`. For an existing HTTPS reverse proxy, set
`--public-origin https://YOUR-HOST` and `SANE_APP_PASSWORD`. A non-loopback listener
additionally requires `--allow-remote`. These settings do not configure proxies.
Use `--no-allow-remote` or `--clear-public-origin` to override saved values.

## Assets and ownership

Launch explicitly builds a complete versioned asset generation, then serves that
selected generation. `bun run build:app` performs a standalone guarded build.
`--no-build` validates the current generation against source/build inputs and
output hashes before serving; stale or missing assets require rebuilding.
The server snapshots its HTML at startup. Builds cannot replace assets beneath a
running installation owner.

Installation ownership is acquired before data ownership and held across build,
startup, serving, and shutdown. Ctrl-C or SIGTERM drains App work before releasing
ownership. OpenCode shutdown stops observation, not native execution. Failed drains
retain ownership and exit unsuccessfully. After a crash, verify any surviving
App-owned Claude processes have stopped before using `--reconcile-interrupted`.
Reclamation requires proven-dead owner evidence; live, malformed, or unverifiable
ownership is not silently removed. Never delete state to clear a busy indicator.

## Working with projects

Open a directory and select its workspace/worktree. That selection chooses new
conversations' execution checkout; existing conversations retain their recorded
checkout. Finish external work in a conversation before sending from the App.
Native linking and handoffs are separate work, not part of App setup.
