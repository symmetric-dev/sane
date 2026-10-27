# SANE App

Browser App for native Claude Code/OpenCode conversations, repository/worktree
navigation, Code, Git and Terminal. Start with the [App documentation](../../docs/sane-app/README.md)
and [ongoing work](../../docs/sane-app/ongoing/README.md).

Private Bun workspace package. Chat, workspace navigation, Code, Git and
Terminal retain their source behavior. CC uses the installed `claude -p` and
native continuation; OC connects to an existing V2 service through
`@opencode/client`. Concurrent CC/OC runs are admitted, one App-owned run per
native conversation, default bridge capacity 24 (configurable 1–256 with
`--max-concurrent-runs`). Shared-checkout writes are allowed.

## Owner installation and launch

### Science performance architecture

Science submission discovery is an independent, single-flight frontend poll:
15 seconds after completion normally, 3 seconds while a local send or
prepared/unknown receipt is pending, with a 25-second request timeout. Selection,
authentication, store and lifecycle fences prevent stale publication; discovery
also finds sends from other clients (`frontend/store.ts`).

Each admitted native chat action holds a scoped, validated operation lease across
status, mapping and mutation (`src/science.ts`). Repository/worktree binding,
authorization and notebook ownership are checked around native awaits and before
publication. The callback capability expires on return; it is not reusable
authority. Marimo calls use a persistent authenticated HTTP adapter pinned to
0.25.1, with no per-call pair CLI subprocess. Outputs still require a fresh,
separate request after execution.

`src/science-store.ts` and `src/science-storage.ts` persist incremental history:
`science-storage.json` selects `science-history-<generation>`, with per-chat
`head.json` references to SHA-256-qualified `<hash>/record.json` records. Saves
reuse unchanged records and publish the changed chat head; adding a chat also
updates the marker. Files and directories are fsynced before references publish.
Writes are bounded, not constant-cost: heads and record comparisons still grow
with chat history. Each encoded record, head and marker is capped at 16 MiB;
chat metadata plus encoded records has a 32 MiB aggregate cap on reads and writes.
These are not a total on-disk quota; old records and crash remnants have no GC.

On bridge initialization, construction of `ScienceStore` automatically migrates
validated legacy `science-chats.json` if no marker exists (or initializes an empty
generation if neither exists). Legacy v1 is upgraded in memory; the legacy file
is left intact. The marker publishes last and is authoritative: invalid marker,
head or record data fences science storage rather than falling back to legacy.
`science-submissions.json` remains a separate ledger, capped at 2,000 receipts and
32,000,000 encoded bytes (`src/science-submission-store.ts`).

This performance increment has source/static review only: no runtime, browser or
user-data migration has been run for it. The user must restart the bridge and
reload the frontend to activate it; migration happens during that startup, not
on the first Python run. Storage assumes one App-owned writer and cooperative
local filesystem actors. Checked paths on macOS cannot exclude external syscall
races; neither storage checks nor the Python environment provide a sandbox.

### Science run timing diagnostics

The bridge appends one metadata-only JSON record per validated chat **run attempt**
to `<configured dataDir>/science-timing.jsonl` when the attempt finishes (including
failures and request reuse). Draft edits, polling, and other standalone actions do
not emit records. The previous file is retained as `science-timing.jsonl.1`;
rotation occurs before exceeding 2 MiB per file. Newly created files use mode 0600.
Appending is best effort, refuses symlink/non-regular/multiply-linked destinations,
and cannot change the run result. A crash or unwritable destination can lose records.
The sink assumes the App's single bridge writer for its data directory.

Example (abbreviated spans):

```json
{"version":1,"timestamp":"2026-10-10T12:00:00.000Z","attemptId":"uuid","requestId":"uuid","blockId":"uuid","conversationId":"uuid","durationMs":2450.125,"outcome":"succeeded","sessionEvidence":"existing-session","spans":[{"stage":"pair-execute-http-wall","offsetMs":42.5,"durationMs":390.25,"outcome":"completed"}],"droppedSpans":0}
```

`timestamp` is UTC attempt start. `attemptId` distinguishes retries with the same
request ID; the other IDs correlate the request, block and conversation. Durations
and offsets use monotonic `performance.now()` in milliseconds (rounded to 0.001).
Total duration covers backend chat handling, including persistence, but excludes
HTTP parsing, browser/render/network time and the final timing-log append.
Spans are appended in completion order, may nest/overlap, and **must not be summed**.
At most 1024 spans are retained (enough for repeated lease fences without the old
256-span truncation); `droppedSpans` counts omitted spans. `counters` is an
independent, bounded map of at most 64 fixed labels to occurrence counts.

