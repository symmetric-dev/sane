# @agenv/workstream-dashboard

Local-only Bun dashboard for AgENV workstreams.

## Install

This package is Bun-only.

Install Bun first, then install the package:

```bash
# install Bun: https://bun.sh
npm install -g @agenv/workstream-dashboard
```

The dashboard reads an existing AgENV repository on disk, so you still need a checked-out repo with `work/` state and the `@agenv/workstreams` data model available through the repo contents.

## What it shows

- canonical current-workstream state from `work/<stream-id>/workstream-state.json`
- runtime overlays derived from the canonical workstream snapshot
- tmux session observability for matching workstream activity
- optional embedded `ttyd` terminal views for read-only inspection

## Local prerequisites

The dashboard is intentionally local-only in v1:

- it always binds to `127.0.0.1`
- embedded terminal views only proxy loopback `ttyd` targets
- terminal observability is read-only and should be treated as inspection only

Install or verify the local tools it depends on:

```bash
# macOS (Homebrew)
brew install tmux ttyd

# Debian/Ubuntu
sudo apt-get install tmux ttyd

# verify
tmux -V
ttyd -v
```

Dependency roles:

- `tmux`: required to observe the live implementation/supervision sessions the dashboard correlates with the current workstream.
- `ttyd`: required only for browser-embedded terminal views. If `ttyd` is missing, canonical status still works, but terminal views remain unavailable.

## Start the server

From an AgENV repo root:

```bash
workstream-dashboard --repo-root "$(pwd)"
```

Or with an explicit path:

```bash
workstream-dashboard --repo-root /absolute/path/to/repo
```

Optional flags:

- `--repo-root <path>`: repo to inspect; defaults to the current directory
- `--port <port>`: local port; defaults to `43119`

On startup the server prints a local URL such as `http://127.0.0.1:43119/`.

## Routes and pages

### HTML pages

- `/`: current-workstream dashboard
- `/terminal-views/:terminalViewId`: standalone page for one read-only terminal view
- `/terminal-views/:terminalViewId/ttyd`: proxied local `ttyd` target used by the dashboard iframe

### JSON + SSE endpoints

- `/api/health`: server config plus observability capability summary
- `/api/current-workstream/snapshot`: full dashboard snapshot
- `/api/current-workstream/status`: canonical status summary
- `/api/current-workstream/tree`: canonical tree snapshot (`?batch_id=01.02` optional)
- `/api/current-workstream/runtime`: canonical runtime summary
- `/api/current-workstream/supervision`: canonical supervision summary
- `/api/current-workstream/observability`: tmux + terminal observability summary
- `/api/current-workstream/live`: SSE stream for snapshot/observability refresh events

## Using the current-workstream dashboard

1. Set the active workstream with `work current --set "<stream-id>"`.
2. Start the dashboard server and open `/` in a browser.
3. Use the summary cards, stage list, and task tree to inspect canonical progress.
4. Use the tmux panel to see matched local sessions for the current workstream.
5. If `ttyd` is available, choose a terminal view to embed a read-only terminal for that session.

If the dashboard and observability disagree, trust the canonical snapshot first.

## Source of truth vs observability

The dashboard has three layers:

1. **Canonical state**: `workstream-state.json` is the source of truth. Status, tree, runtime, and supervision summaries are derived from persisted workstream state.
2. **tmux observability**: live session discovery is correlated against canonical identifiers. It can be ready, degraded, unavailable, missing, stale, or ambiguous.
3. **`ttyd` terminal views**: browser-friendly, read-only views layered on top of tmux sessions when local `ttyd` is available.

Only the first layer changes workstream truth. tmux and `ttyd` help operators inspect what is happening, but they do not determine completion, failure, or review state.
