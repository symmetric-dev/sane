# SANE Science runtime

Python dependency foundation and explicit workspace environment provisioning for
the Marimo integration spike. The Bun supervisor, notebook adapter, agent tools,
and UI are not implemented yet.

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

## Planned Bun / Python boundary

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
The live pairing adapter must be qualified against the pinned version; it is not
yet an implemented integration.

This environment initially contains only Marimo and its dependencies. Add the
dataframe, visualization, and SQL packages needed by the spike through this
manifest and lockfile. Future per-analysis environments need their own managed
policy and locks: this project's settings do not automatically govern arbitrary
notebook sandboxes, inline script environments, or in-editor package installs.
Do not enable automatic package installation in the integration by default.
A virtual environment isolates dependencies, not Python filesystem/network access.