Lease acquisition includes `catalog-mutation-queue-wait`, measured from admission
until the existing catalog mutation tail settles. Lease internals expose
`lease-capture`, `lease-check-pins`, `lease-check-mappings`, `lease-head-read`, `lease-rediscover`, and
`lease-validation-queue-wait`. Discovery's three async Git calls have separate
`catalog-git-toplevel`, `catalog-git-common-dir`, and `catalog-git-dir` spans;
these include spawn, output collection, process exit, cleanup and scheduling.
Git span `completed` means the wrapper returned, including nonzero exit codes;
`error` means it threw. No command arguments or outputs are recorded. Counters distinguish
`lease-acquired-{metadata,discovery}`, `lease-validation-{metadata,discovery}`,
`lease-rediscover-acquisition`, `lease-repair-binding`, and refresh reasons
`lease-refresh-config`, `lease-refresh-head-unsupported`, and
`lease-refresh-unsupported-snapshot`. Config and HEAD reasons can both increment
for one refresh; validation mode is sampled at entry, acquisition mode at return.

`eventLoopDrift` uses one unreferenced 25 ms interval per active attempt, cleared
before logging. It reports `intervalMs`, callback `samples`, `maxDriftMs`, and
`totalDriftMs`: each callback's nonnegative lateness against the previous callback
time plus the interval. `terminalOverdueMs` is lateness of the pending callback at
attempt completion (kept separate from sampled totals). This is a sampled lower
bound on observable timer lateness overlapping the attempt, **not a precise
blocking or CPU measurement**. It includes OS/runtime scheduler delays, timer
granularity, process suspension and unrelated work sharing the event loop. Short
stalls between samples can be missed; zero samples does not establish no stall.
Concurrent attempts observe the same loop and their drift must not be summed.
The summary uses constant memory and adds no per-tick spans.

`native-resolve` now contains sequential `native-resolve-catalog-lease` (or
`native-resolve-catalog-binding`), `native-resolve-router`, and
`native-resolve-execution-checkout-sync` spans. Inside the router, sequential
`native-router-catalog-get` (refreshes all catalog worktrees),
`native-router-catalog-binding` (selected checkout),
`native-router-discovery-sync` (core Git discovery),
`native-router-store-inspect-sync`, optional `native-router-domain-open-sync`
(cache miss), and `native-router-domain-validate-sync` identify the expensive
direct calls. Span occurrences count these calls, **not individual Git commands**.
Execution-checkout and domain validation may also invoke synchronous Git.
Optional `native-resolve-runtime-create-sync`, `native-resolve-invalidation-stop`
and `native-resolve-error-stop` expose initialization/cleanup costs.

`native-operation-pre-validation` and `native-operation-post-validation` bracket
the admitted native operation. These and the repeated inner fences contain
`native-validation`, whose sequential children are
`native-validation-catalog-lease` (or `native-validation-catalog-binding`),
`native-validation-domain-sync`, and `native-validation-publication-sync`.
Use offsets to place repeated fences before/after native steps. Only subtract
immediate, non-overlapping children from a parent to estimate its uncovered gap;
do not also subtract grandchildren. Gaps include uninstrumented bookkeeping,
timing overhead and scheduling. `-sync` measures elapsed blocking direct-call
time (including filesystem/Git subprocess waits), not CPU time. Async spans
include await/scheduling time; neither isolates CPU or Git subprocess runtime.
Instrumentation is caller-scoped to science and records fixed stage labels and
durations, never paths, config, source, tokens or raw errors.

For comparison, run the same inexpensive cell at least four warm repeats with fresh request
IDs in an already open notebook. Compare `existing-session` records, per-stage
durations/counts and uncovered gaps; exclude reused requests and check
`droppedSpans` is zero. Keep the first open-required run separate.

Stages cover binding/native resolution, readiness status, open/readiness or refresh,
inspection, edit, explicit edit verification, run, pair post-operation snapshot
capture, observation serialization and durable chat persistence. Repeated stage
names identify repeated calls using their offsets. Current
`pair-version-http-wall`, `pair-list-http-wall` and `pair-execute-http-wall` spans
cover token reading, HTTP transport, server work and response collection, without
a pair subprocess. Older logs contain `pair-*-process-wall` spans covering Python
startup/imports as well. Do not compare these labels as equivalent measurements;
the JSON example is illustrative, not new runtime evidence. Post-operation capture
is also included inside edit/run wall times. No kernel-only duration is claimed.

