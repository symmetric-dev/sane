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
At most 256 spans are retained; `droppedSpans` counts omitted spans.

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
