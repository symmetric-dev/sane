# marimo runtime and embedding architecture

Research cutoff: **2026-10-06**. Upstream facts only; no SANE repository audit, implementation, tests, or browser verification. The latest release returned by GitHub was **0.25.1**, published **2026-10-01T21:17:52Z**, not a projected release. Its annotated tag resolves to commit **`92fbbbee742eccf4c88dbc2afee16167e34dc7d5`**. Prefer this commit's source when interpreting rolling documentation. Sources: [release](https://github.com/marimo-team/marimo/releases/tag/0.25.1), [latest-release API](https://api.github.com/repos/marimo-team/marimo/releases/latest), [annotated-tag resolution](https://api.github.com/repos/marimo-team/marimo/git/tags/d7f9e437e7ce4d1958fad6035e8beec0521c172f).

## 1. Is the official CLI server the supported editable-notebook runtime?

### Takeaway

**Yes: prefer the official `marimo edit` server for user-driven scientific exploration and editing.** `marimo run` is the complementary published-app mode: users can manipulate widgets and trigger reactive computation, but cannot edit the notebook source through that UI. The two modes must not be conflated. [CLI reference](https://docs.marimo.io/cli/)

### Cited Findings

#### Package and environment baseline

- At the pinned release, the PyPI project/package is `marimo`, version `0.25.1`, with the `marimo` console entry point. Python minimum is **3.10** (`requires-python = ">=3.10"`); classifiers list 3.10–3.14. Its declared license is **Apache-2.0**. This is the package minimum, not a promise every scientific dependency works on every listed Python version. [Pinned pyproject](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/pyproject.toml)
- Server dependencies include Click, Uvicorn, Starlette, `websockets`, and `pyzmq` under platform/Python markers. Scientific packages are not all bundled into the base package; optional extras include `sql`, `sandbox`, `recommended`, `lsp`, and `mcp`. In this release the `sandbox` extra supplies `uv>=0.9.21`, while `pyzmq` has moved to core dependencies where its markers apply. [Pinned pyproject](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/pyproject.toml)
- Python notebooks are ordinary `.py` files with a `marimo.App`, decorated cell functions, and generated dependency signatures/returns. Markdown notebooks also exist, but have fewer capabilities: they cannot be imported as libraries or run as scripts, and reactive tests do not work. Default directory edit discovery in the pinned workspace constructor uses `include_markdown=False`; therefore `.py` is the least surprising first format. [File-format/editor guide](https://docs.marimo.io/guides/editor_features/watching/), [pinned workspace source](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/marimo/_server/workspace/__init__.py)

#### Modes, workspace scope, and flags

- `marimo edit notebook.py` creates or edits one notebook. `marimo edit notebooks/` opens a directory/home workspace; directory sandbox mode gives each opened notebook its own environment. `marimo run notebook.py` publishes one read-only app; `marimo run folder another_folder` and multiple notebook files are also supported. With a single directory and `run --watch`, the workspace rescans so additions/deletions appear on later gallery requests; other invocation shapes retain static snapshot behavior. [CLI reference](https://docs.marimo.io/cli/), [sandbox directory guide](https://docs.marimo.io/guides/package_management/sandboxes/), [pinned run workspace construction](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/marimo/_cli/cli.py#L943-L970)
- **Important for `.sane/`:** the directory scanner skips entries whose names start with `.`, plus symlinks and common generated/virtual-environment directories. It has default bounds of depth 5, 1,000 files, and 10 seconds. Scanning the repository root is consequently not a reliable way to find notebooks beneath `.sane/`. Passing `.sane/notebooks/` as the explicit root, or a notebook's explicit path, avoids relying on traversal through a hidden child entry; this last statement is a source-based inference, not a executed integration check. [Pinned scanner](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/marimo/_server/files/directory_scanner.py), [explicit directory routing](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/marimo/_server/workspace/__init__.py)
- Both `edit` and `run` support **`--headless`**, **`--host`** (default `127.0.0.1`), **`--port`/`-p`**, **`--proxy`**, **`--base-url`**, repeatable **`--allow-origins`**, **`--token`/`--no-token`**, **`--token-password`**, **`--token-password-file`**, **`--watch`**, **`--session-ttl`**, and **`--skew-protection`/`--no-skew-protection`**. `--headless` only prevents launching an external browser; it does not remove the frontend or pre-create a live notebook session. [CLI reference](https://docs.marimo.io/cli/), [pinned pairing no-session guidance](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/marimo/_cli/pair/commands.py#L402-L409)
- Authentication defaults differ: **edit defaults to token enabled; run defaults to disabled**. An unspecified token password is generated randomly when auth is enabled. `--token-password-file` accepts a path or `-` for stdin and is mutually exclusive with `--token-password`. The startup URL appends `?access_token=...` when a token is present. Keep these distinctions in any launcher contract rather than blindly using `run` defaults. [CLI reference](https://docs.marimo.io/cli/), [startup URL source](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/marimo/_server/api/lifespans.py#L309-L321)
- `run --include-code` sends source to the client so users can view it; this is **not editable mode**. Without it, source is not sent by default. `edit` always starts in EDIT mode with source included; `run` starts in RUN mode. [CLI reference](https://docs.marimo.io/cli/), [pinned edit/run implementations](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/marimo/_cli/cli.py)
- Default server port is 2718, but when no port is supplied the server finds a free port starting there. An explicitly supplied occupied port is not silently replaced. Do not assume an omitted port guarantees 2718. [Pinned server start](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/marimo/_server/start.py#L248-L250)
- `--base-url` must start with `/`; `/` alone is rejected because it is equivalent to no base URL. `--proxy` describes the externally visible reverse-proxy address; it does **not** create a proxy. It accepts bare hostnames, `host:port`, and full URLs, inferring 80 or 443 when needed. A path in `--proxy` supplies the base URL when absent; an explicitly different base URL is rejected after trailing-slash normalization. Backend Uvicorn still binds the supplied local `host`/`port`. [Pinned proxy resolution](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/marimo/_server/start.py#L125-L185), [pinned validation](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/marimo/_cli/cli_validators.py)

#### Transport, lifecycle, and watching

- Live client/kernel communication is **WebSocket**, alongside HTTP/static/API traffic. The official nginx example requires HTTP/1.1 upgrade headers and raises the read timeout to 600 seconds. The server config pings WebSockets every second with a 60-second pong timeout. A webview integration must transport WebSockets, not just render initial HTML. These ping settings are pinned implementation details rather than a promised protocol contract. [Pinned nginx guide](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/docs/guides/deploying/deploying_nginx.md), [server Uvicorn configuration](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/marimo/_server/start.py#L427-L445)
- The non-sandbox session implementation uses a **process for edit** and a **thread for run**; sandbox/configured-venv edit kernels use IPC, and multi-app run sessions can use an app-host path. Avoid summarizing all deployments as one identical kernel model. Each session owns kernel state and communication. [Pinned session implementation](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/marimo/_session/session.py#L132-L196)
- `edit --session-ttl` defaults to `None` (documented as no automatic session closing); `run --session-ttl` defaults to **120 seconds after WebSocket disconnect**. **`edit --timeout N` is a distinct global server timeout in minutes without a connection.** No `run --timeout` is exposed in the inspected reference. Dropping a webview connection is therefore not synonymous with stopping the server process. [CLI reference](https://docs.marimo.io/cli/)
- Server interrupt/lifespan cleanup calls `SessionManager.shutdown()`, and session close closes its room/consumers and kernel. The CLI includes subprocess-reaping cleanup. These confirm an existing upstream cleanup path; they do not establish a public HTTP shutdown endpoint. [Pinned lifespans](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/marimo/_server/api/lifespans.py#L222-L245), [session close](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/marimo/_session/session.py#L500-L520)
- `edit --watch` streams externally saved notebook changes into the editor. **By default the new code is marked stale, not automatically executed**; users run stale cells explicitly. `[tool.marimo.runtime] watcher_on_save = "autorun"` opts into execution on save. `run --watch` refreshes the browser/app from fresh state. `watchdog` improves watching; otherwise the run watcher polls every second. Module autoreload and `mo.watch.file`/`directory` are separate features, not the notebook-file flag. [Watching guide](https://docs.marimo.io/guides/editor_features/watching/), [CLI watcher help](https://docs.marimo.io/cli/)
- Upstream documentation says watching works best with autosave enabled, while the pinned server emits a warning that watch mode may interfere with autosave. Treat simultaneous external writes and browser edits as something requiring a defined workflow, not proven conflict-free collaboration. [Watching guide](https://docs.marimo.io/guides/editor_features/watching/), [pinned warning](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/marimo/_server/start.py#L270-L271)

#### Dependencies and agent collaboration

- Project environments share requirements and a lockfile, e.g. `uv run marimo edit notebooks/explore.py`. Sandbox environments store notebook-specific Python requirements and dependencies in **PEP 723** script metadata. `marimo edit --sandbox notebook.py` uses uv; `--sandbox=pixi` is the alternative. Bare `--sandbox` is accepted despite the generated option table showing a choice: the custom Click wrapper normalizes the bare form to uv. [Package guide](https://docs.marimo.io/guides/package_management/), [sandbox guide](https://docs.marimo.io/guides/package_management/sandboxes/), [pinned CLI wrapper](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/marimo/_cli/help_formatter.py)
- The sandbox editor server starts separately from the notebook environment, stays available while packages install, and remains available on installation failure so requirements can be repaired. Installing/removing packages through its package panel updates both environment and metadata. Sandboxes do not inherit surrounding project packages; local editable sources need explicit tool metadata. **Sandbox means dependency isolation, not file/network access restriction.** [Sandbox guide](https://docs.marimo.io/guides/package_management/sandboxes/)
- Creating lockfiles is a separate step: `uv lock --script notebook.py` produces `notebook.py.lock`; Pixi produces `notebook.py.pixi.lock`. Inline requirements alone do not imply exact reproducibility. [Sandbox locking guide](https://docs.marimo.io/guides/package_management/sandboxes/#lock-dependency-versions)
- **Current upstream has a purpose-built agent path: `marimo pair`.** The pinned guide recommends it for Claude Code, Codex, and OpenCode collaboration; its CLI can list notebooks/sessions and execute Python in a live notebook scratchpad. The CLI itself documents `marimo._code_mode` for inspecting, creating, editing, running, and deleting cells. Although the module name has an underscore, this particular access path is explicitly taught upstream; it should not be dismissed as an undocumented accidental import. Neither that fact nor CLI documentation establishes a long-term version-stability guarantee. [Pinned pair guide](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/docs/guides/generate_with_ai/marimo_pair.md), [pinned pair CLI](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/marimo/_cli/pair/commands.py)
- Pair guidance says **do not edit the live notebook file directly; use code mode as the write path**. Scratchpad execution is temporary; only code-mode edits persist. Newly created/edited cells need an explicit `run_cell` call, methods are not awaited inside the required `async with`, and edits apply when the block exits. Session IDs can change on page reload; `--file` resolves the current session, with `--session` needed when ambiguous. A headless server has no live session until the notebook is opened in a browser/webview. [Pinned pair CLI guidance](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/marimo/_cli/pair/commands.py#L206-L266), [no-session/error guidance](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/marimo/_cli/pair/commands.py#L402-L529)
- Authenticated servers are excluded from tokenless local server discovery. For an authenticated launcher, give pair the explicit `--url` and `--token-file`; do not disable auth just to enable discovery. [Pinned server registry](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/marimo/_server/api/lifespans.py#L249-L268), [pair list implementation](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/marimo/_cli/pair/commands.py#L802-L826)

#### Verified command forms versus proposed SANE composition

**Verified upstream forms** (checked against documentation/source, not executed):

```sh
marimo edit notebook.py
marimo edit --sandbox notebooks/
marimo run notebook.py --headless --host 127.0.0.1 --port 2718
marimo run notebook.py --watch --include-code
uv run marimo edit notebooks/explore.py
uv lock --script notebook.py
```

Sources: [CLI reference](https://docs.marimo.io/cli/), [sandbox guide](https://docs.marimo.io/guides/package_management/sandboxes/), [project environment example](https://docs.marimo.io/guides/package_management/).

**Proposed launcher composition, NOT an upstream SANE example and NOT integration-tested:**

```sh
marimo edit .sane/notebooks/explore.py \
  --headless --host 127.0.0.1 --port 2718 \
  --token --token-password-file /path/to/generated-token-file \
  --sandbox=uv
```

Use a selected available port, not a permanently assumed 2718. Add `--watch` only for an external-file-edit workflow. Add `--base-url /science` and an appropriate `--proxy` only if an actual reverse proxy exists. All shown flags are upstream-supported; choice of path, launcher ownership, and webview routing are proposals. [CLI reference](https://docs.marimo.io/cli/), [pinned proxy validation](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/marimo/_cli/cli_validators.py)

**Proposed agent composition using verified current pair options** (requires the user to open the notebook first):

```sh
marimo pair notebook list \
  --url http://127.0.0.1:2718 --token-file /path/to/generated-token-file

marimo pair execute \
  --url http://127.0.0.1:2718 \
  --file .sane/notebooks/explore.py \
  --token-file /path/to/generated-token-file \
  --code-file - <<'PY'
import marimo._code_mode as cm
async with cm.get_context() as ctx:
    for cell in ctx.cells.values():
        print(cell.id, cell.code, cell.status, cell.errors)
PY
```

The actual file key should come from the session listing/page workspace; a relative path may need adjustment for a directory-root server. This example only inspects cells. [Pinned pair CLI](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/marimo/_cli/pair/commands.py)

### Inferences

- The lowest-upstream-coupling native-Python option is an optional launcher managing the official CLI subprocess and loading its frontend URL, not rebuilding marimo's editor inside SANE. Expose edit and app modes separately. This follows the documented mode distinction and the public ASGI restriction below. [CLI reference](https://docs.marimo.io/cli/), [ASGI source](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/marimo/_server/asgi.py)
- Keep scientific dependencies/environment provisioning optional. Prefer a project environment when notebooks share a scientific stack, or notebook sandboxes when experiments need independent dependencies. Pin the supported marimo version for initial integration and make upgrades deliberate. These are recommendations, not upstream SANE configuration requirements. [Package-management workflows](https://docs.marimo.io/guides/package_management/), [release](https://github.com/marimo-team/marimo/releases/tag/0.25.1)
- Prefer pair's live-cell editing for simultaneous user/agent collaboration; reserve disk editing plus watch for a distinct external-editor workflow, rather than combining both as competing write paths. [Pair guidance](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/marimo/_cli/pair/commands.py#L246-L266), [watch behavior](https://docs.marimo.io/guides/editor_features/watching/)

### Gaps

- No general stable/public editor REST or WebSocket protocol, SDK contract, or API compatibility guarantee was established by the inspected primary sources. The documented CLI and explicitly public ASGI builder are preferable boundaries; internal `_server.start`, session/workspace classes, message formats, and route handlers are inspected implementation, not recommended imports.
- No webview-engine compatibility check, cookie/token bootstrap verification, path handling test, signal/parent-death test, or autosave conflict test was performed. These are integration prerequisites, not established upstream facts.

## 2. Can a custom Python/ASGI service embed the editor, and what is public?

### Takeaway

**The public `marimo.create_asgi_app()` builder is supported for hosting notebook apps, but explicitly supports RUN mode only.** It is appropriate for published interactive views and framework middleware, not a substitute for `marimo edit` when users need code editing. A custom editable service would couple to private internals or wrap the CLI. [Pinned public builder](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/marimo/_server/asgi.py)

### Cited Findings

- `create_asgi_app` is exported in top-level `marimo.__all__`; its docstring explicitly calls it **Public API** and says it only works for applications in Run mode. Its builder constructs `SessionMode.RUN` with a `NoopLspServer`. There is **no `mode="edit"` argument** in the inspected signature. [Top-level export](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/marimo/__init__.py), [builder implementation](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/marimo/_server/asgi.py)
- The builder offers `with_app(path=..., root=notebook_file)`, `with_dynamic_directory(path=..., directory=...)`, and `build()`. Dynamic directories can discover notebooks without restarting; callbacks and per-app middleware are supported. `with_dynamic_directory` requires a **non-empty non-root path**, e.g. `/apps`; `path=""` or `/` is rejected. The middleware exposes `scope["marimo_app_file"]`, explicitly labeled public in the implementation. [Programmatic deployment docs](https://docs.marimo.io/guides/deploying/programmatically/), [pinned builder/dynamic middleware](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/marimo/_server/asgi.py)
- Public builder arguments include `quiet=False`, `include_code=False`, `token=None`, `skew_protection=False`, `session_ttl=120`, `asset_url=None`, `redirect_console_to_browser=False`, `show_tracebacks=False`, `html_head=None`, and `execute_opengraph_generators=False`. No public `watch`, `sandbox`, `host`, or `port` argument exists here. Host/port are owned by the ASGI server. No token means an empty auth token; supplying middleware/auth policy is the embedder's responsibility. [Pinned signature and builder](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/marimo/_server/asgi.py)
- Framework integration is officially documented with FastAPI `app.mount("/", builder.build())` and `uvicorn.run(...)`; implementing a new kernel/service protocol is unnecessary for run-mode hosting. Each mounted notebook serves its assets below its own URL path. Authentication/metadata middleware must be **pure ASGI**, not only Starlette `BaseHTTPMiddleware`, so it applies to both HTTP and WebSocket scopes. `mo.app_meta().request` exposes request data/user metadata inside a notebook. [Programmatic deployment docs](https://docs.marimo.io/guides/deploying/programmatically/)
- Programmatic deployment documentation describes a computational kernel in a separate sub-thread for each session and warns about horizontal scaling/multiple workers: use sticky sessions, and prefer vertical scaling. **Qualification:** pinned ASGI source also honors experimental `isolate_apps`; pinned session source has app-host branches. The doc's thread description is a default operational model, not proof every possible configuration is same-process. [Operational documentation](https://docs.marimo.io/guides/deploying/programmatically/), [ASGI implementation](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/marimo/_server/asgi.py), [session branches](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/marimo/_session/session.py#L132-L196)

**Verified upstream Python shape**, copied in reduced form from the pinned builder example; not executed:

```python
import marimo
import uvicorn

builder = (
    marimo.create_asgi_app()
    .with_app(path="/app", root="app.py")
    .with_app(path="/app2", root="app2.py")
)
app = builder.build()

if __name__ == "__main__":
    uvicorn.run(app, port=8000)
```

This serves read-only-source **interactive apps**, not two editable notebooks. [Pinned source example](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/marimo/_server/asgi.py)

### Inferences

- An optional custom Python service is defensible later when SANE needs centralized run-app routing/authentication/custom middleware. For the initial editable-exploration feature it adds service code without providing a public editor API. A CLI child plus webview is the clearer supported boundary. [Public builder restriction](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/marimo/_server/asgi.py), [CLI reference](https://docs.marimo.io/cli/)
- “Dynamic directory” means dynamic app lookup, not live source editing, and should not be represented as an editor workspace or documented `--watch` equivalent. The two features have different documented contracts. [Dynamic-directory docs](https://docs.marimo.io/guides/deploying/programmatically/#dynamic-directory), [watching docs](https://docs.marimo.io/guides/editor_features/watching/)

### Gaps

- No supported public ASGI EDIT builder, stable editor-control Python API, or browser-component API for reconstructing the editor was found in the inspected sources. This is bounded research, not a proof no such undocumented experiment exists elsewhere.
- Exact freshness of already-open sessions after external file changes in dynamic-directory ASGI mode was not established. Do not infer it from discovery of newly added apps.
- Embedded ASGI lifespan composition/cleanup under a parent framework was not experimentally verified; the documented example alone is not a SANE lifecycle verification.

## 3. Is browser/WASM an equivalent local scientific notebook backend?

### Takeaway

**WASM is an official editable-or-run interactive distribution path, but is not equivalent to native Python scientific execution or automatic persistence into `.sane/`.** Prefer it for lightweight previews, educational/shared notebooks, or a deliberately constrained optional mode—not as the default for arbitrary scientific libraries, filesystem workflows, or heavy computation. [Pinned WASM guide](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/docs/guides/wasm.md)

### Cited Findings

- WASM notebooks run Python entirely in the browser using **Pyodide**, with no Python backend. Official paths include molab/GitHub previews, `marimo export html-wasm`, and an ephemeral `marimo.app` playground. The playground does not save notebooks. Upstream recommends regular machine/server execution for heavy computation. [Pinned WASM guide](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/docs/guides/wasm.md)
- `marimo export html-wasm notebook.py -o output_dir --mode edit` exports an editable browser notebook; `--mode run` is the read-only-source app mode and the default. `--show-code` affects code display in run mode, not permission to edit. `--watch` reexports changes to the original file. These are official CLI options, not a proposed invented `marimo wasm serve` command. [CLI reference](https://docs.marimo.io/cli/#marimo-export-html-wasm), [pinned export guide](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/docs/guides/exporting/webassembly_html.md)
- Default exports must be served over HTTP. `--single-file` produces one HTML file using CDN assets and can open directly, but requires Internet access. Browser runtime/packages otherwise download from hosted sources by default. Version 0.25.1 also exposes `--offline` to download runtime/packages into the export directory; offline export requires Playwright and a working Chromium installation to resolve packages. `--single-file` cannot be combined with `--offline` or `--include-cloudflare`; `--execute` cannot be combined with `--watch`. “No Python server” does not imply “no HTTP serving or asset network requirements,” and offline generation has additional provisioning requirements. [Pinned export CLI](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/marimo/_cli/export/commands.py#L983-L1079), [pinned export guide](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/docs/guides/exporting/webassembly_html.md)
- **Rolling-doc/version discrepancy:** on the research date, the live CLI reference additionally listed `--pyodide-index-url` and `--pypi-index-url` for offline exports. Neither argument is present in the pinned 0.25.1 export CLI signature/decorators. These are observable rolling-doc options, **not verified options for 0.25.1**; do not use them in a 0.25.1 launcher or attribute them to a guessed future release. [Live CLI reference](https://docs.marimo.io/cli/#marimo-export-html-wasm), [pinned export implementation](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/marimo/_cli/export/commands.py#L927-L1007)
- Pure-Python wheels and Pyodide-provided scientific packages are supported, including NumPy, SciPy, scikit-learn, pandas, matplotlib, duckdb, and polars. Missing packages can auto-install or be installed using `micropip`. This is **not arbitrary native-wheel compatibility**. Platform markers such as `sys_platform != 'emscripten'` can exclude native-only dependencies from PEP 723 metadata. WASM cannot install Conda dependencies. [Pinned WASM guide](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/docs/guides/wasm.md), [sandbox platform notes](https://docs.marimo.io/guides/package_management/sandboxes/)
- At this release, upstream documents cooperative adapters for some threading and multiprocessing-shaped APIs. They do **not** create native OS threads/processes or CPU parallelism; some tasks serialize, termination is cooperative, and locks/conditions/semaphores/shared memory/managers and several native process APIs are unsupported. Therefore the blanket older summary “no threading or multiprocessing APIs exist” is also inaccurate. PDB is unsupported; the documented memory limit is **2 GB**. [Pinned limitations](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/docs/guides/wasm.md#limitations)
- Data can be bundled in an adjacent `public/` directory that export copies; `mo.notebook_location()` constructs a path usable locally and in the export. Web-hosted data can be fetched subject to CORS. This documented flow does not grant direct access to arbitrary local `.sane/` files. [Pinned data inclusion](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/docs/guides/wasm.md#including-data)
- Latest Chrome, Firefox, Edge, and Safari are listed as supported; Chrome is recommended for performance/compatibility. This statement is not a verification of a desktop app's particular embedded WebKit/Chromium runtime. [Pinned browser support](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/docs/guides/wasm.md#browser-support)
- Upstream documents whole-page iframe embedding, self-hosted WASM HTML embedding, and marimo islands for individual outputs. An iframe needs `allow-scripts`; other attributes enable storage, downloads, forms, popups, microphone, and fullscreen. With scripts only, upstream says WebSockets function but storage is in memory and clipboard prompts are used. This supports an **URL/iframe embedding architecture**, not an established React component or custom RPC contract for a SANE editor. **Islands are explicitly an early/preview feature not yet considered stable**, despite the top-level exported generator. [Embedding guide](https://docs.marimo.io/guides/publishing/embedding/), [pinned islands status](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/docs/guides/exporting/webassembly_html.md#embed-marimo-outputs-in-html-using-islands)
- Directory exports can bundle locally imported Python modules as pure-Python wheels (resolution requires uv), explicit local wheels, and execution caches. Single-file exports do not bundle `public/`, local modules/wheels, or caches. With `cache_cells=true` and `--execute`, native-only computations can be previewed from cached outputs, but editing cells or changing inputs invalidates caches and may require unavailable native dependencies to recompute. Cached native objects can hydrate as stubs; this is **not native package execution in the browser**. [Pinned module and cache export guide](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/docs/guides/exporting/webassembly_html.md)

**Verified current export command forms**, documentation/source checked only:

```sh
marimo export html-wasm notebook.py -o output_dir --mode edit
marimo export html-wasm notebook.py -o output_dir --mode run
marimo export html-wasm notebook.py -o output_dir --offline
marimo export html-wasm notebook.py -o notebook.html --single-file
```

The directory form is HTTP-served; the single-file form depends on CDN access. Do not combine forms/options without checking the pinned command's constraints. [CLI reference](https://docs.marimo.io/cli/#marimo-export-html-wasm), [pinned export guide](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/docs/guides/exporting/webassembly_html.md)

### Inferences

- Recommended comparison: **official CLI edit = primary editable scientific workspace; CLI run = publish/view interactive app; public ASGI = custom run-app host; WASM export = constrained portable preview/editor**. Optional `sane-science` packaging is a reasonable proposed ownership boundary for native environment provisioning/server lifecycle, but marimo does not dictate that package layout. [CLI modes](https://docs.marimo.io/cli/), [public ASGI restriction](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/marimo/_server/asgi.py), [WASM architecture](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/docs/guides/wasm.md)
- Editing a WASM-exported frontend is not established as saving changes to the source notebook on disk. Persisting browser edits to `.sane/` would require a separately verified bridge/workflow; absent that, label WASM as preview/export rather than the authoritative project editing path. [Ephemeral/browser execution distinction](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/docs/guides/wasm.md), [export guide](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/docs/guides/exporting/webassembly_html.md)

### Gaps

- No documented stable postMessage bridge/API for saving an embedded WASM editor back to `.sane/`, or for connecting native `marimo pair` to its Pyodide interpreter, was established. Do not infer either from the editable export flag.
- No local webview WASM performance, JSPI support, offline export dependency resolution, native widget/package compatibility, or browser persistence test was performed. Treat these as follow-up validation, not confirmed capabilities.
- Deep security policy and SANE webview/process capabilities are outside this upstream-only scope; iframe requirements and dependency-sandbox limitations above are interoperability facts, not a complete threat analysis.
