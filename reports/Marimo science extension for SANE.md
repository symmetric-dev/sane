# Add scientific notebooks without rebuilding marimo

**Build an optional `sane-science` package that supervises the official `marimo edit` CLI, rather than creating a Python editor microservice.** Keep notebook source beneath the initialized repository’s `.sane/science/`, and expose a dedicated Science surface beside agent chat. Default the feature off, with no mandatory Python dependency, installation, or runtime probing when disabled. Start with trusted, same-machine execution, loopback-only networking, an isolated notebook origin, and one serialized writable session per notebook. Use a pinned, integration-verified `marimo pair` adapter for agent collaboration, with save-and-close source patching as fallback. Remote PWA access and untrusted execution require separate deployment and containment designs; neither follows automatically from embedding a notebook ([CLI](https://docs.marimo.io/cli/), [public ASGI source](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/marimo/_server/asgi.py), [security](https://docs.marimo.io/security/)).

**Evidence boundary:** research notes and narrow repository checks dated 2026-10-06; application files include existing uncommitted work. Upstream baseline is **0.25.1**, released October 1, commit `92fbbbee742eccf4c88dbc2afee16167e34dc7d5`. One worker inspected newer main commit `c4de758…`; rolling docs are not a release contract. Everything described as proposed below is new SANE work. No tests, builds, installs, browser checks, or notebook execution were performed ([release](https://github.com/marimo-team/marimo/releases/tag/0.25.1)).

## The CLI supplies editing; ASGI and WASM serve different needs

| Runtime | Confirmed upstream capability | Recommended SANE role |
| --- | --- | --- |
| CLI `edit` | Editable Python notebooks, reactive execution, HTTP and WebSocket frontend | Authoritative native scientific workspace |
| CLI `run` | Interactive widgets/computation without source editing; `--include-code` only displays code | Later publish/view mode, with explicit authentication |
| Python `create_asgi_app()` | Public builder explicitly supports **RUN only**, not `mode="edit"` | Later custom run-app routing/authentication, not the editor MVP |
| WASM/Pyodide | Browser execution; `export html-wasm --mode edit` provides an editable export | Constrained previews/portable notebooks; `.sane` writeback requires new integration |

These distinctions follow the [CLI](https://docs.marimo.io/cli/), [pinned ASGI builder](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/marimo/_server/asgi.py), and [pinned WASM guide](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/docs/guides/wasm.md). A custom editable Python service would wrap the same CLI or depend on private server internals, adding maintenance without a public editor API. WASM avoids a Python backend but not asset serving/provisioning, native-library limitations, or persistence work. Native marimo requires Python **3.10+**; scientific-stack compatibility remains workload-specific ([package metadata](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/pyproject.toml)).

After initialization and consent, the proposed launcher passes a **canonical explicit notebook file**, not a repository directory scan:

```sh
marimo edit /primary/repo/.sane/science/project/notebooks/explore.py \
  --headless --host 127.0.0.1 --port <selected-port> \
  --token --token-password-file <private-token-file> --skip-update-check
```

This is illustrative argument composition, not an executed command; placeholders are replaced and passed as an argument vector without a shell. All flags exist in [0.25.1 CLI source](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/marimo/_cli/cli.py). Omit `--watch` for live pairing and `--sandbox` for a reviewed pre-provisioned environment. Headless suppresses browser launch; opening the frontend still creates the live session. Readiness must confirm the owned instance. An explicitly occupied port fails; omitted ports can advance beyond 2718 ([server startup](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/marimo/_server/start.py)).

## SANE needs a dedicated adapter, not an extension framework

SANE App is a **Bun-served React application/PWA**, not an evidenced native desktop webview. Its existing Browser embeds arbitrary URLs without proxying; it does not own notebook identity, authentication, or processes. `frontend/app.tsx` explicitly composes feature providers and mutually selected surfaces. Add a Science provider/header/sidebar/view plus a **resizable desktop chat–notebook split**, retaining mounted editor state; collapse to labeled tabs on narrow screens. Show notebook, execution checkout, runtime status, trust, and edit/run authority. Switching existing views alone does not deliver simultaneous collaboration ([App composition](../packages/sane-app/frontend/app.tsx#L175-L275), [Browser](../packages/sane-app/frontend/browser-view.tsx#L64-L124), [PWA](../packages/sane-app/frontend/pwa-install.ts#L16-L37)).

Proposed `packages/sane-science` owns browser-safe contracts, confined notebook storage/manifests, environment/version qualification, CLI/pair adapters, tokens, readiness, bounded logs, process ownership, and recovery. It can depend on core repository contracts, but not App/CLI. App owns shell UI, browser authentication, capability exposure, and thin service integration. **No general plugin registry exists in the audited seams or is needed.** The OpenCode plugin is native-agent integration, not an App extension host ([package boundaries](../packages/sane-core/package.json), [native plugin](../opencode/plugins/sane/index.ts)).

Concrete host changes are `src/app-config.ts`, bridge `Options`/`runtimeOptions` and `/api/config`, frontend `types.ts`, static navigation/command gating, and lifecycle wiring in `src/bridge.ts`, including startup abort and normal shutdown. Its WebSocket handler is currently terminal-specific, not a general relay. Choose frontend-only Science selection initially, following Browser’s special persistence handling; persisted selection instead requires extending `catalog-contract.ts` and backend validation ([bridge seams](../packages/sane-app/src/bridge.ts#L3007-L3009), [shutdown](../packages/sane-app/src/bridge.ts#L3105-L3186), [navigation](../packages/sane-app/frontend/catalog.ts#L5-L54)).

**Illustrative proposed App-config fragment—not accepted today and not a complete config:**

```json
{
  "science": {
    "enabled": false,
    "executable": "/absolute/reviewed/environment/bin/marimo"
  }
}
```

The current versioned App config rejects unknown keys; parser, validation, setup serialization, runtime conversion, and capabilities must change together. This is **installation-level availability**, not repository trust or execution consent. Separately propose extension-owned repository preferences/manifests after domain initialization; no existing repository Science-config convention was found. Repository content cannot override operator disablement or grant itself trust ([strict config](../packages/sane-app/src/app-config.ts#L9-L108), [setup](../packages/sane-app/setup.ts)).

Default-off means no Python probe/spawn, listener, watcher, downloads, notebook enumeration, or `.sane` creation. Separate runtime optionality from physical packaging: current packages are private workspaces, and the fixed frontend entry cannot statically import an absent package. Independently installable `sane-science` therefore needs a deliberate optional-loader/build distribution contract, not just a switch ([workspace](../package.json), [fixed build](../packages/sane-app/src/asset-build.ts#L75-L87)).

## Initialize first and separate scientific source from authority state

**Creating `.sane/science` before `sane init` blocks initialization:** core refuses nonempty uninitialized stores. After ready-store validation, an extra namespace is compatible in principle, but receives no automatic safety guarantees. Ordinary App file APIs deny `.sane`, while core artifact APIs require Markdown. Implement dedicated notebook APIs; do not weaken those protections or repurpose `sane.db` ([initialization](../packages/sane-core/src/repository.ts#L289-L354), [workspace guard](../packages/sane-app/src/workspace.ts#L75-L123), [artifact restriction](../packages/sane-core/src/server.ts#L42-L44)).

Proposed layout:

```text
<primary>/.sane/science/<project-id>/
  manifest.json                    # notebook IDs, checkout binding, preferences
  notebooks/<notebook-id>.py        # durable source
  pyproject.toml + uv.lock          # chosen shared-environment policy
  src/ + data-manifest.json        # helpers and input identities
  runs/<run-id>/provenance.json     # hashes, versions, parameters, outcomes
  runs/<run-id>/artifacts/          # bounded retained outputs
<private-installation-runtime>/<instance-id>/
  environment/ + logs/ + token + ownership-record
```

Alternatively choose PEP 723 metadata plus adjacent `.py.lock`, not two competing dependency authorities. Environments and locks support reproducibility, **not security containment**. Record source/lock/input/output hashes, Python/marimo versions, platform, actual cwd, parameters, seeds, and execution outcome ([environment guide](https://docs.marimo.io/guides/package_management/sandboxes/)).

Canonical state belongs to the **primary checkout**, while execution can target a linked worktree. Pin repository/notebook/worktree/binding revision and require explicit relaunch on checkout changes; define cwd/import/data roots. Current managed-worktree commands are unavailable, so do not invent `.sane/managed` behavior ([repository discovery](../packages/sane-core/src/repository.ts#L16-L55), [worktree stubs](../packages/sane-cli/src/sane-worktree-command.ts)). SANE must enumerate registered notebook IDs and invoke exact files: marimo skips hidden children during scanning. Explicit-file support under `.sane` remains an integration check ([scanner](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/marimo/_server/files/directory_scanner.py)).

This checkout and newly created workspaces ignore `/.sane/`; core init does not universally establish ignore rules. Require backup/export or carefully designed selective source versioning—never force-add the entire authority tree. Classify adjacent `__marimo__` caches/snapshots separately; some exports execute notebooks and need consent ([ignore](../.gitignore#L9-L12), [workspace creation](../packages/sane-app/src/create-workspace-repository.ts#L20-L23), [export/session docs](https://docs.marimo.io/guides/exporting/sessions/)).

## Isolate notebook content and keep remote deployment separate

**Executable notebook output must not share SANE’s privileged App origin.** The Browser already refuses its own origin; removing that guard for `/science` would allow notebook scripts to make authenticated App API requests. HttpOnly cookies and path prefixes do not prevent this. Use an isolated science origin with no App/native bridge, minimal frame permissions, and reviewed cookie boundaries; another port gives a distinct origin but does not independently isolate host cookies ([Browser guard](../packages/sane-app/frontend/browser-view.tsx#L97-L124), [App auth](../packages/sane-app/src/bridge-auth.ts#L35-L67), [trusted outputs](https://docs.marimo.io/security/)).

For least exposure, propose one explicit-file loopback child behind an **app-owned, isolated-origin local gateway** that injects upstream authentication, accepts only the owned target, and exposes only required HTTP/WebSocket routes. This gateway is new work, including asset/socket routing, exact Host and approved HTTP/WS Origin checks, header/cookie stripping, and server-side exclusion of terminal/unneeded auxiliary routes. Fail closed on unexpected or null browser origins. Do not assume CORS covers WebSockets or that hiding editor controls removes backend capabilities. Qualify iframe sandbox/CSP/auth behavior before shipping; external opening is a compatibility fallback, not a replacement for the required embedded experience ([proxy deployment](https://docs.marimo.io/guides/deploying/deploying_nginx/), [security](https://docs.marimo.io/security/)).

Use random per-instance tokens via private files/stdin; redact startup token URLs/logs, never persist credentials in tabs or agent transcripts, and rotate/revoke on stop/logout. Do not hand agents the raw coarse editor credential or forward SANE cookies through the gateway. **Authentication is not execution consent.** Python still runs with OS-user access: validate effective project configuration, disable dotenv/startup commands/autorun, minimize inherited secrets, and approve installs/index changes separately. Origin isolation does not prevent Python reaching local SANE services or reading same-user token files. Reviewed environments and marimo “sandboxes” do not restrict filesystem/network access; untrusted workloads require separately designed OS-enforced isolation ([authentication](https://docs.marimo.io/guides/deploying/authentication/), [runtime configuration](https://docs.marimo.io/guides/configuration/runtime_configuration/), [sandbox limits](https://docs.marimo.io/guides/package_management/sandboxes/)).

A phone’s `127.0.0.1` is **the phone**, not the SANE host. Local HTTP embedding also cannot be promised inside an HTTPS App without verification. Remote PWA support requires an operator-provisioned isolated HTTPS science origin/gateway, complete authenticated HTTP/WS forwarding, and revocation—not existing `publicOrigin` settings alone ([current limitations](../packages/sane-app/frontend/browser-view.tsx#L69-L74), [remote configuration](../packages/sane-app/src/app-config.ts#L134-L142)).

## Serialize collaboration and prove ownership before release

Upstream `marimo pair` exists in 0.25.1. Bind its verified `--url`, `--token-file`, and `--file`/unambiguous session targeting inside the adapter after the frontend opens. Its taught `_code_mode` path offers stale-cell checks and transactional validation but explicitly lacks version guarantees. Preserve protections; do not expose arbitrary `pair execute` as “read-only.” SANE must mediate bounded inspect/propose/apply/run permissions, matching repository, notebook, server generation, and cell versions ([pinned pair](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/marimo/_cli/pair/commands.py), [code-mode context](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/marimo/_code_mode/_context.py)).

Maintain one writable lease across App installations. Fence competing UI edits/state-changing interactions during agent application; if fencing cannot be verified, use the fallback: save/close editor, checkpoint hash, review candidate patch, static `marimo check --strict --format json`, recheck base identity/hash, publish atomically, reopen. Ordinary agent shell writes remain cooperative unless constrained. Watching is not merging: docs favor autosave, while pinned startup warns about interference. Never promise conflict-free simultaneous edits or run-on-save. Source acceptance, durable save, and execution completion need separate acknowledgements; ambiguous execution must not be automatically retried ([watching](https://docs.marimo.io/guides/editor_features/watching/), [pinned warning](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/marimo/_server/start.py), [check CLI](https://docs.marimo.io/cli/)).

Track server/kernel/helper ownership and generation, not one PID. Stop on disable, workspace close, logout, startup failure, App shutdown, and crash recovery; revoke grants, request orderly shutdown, escalate bounded termination, and verify owned listeners/processes disappear. Kernels can own separate groups; escaped descendants defeat simplistic group killing. Preserve `cleanup-unconfirmed` and block duplicate launch when uncertain. Session TTL/inactivity timeout are backstops, not supervision ([process helpers](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/marimo/_utils/subprocess.py), [SANE termination precedent](../packages/sane-app/src/claude-run-service.ts#L197-L218)).

**Proposed phases:** first establish optional packaging/config, initialized storage, trust, and isolated transport; next deliver explicit-file editing, chat split, lifecycle/recovery, and source backup; then qualify pinned pairing and reproducibility, retaining the closed-editor fallback. Add remote access, ASGI publication, or WASM only as separately scoped capabilities.

**Acceptance checklist—proposed, not run:**

| Gate | Required evidence |
| --- | --- |
| Off/install | No Python probing, downloads, processes, listeners, watchers, or repository writes; disabled commands unavailable |
| Storage | Init order, exact hidden-file open/save/reload, path aliases/replacements, worktree binding, backup and ignored outputs verified |
| Isolation/auth | Notebook browser content cannot exercise App privileges; trusted Python host access disclosed; tokens absent from persisted URLs/logs; required HTTP/WS authenticated; auxiliary routes denied; remote local-only mode rejected |
| Collaboration | One writer; stale edits reconcile; UI fencing or closed-editor fallback works; durable save confirmed; reload targets and unconfirmed execution handled |
| Consent/replay | Startup/save do not execute; installs/config trust separated; dependency execution scope visible; clean replay captures hashes/versions/outcomes |
| Cleanup | Startup failure, disconnect, crash, PID/port reuse and separate child groups reconciled; uncertainty blocks relaunch |

## Conclusion

The key ownership decision is not “Bun or Python service”; it is who controls notebook identity, writable authority, browser isolation, and kernel lifetime. Resolve physical package distribution, environment policy, backup/versioning, and local-only acceptance before implementation. Preserve unresolved evidence: rolling WASM docs contain index flags absent from 0.25.1, and official security surfaces disagree on historical affected ranges despite agreeing on fixes. These discrepancies justify pinned-source qualification, not invented compatibility or claims that the current release is vulnerable ([pinned export source](https://github.com/marimo-team/marimo/blob/92fbbbee742eccf4c88dbc2afee16167e34dc7d5/marimo/_cli/export/commands.py), [security docs](https://docs.marimo.io/security/), [terminal advisory](https://github.com/marimo-team/marimo/security/advisories/GHSA-2679-6mx9-h9xc)).

## Source notes

The three supplied evidence records are [runtime](../research_notes/Marimo%20science%20extension%20for%20SANE/marimo-runtime.md), [SANE integration](../research_notes/Marimo%20science%20extension%20for%20SANE/sane-integration.md), and [collaboration/security](../research_notes/Marimo%20science%20extension%20for%20SANE/collaboration-security.md). Inline links identify primary documentation, pinned upstream source, and current repository files; no active workstream or report-template registration was assumed.
