# Local-First Sqlite Architecture

## Decision

The current storage design is **local-first, filesystem-authoritative dual-write**:

- filesystem state stays canonical during the migration
- sqlite at `work/db.sqlite` mirrors structured workflow state for parity checks and future cutover work
- markdown documents, resources, and artifact-like outputs stay file-oriented

This lets the CLI keep today's repo-local workflow while moving workflow-critical state behind adapter boundaries that can later support server-backed storage.

## What is canonical right now

### Filesystem-canonical state during the transition

The adapter writes filesystem state first and treats a successful filesystem write as the source of truth.

- `work/index.json` remains the canonical workspace catalog and current-stream pointer
- `work/<stream-id>/tasks.json` remains the canonical structured workstream store
- `tasks.json.runtime_state.threads` remains the canonical thread/session store
- `tasks.json.runtime_state.batches` remains the canonical batch-run store
- `tasks.json.runtime_state.supervision` remains the canonical supervision store

If sqlite bootstrap or mirroring fails, the filesystem write still succeeds and the workflow continues. Tests cover this failure mode so sqlite cannot make normal task/thread/supervision updates unsafe.

### Sqlite-mirrored state during the transition

`work/db.sqlite` mirrors the structured state that already maps cleanly to relational records:

- workstreams and workspace selection metadata
- stages, batches, threads, and tasks
- approvals
- thread sessions
- batch runs
- supervision runs and related structured supervision records

In this phase, sqlite is a **shadow structured store**, not the primary authority.

## Structured vs file-oriented storage split

### Structured state that belongs in sqlite

Use sqlite for queryable workflow state with stable identifiers and relational links:

- hierarchy rows (`workstreams`, `stages`, `batches`, `threads`, `tasks`)
- approval records
- runtime session/run state
- supervision review/fix/escalation lineage

These are the records the adapter layer should eventually be able to source from any structured backend.

### File-oriented state that stays on disk

Keep human-authored and artifact-like content in the workstream directory:

- `REQUIREMENTS.md`
- `PLAN.md`
- `TASKS.md`
- `REPORT.md`
- `resources/`
- generated prompts, reports, logs, screenshots, transcripts, and similar outputs

Sqlite should only store the minimum path metadata needed to locate those files, starting with the workstream `storage_root` and a small number of explicit relative-path fields where workflow logic needs them.

## `work/db.sqlite` behavior

- location: repo-local database at `work/db.sqlite`
- bootstrap: created on first structured-storage access that uses the dual-write adapter
- role: normalized mirror for structured workflow state
- failure model: bootstrap/mirror failures are recorded as sqlite mirror state, but do not replace filesystem truth

This makes sqlite useful immediately for schema validation, parity inspection, and migration rehearsals without forcing an early read-path cutover.

## Version-control expectations

- `work/db.sqlite` should be treated as local runtime state, not as a reviewed source artifact
- this repository already ignores `work/`, so the sqlite file is not expected to be committed
- if ignore rules become more selective later, `work/db.sqlite` should still remain ignored by default

The durable, reviewable artifacts remain the markdown documents plus the canonical filesystem state that current workflows already inspect.

## Why this helps the future server-backed path

The migration path is:

1. keep the filesystem workflow stable
2. mirror structured state into sqlite through adapter-backed writes
3. validate parity on the structured subset
4. tighten the structured-storage contract
5. later swap sqlite for a different structured backend, or promote the structured backend to canonical reads, without moving markdown/resources into the database

That means future server-backed storage work can focus on the structured adapter surface and synchronization strategy, while the file-oriented workstream directory remains the authoring and artifact boundary unless a separate document/object-storage migration is intentionally designed.

## Deferred follow-up map

The dual-write migration is intentionally incomplete. The next storage/server workstream should treat the following items as the remaining cutover backlog.

### 1. Gates before DB-canonical reads

Do not flip canonical reads from filesystem state to sqlite until all of the following are true:

- CLI, dashboard, and server read paths stop depending on direct filesystem helpers such as `loadIndex`, `readTasksFile`, `getTasks`, `getTaskCounts`, and `getEffectiveRuntimeSummary`, and instead read through stable storage/query interfaces.
- parity coverage proves that hierarchy reads, approvals, task updates, thread-session lifecycle, batch-run lifecycle, supervision lifecycle, reset/recovery flows, and revision/fix flows produce the same persisted outcomes from both sides of the adapter boundary.
- sqlite divergence handling is explicit: bootstrap/migration failures, stale mirrors, and repair/rebuild flows must be detectable and testable before sqlite becomes the source of truth.
- convenience projections such as `runtime_summary`, `active_run_id`, and `current_branch_supervision` are either rebuilt from canonical structured records or removed as independent read dependencies.

### 2. Remaining `tasks.json` cleanup

The current codebase still carries filesystem-shaped mutation logic that must move behind storage-level APIs before a canonical-read cutover:

- replace raw `tasks.json` surgery in `packages/workstreams/src/lib/fix.ts` and related recovery/reset paths with storage mutations over canonical task, approval, batch-run, and supervision records.
- remove compatibility path aliases like `getThreadsFilePath`, `getBatchStatusFilePath`, and `getSupervisorStateFilePath` once callers stop treating `tasks.json` as multiple pseudo-files.
- finish migrating read-model consumers that still import `index.ts` / `tasks.ts` helpers directly, especially CLI status/list/tree/supervise flows, batch monitors, and server snapshot helpers.
- demote legacy compatibility artifacts (`threads.json`, `supervisor-state.json`, `batch-status/*.json`) to one-time migration inputs only, then remove fallback rewrites once no runtime path depends on them.

### 3. Supervision and runtime-state normalization still deferred

Sqlite currently mirrors some supervision structures through JSON blobs or convenience pointers that should become cleaner relational state before broader backend work:

- normalize `reviewed_batches`, `issue_summaries`, `fix_cycles`, `escalations`, `stage_stops`, `branch_sessions`, and `checkpoint_pointers` as first-class records for both sqlite-authoritative and service-backed implementations.
- convert relationship arrays such as `reviewed_batches.threadIds`, `reviewed_batches.issueSummaryIds`, and `fix_cycles.issueSummaryIds` into explicit join tables/relations.
- keep `active_run_id` and `current_branch_supervision` as derived pointers over canonical supervision records rather than long-term business entities.
- define which branch-session/checkpoint fields are durable queryable columns versus debug metadata so reset/reconcile/finalization logic updates one canonical supervision model.

### 4. Service-backed architecture follow-up

Once the cleanup above is done, the next architecture step is not “use sqlite everywhere,” but “stabilize the contract that any structured backend can implement”:

- extract stable storage-core mutation/query contracts from `packages/workstreams` only after the remaining direct helper dependencies are gone.
- keep filesystem/document artifacts as file- or object-backed resources, with structured backends storing only `storage_root` and the minimal path metadata needed to locate them.
- design explicit multi-writer semantics for a future daemon/server path: concurrency control, revision/version checks, sync/rebuild flows, and auth boundaries are new requirements that the local-first embedded sqlite phase does not solve.
- make the dashboard/server read models consume storage/query interfaces rather than repo-local file helpers so the same read contract works for embedded sqlite and remote service-backed storage.