`sessionEvidence` is `existing-session` when the App found a managed notebook
session, `open-required` when it did not, or `unobserved` if that check was not
reached. This is reuse evidence, not proof of a warm/cold kernel or cache.
Top-level outcomes are `succeeded`, `failed`, `unknown`, `reused-request`,
`edit-unconfirmed`, `verification-unconfirmed`, `error`, or `incomplete`.
`error` means a thrown backend failure; native failures may instead yield
`failed`/`unknown`. Span outcomes are fixed diagnostic codes, not error messages;
`completed` means the call returned, not necessarily successful kernel execution.
Logs contain no cell source, output, raw errors, command arguments, tokens,
notebook names, native session IDs, URLs or filesystem paths. Correlation IDs
are retained as identifiers. Read both files after the user's runs; no restart
or execution is triggered by reading these logs.

Use [HUMAN-OPERATOR-GUIDE.md](HUMAN-OPERATOR-GUIDE.md) for exact commands.
There is no app-local lockfile; dependency versions follow the workspace root.
The launch contract is loopback binding, an explicit independent scratch
repository cwd, and a fresh absolute data path. `start` builds package-local
`public/assets/app.js` and `app.css` before launching source `server.ts`;
`build` builds assets only; `typecheck` checks backend, hooks and frontend.

## Install the browser interface

Open the App at a stable localhost/loopback URL or a trusted HTTPS origin. Use
**Install SANE** in the Application menu or Settings → Application when the browser
offers an install prompt. Otherwise use the browser's installation menu, Safari's
**File → Add to Dock** on Mac, or **Share → Add to Home Screen** on iPhone/iPad.

Installation creates a standalone frontend window, not a background App server or
native services. The bridge must remain running and reachable. No service worker,
offline cache, or queued offline mutations are installed. After updating, restart
the bridge and reload the installed app just as you would a browser tab.

## File previews and pairing (PoC)

Files and Browser use the same sidebar geometry. Browser tabs live in the sidebar;
paired views can switch that sidebar between Files/Tabs and Agent history. The
existing conversation composer stays mounted. On compact screens, Agent history
opens in the main pane while the navigation drawer remains available for files/tabs.
Switching top-level views retains their sidebar selection/visibility and the live
Files/Notebook presentation within the current authenticated worktree. It does not
reload a notebook merely because Chat or Browser was opened.

Use the sidebar's Paired sessions menu to link a conversation to a browser tab or
the selected worktree file. Source and Notebook presentations of one file share
links; selecting another file does not move the active pairing. Links are passive:
they neither send file/page content nor grant agent access. Host-browser Observe
and Control grants remain separate. Existing browser links keep their storage and
revision history; file links use `resource-pairs.json` in the App data directory.
Entering Browser or Files through primary navigation restores links only for the
currently selected conversation. The remembered resource wins when linked;
otherwise a matching linked resource in that browsing scope is selected. Entering
from Chat reveals Agent history. Closed browser tabs are never recreated, and an
unrelated conversation is never restored as a fallback. Ordinary file/search/link
navigation does not trigger this view-entry behavior.

For a `.py` file, choose **Configure Notebook view** in File actions or the notebook
setup panel. Use the top-row Source/Notebook selector. Configure an existing
marimo server URL and its notebook root relative to this exact worktree. For
example, a server launched for
`notebooks/` maps `notebooks/example.py` to `?file=example.py`. This is an explicit
user-provided mapping, not proof of the server's checkout or live kernel identity.

Configuration is device-local and qualified by App store and worktree binding.
Credentials and token-bearing URLs cannot be saved; use marimo's own authentication.
Notebook content uses an isolated iframe, without SANE's browser navigation UI.
Opening is explicit and may execute Python on the configured server. Unsaved editor
changes are not transferred; save first or explicitly open the saved disk version.
The PoC does not provision servers, install dependencies, pair live kernels with
agents, or enable notebook inspection/edit/run tools. Browser embedding restrictions
and authentication can still prevent a server from loading.

## Resource and identity boundaries

- Fresh app catalog UUIDs, conversation/run history, navigation, settings and locks
  belong to this store. Do not import, copy or link other runtime data or resume
  foreign native conversation IDs.
- Login uses HTTP-only `sane_app`. Exact Host/Origin validation and terminal
  revocation remain in place.
- Git common-directory identity groups main/linked worktrees; independent clones
  stay distinct. Browsing, conversation execution cwd and terminal start directory
  are separate contexts. Stale/missing bindings fail rather than retarget execution.
- CC authentication/native storage, OC service storage, installed plugins and
  terminal HOME/PATH remain external/shared. A second bridge is not a
  cross-process scheduler.

## References

[TERMINAL-RESEARCH.md](TERMINAL-RESEARCH.md) records the PTY design. Code saves
retain optimistic revision checks and size/encoding/path limits; Git views remain
read-only. Unsaved buffers are browser-memory-only. Terminals require explicit
start/control, reconnect as viewers and do not survive bridge restart. Native
continuation requires both App history and the same native storage. Ambiguous
submissions are not automatically retried.
