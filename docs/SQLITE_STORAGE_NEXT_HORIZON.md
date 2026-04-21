# Sqlite Storage Next Horizon

This document describes the next storage-focused horizon after the sqlite-authoritative cutover.

See also:

- [`LOCAL_FIRST_SQLITE_ARCHITECTURE.md`](./LOCAL_FIRST_SQLITE_ARCHITECTURE.md)
- [`STORAGE_PACKAGE_BOUNDARIES.md`](./STORAGE_PACKAGE_BOUNDARIES.md)
- [`SUPERVISOR.md`](./SUPERVISOR.md)

## Short answer

Yes: the next work should focus on **tests and stabilization for supervision/runtime behavior under sqlite-canonical storage**, especially before removing legacy runtime compatibility artifacts such as `batch-status/`.

The priority is not another large storage redesign. The priority is to make the sqlite-backed runtime model boring, predictable, and well-covered.

## What is already true

- `work/db.sqlite` is the canonical store for structured workflow state.
- `work/index.json` and `work/<stream-id>/tasks.json` are compatibility projections.
- The supervision/runtime model now reads and writes through sqlite-backed state.
- Recent hardening fixed sqlite lock contention and malformed persisted ID bugs such as fake `Stage 00` rows.

## What still feels unsettled

The remaining rough edges are mostly around **runtime compatibility artifacts** and **supervision-state robustness**:

- `batch-status/` can still appear as a projected compatibility artifact even though it is not intended as the long-term canonical runtime surface.
- `threads.json` / `supervisor-state.json` / `batch-status/*.json` still blur the line between migration inputs, debug artifacts, and active compatibility outputs.
- supervision/session lineage bugs and stale-branch-context behavior still exist above the storage layer.
- diagnostics for malformed historic state or compatibility drift were intentionally deferred.

## Recommended immediate priorities

### 1. Add tests before removing `batch-status/` projection

Before changing projection defaults, add explicit regression coverage for the desired runtime contract.

The target contract should be:

- `work batch-status` works from sqlite-backed canonical state
- supervision/recovery/reset flows do **not** require on-disk `batch-status/*.json`
- old repos with legacy `batch-status/` can still be imported safely
- removing `batch-status/` projection does not break status/tree/supervise flows

Suggested test areas:

- sqlite-backed batch-status reads without any `work/<stream>/batch-status/` directory present
- reset/recovery behavior with sqlite-canonical batch runs only
- supervision pause/resume/terminal recovery without on-disk batch-status files
- legacy hydration importing historical `batch-status/*.json` into sqlite, then operating normally without re-projecting them

### 2. Tighten supervision-state behavior around sqlite-canonical runtime

The next runtime focus should be:

- making supervision read/write paths rely consistently on sqlite-backed runtime state
- reducing assumptions that compatibility artifacts exist on disk
- ensuring branch/session scope persistence stays canonical and identifier-safe
- validating that operator-facing commands (`work status`, `work tree`, `work batch-status`, `work supervise`) remain coherent when compatibility runtime files are absent

This is mostly a stabilization and testability problem, not a new schema problem.

### 3. Add cleanup/diagnostic groundwork after runtime tests are stable

Once the runtime-without-`batch-status/` contract is covered, the next layer should be diagnostics:

- detect malformed historic IDs or compatibility drift
- warn when hydration had to repair unambiguous malformed values
- surface when compatibility projections are stale or unexpectedly present
- provide operator-safe repair/rebuild guidance

This should come **after** the runtime contract is tested, not before.

## Proposed execution order

### Phase A: Runtime contract tests

Write tests that prove sqlite-backed runtime behavior does not depend on `batch-status/` projection.

### Phase B: Stop projecting `batch-status/` by default

After tests pass:

- keep legacy import support for repos that already have `batch-status/`
- stop generating `work/<stream>/batch-status/*.json` as a normal compatibility output
- keep `work batch-status` fully supported via sqlite-backed reads

### Phase C: Review the remaining runtime compatibility artifacts

Re-evaluate whether:

- `threads.json`
- `supervisor-state.json`

should remain runtime projections, become migration-only inputs, or gain opt-in behavior.

### Phase D: Add diagnostics and repair guidance

Only after the runtime contract is stable:

- add warnings/reporting for malformed historic state
- add explicit repair/rebuild guidance and tooling

## Non-goals for the immediate next horizon

Do **not** start with:

- removing `index.json` / `tasks.json` compatibility projections entirely
- redesigning the workstream lifecycle
- extracting storage into separate packages immediately
- broad daemon/server-backed storage changes

Those are later horizons. The next one is about making sqlite-backed runtime behavior dependable and simpler.

## Suggested acceptance gates

Treat this next horizon as complete only when all of the following are true:

1. `work batch-status`, `work supervise`, reset/recovery, and status/tree views work without projected `batch-status/*.json`.
2. Legacy repos with `batch-status/` still hydrate cleanly into sqlite.
3. Supervision/runtime tests cover pause/resume/terminal recovery against sqlite-canonical state.
4. Removing `batch-status/` projection does not create regressions in representative existing repos.
5. The operator docs clearly describe which runtime artifacts are canonical, projected, migration-only, or no longer produced.

## Bottom line

The next thing is:

> **test and stabilize sqlite-canonical supervision/runtime behavior first, then remove `batch-status/` projection by default, then add diagnostics/cleanup.**

That path keeps the remaining storage work focused, low-risk, and aligned with the sqlite-authoritative model already in place.
