# SANE Science runtime

Python dependency foundation and explicit workspace environment provisioning for
the Marimo integration spike, with a pinned live-cell adapter. App integration,
agent tool registration, and UI are not implemented yet.

## Setup

Requires uv 0.12.5 or newer. From the repository root:

```sh
bun run --cwd packages/sane-science setup:python
```

uv uses `.python-version` and creates this package's ignored `.venv`. If the
pinned interpreter is unavailable, uv may download it during explicit setup.
Commit `pyproject.toml`, `.python-version`, and `uv.lock`; never commit `.venv`.
The project is a dependency environment, not an installable Python library.

## Dependency policy

- Marimo is pinned to the previously researched 0.25.1 integration baseline.
- `exclude-newer = "1 week"` excludes registry artifacts uploaded in the last
  seven days during resolution, including transitive dependencies. This uses
  individual artifact upload timestamps, not merely version release dates.
- PyPI is the configured default index; first-index resolution is retained.
- Prereleases and source builds are disabled; installation requires wheels.
- `no-sources` disables uv's `tool.uv.sources` overrides. Do not introduce direct
  URL/Git dependencies: the registry upload-age rule is not a policy for those.
- `uv sync --locked` installs the committed resolution and fails if the project
  requires a lockfile change. Normal setup does not upgrade dependencies.

For deliberate dependency changes, edit the manifest and run `uv lock` in this
directory; review the manifest and lock diff, then run `uv sync --locked`.
Use `uv lock --upgrade-package NAME` for a deliberate transitive update, still
subject to the cooldown. Age is a supply-chain precaution, not a vulnerability
assessment. The Python interpreter download is separate from this package-age
policy. CLI/environment overrides can change uv settings, so this configuration
is a managed workflow policy, not a security boundary against arbitrary commands.

## Workspace environments

The `sane-science/environments` entrypoint provides explicit operations:

- `getScienceEnvironmentStatus(workspace)`: read filesystem/receipt status;
  does not run uv or Python.
- `scaffoldScienceEnvironment(workspace)`: create missing matching templates and
  notebook/artifact/history directories without installing packages.
- `provisionScienceEnvironment(workspace, options?)`: explicitly install from
  the locked templates and verify Python/Marimo versions.

`sane-science/environment-paths` exposes `scienceEnvironmentPaths(workspace)`.
The workspace input must identify an initialized canonical SANE repository; use
the types in `sane-science/contracts`. Storage is in canonical `.sane/science`,
separate from the implementation project's Python environment. The three Python
template files at this package's root must ship alongside `src`.

This first provisioner accepts only byte-for-byte matching default templates.
It preserves and rejects differing manifests, locks, policy receipts, and
unmanaged virtual environments rather than silently migrating them. Custom
environment selection and scientific dependency updates need explicit migration
support in a subsequent increment. Worktrees sharing the canonical root serialize
provisioning; conflicting policy/lock revisions are rejected, not switched.

Provisioning uses a `.provision.lock` directory. A crashed provisioner may leave
it behind; recovery is manual after confirming the owning operation is stopped.
Do not remove a lock merely because a request timed out. A `ready` status records
successful provisioning and current filesystem evidence, not continuous package
integrity verification. Filesystem confinement assumes cooperative local actors.

The workspace provisioner has been statically checked, not exercised against a
workspace. Installation and lifecycle verification remain part of the integration
spike. Package-local development setup above has been executed successfully.

## Live cell adapter

`sane-science/marimo-pair` exports `MarimoPair` and `marimoSourceHash`.
Construct an adapter with a provisioned Python executable, token file, and cwd.
Its public operations are `listSessions`, `inspectCells`, `createCell`,
`editCell`, and `runCell`. DTOs are exported from `sane-science/marimo-contracts`.
Edits require the SHA-256 source hash from the cell snapshot.

The adapter targets Marimo 0.25.1 and its internal code-mode interface. The caller
must bind the selected notebook session to its current owned server generation;
the adapter cannot establish that ownership from an arbitrary generation string.
Session-list warnings must be handled even when the CLI exits successfully.
A headless server has no live notebook session until its frontend opens.

Operations are serialized per adapter instance. They have bounded subprocess
output and duration, with no automatic retries. An unconfirmed outcome requires
inspection before further action. Source hashes provide conflict detection, not
atomic compare-and-swap against simultaneous browser edits. Mutation acceptance,
execution outcome, and persistence are separate: Marimo's background autosave is
not acknowledged by a successful pair response.

Snapshots preserve MIME output data and console outputs, plus the runtime graph
(which may lag unexecuted source edits). Outputs are read in a separate request
after mutation/execution because Marimo freezes scratchpad output snapshots at
request start. Rich data is not automatically a portable artifact: rendering,
referenced assets, durable capture, and agent sharing remain integration work.

Only static typechecking has been performed; live adapter interoperability has
not been verified through notebook execution.

## Runtime supervisor

`sane-science/marimo-runtime` exports `MarimoRuntimeService`, with `start`,
`current`, `get`, `connection`, and `stop` operations. Its DTOs are in
`sane-science/marimo-runtime-contracts`. Start requires an initialized workspace,
ready environment evidence (rechecked at admission), an explicit port, and an
existing regular Python notebook under the workspace's science notebooks path.
It neither creates notebooks nor installs dependencies.

The service owns a launch generation and private token file, uses loopback-only
launch arguments, and drains/discards process output rather than exposing startup
credentials. Credential-bearing connection information is backend-only and must
not be serialized into ordinary status responses or logs.

State `process-started` is not HTTP readiness or kernel readiness. Both remain
explicitly unverified. Stop attempts bounded graceful termination and escalation;
separate kernel descendants may survive, so descendant cleanup remains unverified.
Ownership is in-memory and does not provide crash recovery or coordination across
multiple SANE installations. App integration must address these lifecycle limits.

The pinned internal configuration override disables startup cell execution.
Other Marimo project/user configuration, including dotenv and runtime settings,
remains inherited. Configuration policy must be completed before presenting this
supervisor as the managed workspace experience. No server has been launched to
verify lifecycle behavior.

## Bun / Python boundary

```text
SANE Bun bridge
  -> sane-science supervisor
       -> .venv/bin/marimo edit <notebook.py> (long-lived Python server)
       -> .venv/bin/marimo pair ...          (bounded adapter operations)
Browser notebook surface <-> Marimo HTTP/WebSocket server
```

The CLI starts the server; these are not competing deployment options. Bun will
own process lifetime, notebook identity, readiness, and connection routing.
Marimo owns live notebook cells and Python execution. We do not need a second
custom FastAPI server for this spike.

After setup, the supervisor should launch the environment's executable directly
with argument arrays, without shell activation, dependency resolution, or
installation on app startup. Runtime launch must bind loopback, configure
authentication, and isolate notebook web content from the privileged App origin.
The live pairing adapter must still be qualified through execution against the
pinned version before it is wired into the App.

This environment initially contains only Marimo and its dependencies. Add the
dataframe, visualization, and SQL packages needed by the spike through this
manifest and lockfile. Future per-analysis environments need their own managed
policy and locks: this project's settings do not automatically govern arbitrary
notebook sandboxes, inline script environments, or in-editor package installs.
Do not enable automatic package installation in the integration by default.
A virtual environment isolates dependencies, not Python filesystem/network access.
