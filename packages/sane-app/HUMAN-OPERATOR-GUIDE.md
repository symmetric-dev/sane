# SANE App operator guide

## Setup and launch

Install [Bun](https://bun.sh/) and authenticate the native harnesses you want to
use: Claude Code on PATH and/or a running managed-local OpenCode service.
From this checkout:

```sh
bun install
bun run setup:app --cwd /absolute/path/to/project --port 6700
bun run start:app
```

Open `http://127.0.0.1:6700`. Setup saves
`packages/sane-app/.config.json` and initializes App history/catalog in
`packages/sane-app/.data`. Repeating a matching setup preserves existing state;
changed settings require explicitly editing the config or selecting a new
`--config` file. Setup does not initialize the project's `.sane` state or install
or start native services.

`bun run start` is an alias for `bun run start:app`. The server runs in the
foreground; one server owns each installation checkout, regardless of port or
data directory. Use `bun run start:app --help` for launch options without starting
the server.

## Install or update native integrations

SANE agents receive their instructions directly from the App. Native plugins,
hooks, and MCP integrations are still required for SANE tools. From this checkout,
install or refresh the executable integrations:

```sh
bun packages/sane-cli/src/install-sane-agent-context-packages.ts --runtime-only --overwrite
```

This updates user-level harness configuration as well as runtime files. Add
`--dry-run` to inspect planned changes first. The defaults target the user's
standard `.claude` profile, managed OpenCode registration, and this checkout's
`packages/sane-app/.data/native-handoff.json` connection file. If using another
App data directory or registration, supply matching absolute paths with
`--app-connection-file` and `--registration-file`. Custom Claude hook/MCP binding
directories must agree; use `--binding-root` when explicitly aligning them.

Restart affected native services after refreshing their integrations. Restarting
the App alone does not update installed plugins or MCP files. Runtime-only
installation does not publish or retire legacy agent Markdown; do not remove
installed definitions still needed by active legacy sessions.

After source updates, stop the App gracefully, install changed dependencies,
refresh changed native integrations, start the App again, and reload the browser.
Existing SANE sessions retain pinned instruction revisions; restarting or
compacting is not an instruction refresh.

## Configuration and remote access

CLI overrides are temporary. CLI paths resolve against invocation cwd; saved
paths resolve against the config directory. Setup saves absolute paths. Native
source selectors must agree with the store's recorded source identities.

- `--config PATH` selects another saved config.
- `--cwd PATH` selects the default execution directory for new conversations.
- `--data-dir PATH` selects App history/catalog; it is not a project `.sane` store.
- `--claude-bin`, `--claude-profile`, and `--opencode-registration` select native
  sources. OpenCode endpoint and credentials come from its managed registration
  together, not an arbitrary remote endpoint.

The listener defaults to loopback. For an existing HTTPS reverse proxy, set
`SANE_APP_PASSWORD` securely in the server environment and launch with the exact
browser origin:

```sh
bun run start:app --public-origin https://your-host.example
```

A non-loopback listener additionally requires `--allow-remote`, a password, and
an HTTPS public origin. These settings do not create a proxy, configure TLS, or
set up Tailscale. Do not put passwords in committed files or shared commands.
Use `--no-allow-remote` or `--clear-public-origin` to override saved values.

Launch builds a versioned asset generation. `--no-build` serves only a generation
that still matches its source/build inputs; missing or stale assets require a
rebuild. A running server does not adopt rebuilt assets or changed backend code.

## Projects and execution targets

Open a directory and select its workspace/worktree. New conversations use that
selection; existing conversations retain their recorded execution checkout.
Files, Git, and Terminal use the selected browsing workspace, which may differ
from the conversation's execution checkout. Check the displayed target before
saving, staging, committing, pushing, or starting a terminal.

Use **Enable workstreams** in an existing Git workspace to initialize its project
state. **New workspace…** creates a new Git repository and initializes its SANE
state. App setup and project initialization are separate. Linked worktrees share
the primary checkout's `.sane`; unrelated repositories remain separate.

Unsaved file buffers are browser-memory-only. Search reads saved files. Git commit
uses the staged index; push is a separate explicit action. These operations use
the host's Git identity and credentials. Interactive authentication may require
an external terminal. Terminals require explicit control and do not survive App
restart. Finish external native execution before continuing the same conversation
from the App.

## Browser and Python

Host-browser sessions require Chrome/Chromium on the server. Set
`SANE_CHROMIUM_BIN` to an executable path if automatic discovery fails;
`SANE_HOST_BROWSER=0` disables them. Host-browser URLs resolve on the server,
not on a remote client device. Conversation pairing alone does not grant agent
access: Observe/Control grants are separate. Review screenshots and diagnostics
before sharing; saved captures live under `<dataDir>/browser-artifacts/`.

Python notebook provisioning is explicit in the chat's **Notebook settings** and
requires [uv](https://docs.astral.sh/uv/) satisfying the
[runtime manifest](../sane-science/pyproject.toml). The project must have initialized
SANE state. Notebooks and their environment live under the primary checkout's
`.sane/science`; App chat history remains in the configured App data directory.
Local Python cells are not sent to the agent unless explicitly shared. Python
executes on the host: a virtual environment is not a security sandbox.

## Shutdown, recovery, and backups

Stop with Ctrl-C or SIGTERM and let draining finish. OpenCode shutdown stops App
observation, not native execution. Back up the configured App data directory,
saved config, project `.sane` directories, and native harness storage while their
writers are stopped. App history alone is not a backup of native conversations.

After a crash, inspect surviving App-owned processes before using
`--reconcile-interrupted`. Reclamation requires proven-dead ownership; never
delete locks or state merely to clear a busy indicator. Partial/incompatible
stores are not silently reset or adopted. If a schema upgrade is required, back
up the store and stop other SANE processes before the explicit upgrade.

Unknown acceptance or execution is not proof that an operation did nothing.
Inspect operation status, repository state, or native history before another
mutation; do not blindly resend. Submitted question answers with paused delivery
require **Resume delivery** after restart or Stop.

The browser's install menu or **Install SANE**, where offered, can create a
standalone frontend window. This does not install a background server or provide
offline operation; the App server must remain reachable.

For performance captures and science timing logs, see [PROFILING.md](PROFILING.md).
