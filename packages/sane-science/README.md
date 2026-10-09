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

The workspace provisioner has been exercised against an isolated initialized
repository. Locked relocation, Python/Marimo/pandas/matplotlib imports, and
non-mutating repeated scaffold/status calls passed. Package-local development
setup has also been executed successfully. The gated provisioning check is:

```sh
SCIENCE_RUN_PROVISION=1 bun test packages/sane-science/tests/provision.integration.test.ts
```

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

Live adapter interoperability was verified on 2026-10-09 against the pinned
runtime: source edits, execution, text/table/PNG capture, and stale-source rejection
passed. See the integration evidence summary below.

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

Explicit start admits managed configuration before launching. It creates matching
`.sane/science/.marimo.toml` and `notebooks/pyproject.toml` if absent; differing
files are preserved and rejected. Notebooks must be direct `.py` children of
`notebooks`, without PEP 723 inline metadata. This deliberately narrow policy
avoids nested project and script overrides without changing the uv lock/template.

The implementation follows installed Marimo 0.25.1 `_config/utils.py` (cwd user
config discovery), `reader.py` (nearest project), and `manager.py` (layer merging).
The project layer is necessary: an empty user-layer `runtime.dotenv` is discarded
by Marimo. The managed project sets `dotenv = []`, lazy cell changes, no automatic
reload/instantiation, no reactive tests, and no extra Python paths. User/ancestor
Marimo settings are shadowed rather than edited. Server startup commands are not
passed; the pinned CLI defaults to none. Sandbox mode is explicitly disabled.
The configured pip manager's inherited `should_auto_install()` returns false in
`_runtime/packages/package_manager.py`; no package manager is invoked by this API
outside explicit provisioning. Browser-initiated installs or arbitrary notebook
code are not blocked by this policy. Both server and pair receive an environment
allowlist. These settings are predictable defaults, not a security sandbox or a
lock against subsequent browser configuration changes.

## Workspace coordinator (Bun API)

`sane-science/science-workspace` exports `ScienceWorkspaceService`; DTOs and typed
errors are in `sane-science/science-workspace-contracts`. Use one service per
canonical workspace in the supervising process. Construction and status never
install dependencies. `provision()` is the explicit installation boundary.

For a **fresh disposable Git repository**, initialize sane-core first; do not
fabricate a context from a path or pre-create a nonempty `.sane` directory:

```ts
import { discoverRepository, inspectRepositoryStore, initializeRepository } from "./packages/sane-core/src/repository.ts"
import { ScienceWorkspaceService } from "./packages/sane-science/src/science-workspace.ts"

const discovery = discoverRepository("/absolute/path/to/disposable-git-repository")
const availability = inspectRepositoryStore(discovery)
const context = availability.state === "ready" ? availability.context
  : availability.state === "uninitialized" ? initializeRepository(discovery)
  : (() => { throw new Error(availability.message) })()
const science = new ScienceWorkspaceService(context)

await science.provision() // explicit uv --locked install; needs uv >=0.12.5
const notebookPath = await science.createNotebook("experiment.py")
const opened = await science.openNotebook({ notebookPath, port: 28731 })
const ref = opened.ref // exact notebook path + owned launch generation
try {
  // Hand this secret-bearing URL to the tester's browser; never ordinary logs.
  const browser = science.browserConnection(ref)
  // Open browser.url, then:
  const observed = await science.refreshNotebook(ref)
  // Explicitly choose an ID from observed.sessionIds; never choose implicitly.
  const sessionId = observed.sessionIds[0]
  if (!sessionId) throw new Error("Open the notebook in the browser first")
  const session = { ...ref, sessionId } // caller's explicit selection
  await science.selectSession(session)
  const before = await science.inspectCells(session)
  const added = await science.createCell(session, "value = 41", { run: false })
  if (added.mutation !== "accepted") throw new Error("Inspect before retrying")
  const snapshot = await science.inspectCells(session)
  const cell = snapshot.cells.find(cell => cell.id === added.cellId)!
  await science.editCell(session, cell.id, "value = 42", cell.sourceHash, false)
  await science.runCell(session, cell.id)
} finally {
  await science.shutdown() // or stopNotebook(ref); inspect cleanup evidence
}
```

Place the script at the implementation repository root and run `bun ./script.ts`.
Initialize the disposable directory with `git init` before discovery. For an
existing notebook, skip `createNotebook` and supply its exact admitted path.
Keep the Bun process alive while a separate browser tester connects; shutdown
must run in `finally` when that interaction finishes. The snippet illustrates
sequential calls, not a browser-wait implementation.

`openNotebook` polls authenticated pair listings. Only a warning-free listing
establishes `serverReadiness: ready`; an empty listing means
`awaiting-browser-session`, not kernel readiness. Sessions for other paths never
qualify. Discovered sessions require explicit selection and successful live
inspection before `session-ready`. Listing failures return `server-unverified`,
with `listing-unconfirmed`; the owned process remains available for retry or stop.
`status` is a cached observation with current process state; `refreshNotebook`
performs a fresh probe. Probe subprocesses are bounded to two seconds each; total
readiness polling may exceed its deadline by one in-flight probe/version check.

Cell operations recheck exact notebook/session/generation and warning-free
listing at admission. A missing selected session is `session-lost`, never silently
rebound. Calls and shutdown serialize; shutdown waits for admitted bounded work.
Restart invalidates old references. Process-level status still reports kernel
and HTTP readiness as unverified: the coordinator owns the separate observations.
Mutation/execution/durability retain the pair adapter's semantics: durability is
unconfirmed, hashes are conflict checks rather than CAS, and mutations are never
automatically retried. Shutdown does not prove all detached kernel descendants
are gone. Ownership and operation serialization are process-local; callers must
coordinate provisioning across service instances and processes themselves.

### Integration evidence (2026-10-09)

A disposable initialized workspace passed real locked provisioning and an
authenticated browser-backed workflow with Python 3.12.14, Marimo 0.25.1,
pandas 3.0.6, and matplotlib 3.11.2:

- Launch reached server-ready / awaiting-browser-session, then explicit session
  selection reached session-ready.
- Create, edit, and run succeeded; captured stdout, a two-row dataframe HTML
  output, and a valid 1069×826 PNG (39,294 bytes) in a Marimo MIME bundle.
- Browser checks found expected text/table output and decoded the PNG.
- A stale source hash rejected mutation without requesting execution.
- Browser reload changed the session ID. The old reference was rejected as
  session-lost; explicit reselection restored readiness.
- Shutdown exited with code 0 and removed token files. The observed server,
  resource tracker, and separately grouped kernel all exited without manual
  termination. Both test ports closed, and the browser tab/workspace were removed.

This is evidence for the observed run, not a guarantee that every possible user
subprocess is collected. The API deliberately retains cleanup uncertainty.

Reusable verification support lives in `tests/`: focused regression tests, an
opt-in provisioning test, and `live-workspace-harness.ts` for browser-driven
integration. Raw timestamped evidence from this run was retained locally at
`/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/science-live-evidence-iv7_fzy0`.
It is temporary machine-local evidence, not a packaged fixture.

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
The pinned adapter has passed the live spike above. App routing, embedding,
durable history, and agent-tool registration remain subsequent work.

This environment includes Marimo, pandas, and matplotlib for the integration
spike. Add further visualization and SQL packages through this manifest and
lockfile. Future per-analysis environments need their own managed
policy and locks: this project's settings do not automatically govern arbitrary
notebook sandboxes, inline script environments, or in-editor package installs.
Do not enable automatic package installation in the integration by default.
A virtual environment isolates dependencies, not Python filesystem/network access.
