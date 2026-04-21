# Unused Supervision State Cleanup Plan

This document captures the remaining phases for fully removing the unused engineered supervision policy/runtime lineage path.

## Status so far

### Completed: Phase A

The following unused policy/config path was removed:

- `packages/workstreams/src/lib/supervisor/config.ts`
- `packages/workstreams/src/lib/supervisor/escalation.ts`
- `packages/workstreams/src/lib/supervisor/workflow.ts`
- `packages/workstreams/src/lib/supervisor/types.ts`
- `packages/workstreams/src/defaults/supervisor.json`
- related exports, tests, and docs/skill references

This means supervision decisions are now intentionally skill/agent driven rather than code-driven through an engineered policy module.

## What remains live

These supervision runtime pieces are still actively used and must remain:

- `supervision_state.active_run_id`
- `supervision_state.current_branch_supervision_json`
- `supervision_state.checkpoint_pointers_json`
- `supervision_runs`
- `supervision_sessions`
- tmux/native session linkage
- branch-session persistence
- checkpoint persistence
- batch/run recovery state used by `work supervise`

Primary live readers/writers:

- `packages/workstreams/src/cli/supervise.ts`
- `packages/workstreams/src/lib/supervision-helper.ts`
- `packages/workstreams/src/lib/supervisor-state.ts`
- `packages/workstreams/src/lib/root-agent-branch.ts`
- `packages/workstreams/src/lib/root-agent-checkpoint.ts`
- `packages/workstreams/src/lib/workstream-tool/launch-supervision.ts`
- `packages/workstreams/src/lib/workstream-tool/finalize-supervision.ts`
- `packages/workstreams/src/lib/workstream-tool/reconcile-supervision.ts`
- `packages/workstreams/src/internal/dashboard-observability.ts`

## What remains dormant / cleanup targets

These fields and records are part of the old engineered review/fix/escalation lineage path and appear unused by the live supervision flow:

### In `SupervisorStateFile` / `supervision_state`

- `reviewed_batches`
- `issue_summaries`
- `fix_cycles`
- `escalations`
- `stage_stops`

### In `SupervisorRunState` / `supervision_runs`

- `lastReviewedBatchId`
- `reviewPasses`
- `issueSummaryIds`
- `escalationIds`
- `stageStopId`
- `stopReason`

### Related helper APIs that currently appear unused in production

- `upsertReviewedBatchLocked`
- `upsertIssueSummaryLocked`
- `upsertFixCycleLocked`
- `upsertEscalationOutcomeLocked`
- `recordStageStopLocked`

## Why the cleanup is not finished yet

Although the old policy code is gone, some runtime helpers still read or normalize parts of the dormant state.

Main remaining coupling:

- `packages/workstreams/src/lib/supervision-helper.ts`
- `packages/workstreams/src/lib/supervisor-state.ts`
- `packages/workstreams/src/lib/reset-batch-state.ts`
- `packages/workstreams/src/lib/compatibility-projection.ts`
- `packages/workstreams/src/lib/tasks.ts`
- `packages/workstreams/src/lib/sqlite-storage.ts`
- `packages/workstreams/src/lib/structured-storage.ts`
- `packages/workstreams/src/lib/types.ts`

## Phase B: Runtime model cleanup (no sqlite schema change yet)

### Goal

Stop using the dormant supervision lineage in code while keeping the current sqlite schema intact.

### Scope

1. Simplify `SupervisorStateFile` in memory:
   - keep `runs`, `branch_sessions`, `current_branch_supervision`, `checkpoint_pointers`, `active_run_id`
   - remove dormant lineage arrays from the canonical runtime model

2. Simplify `SupervisorRunState` in memory:
   - keep only fields needed for run lifecycle and recovery
   - remove review/escalation lineage fields

3. Refactor `supervision-helper.ts`:
   - resumability should depend only on run status, current batch, and persisted batch status
   - stop consulting `reviewed_batches`, `stage_stops`, and review-pass metadata

4. Refactor `supervisor-state.ts`:
   - remove unused upsert helpers for reviewed batches / issue summaries / fix cycles / escalations / stage stops
   - simplify pause/reconcile logic to rely only on active runs and batch state

5. Refactor cleanup/projection layers:
   - `reset-batch-state.ts`
   - `compatibility-projection.ts`
   - `tasks.ts`
   - `structured-storage.ts`

6. Stop serializing dormant fields into compatibility/runtime projections.

### Expected outcome

After Phase B, the codebase no longer depends on the dormant supervision lineage, but sqlite may still physically contain old columns.

## Phase C: Sqlite write/read cleanup without physical column drop (recommended intermediate step)

### Goal

Stop writing and loading dormant supervision lineage from sqlite while leaving old columns present for backward compatibility.

### Scope

1. Update sqlite sync logic in `sqlite-storage.ts` so writes omit:
   - `reviewed_batches_json`
   - `issue_summaries_json`
   - `fix_cycles_json`
   - `escalations_json`
   - `stage_stops_json`
   - run-level review/escalation lineage fields

2. Update sqlite load logic so these old columns are ignored.

3. Update `metadata_json` serialization so dead keys are no longer emitted.

### Expected outcome

New writes become clean, while old databases remain readable without a migration.

## Phase D: Sqlite schema migration (Option B)

### Goal

Physically remove dead supervision columns from sqlite.

### Why this is separate

The current sqlite implementation does not yet have a general schema-migration framework. It only:

- checks `structured_storage_metadata.schema_version`
- initializes schema when absent

It does not currently perform in-place versioned migrations.

### Required work

1. Add schema version upgrade support in `sqlite-storage.ts`
2. Bump schema version (`v1 -> v2`)
3. Add explicit migration logic for existing DBs
4. Rewrite affected tables using table-rebuild migration patterns
5. Update `structured_storage_metadata.schema_version`

### Likely table rebuilds

#### `supervision_state`
Remove columns:

- `reviewed_batches_json`
- `issue_summaries_json`
- `fix_cycles_json`
- `escalations_json`
- `stage_stops_json`

Keep columns:

- `stream_id`
- `active_run_id`
- `current_branch_supervision_json`
- `checkpoint_pointers_json`
- `metadata_json`

#### `supervision_runs`
Remove columns:

- `last_reviewed_batch_id`
- `review_passes`
- `issue_summary_ids_json`
- `escalation_ids_json`
- `stage_stop_id`
- `stop_reason`

Keep columns:

- `stream_id`
- `run_id`
- `stage_id`
- `status`
- `started_at`
- `updated_at`
- `completed_at`
- `current_batch_id`
- `root_session_id`
- `branch_session_id`
- `metadata_json`

### Optional additional cleanup

Evaluate whether `supervision_sessions.review_id` and `fix_cycle_id` should also be dropped if they remain unused.

## Migration notes from a real repo

Inspection of `~/betalytics-backend/work/db.sqlite` showed:

- schema version is `1`
- live supervision tables exist and are populated
- dead supervision lineage columns are present
- dead supervision lineage columns are empty/default
- `metadata_json` still carries dead keys even though their values are empty/default

That means the migration for that DB is primarily structural cleanup rather than data preservation.

## Suggested execution order

1. **Phase B**: remove code dependencies on dormant lineage
2. **Phase C**: stop writing/loading dormant lineage while leaving columns in place
3. **Phase D**: add sqlite migration and physically drop old columns

This order minimizes risk by separating semantic cleanup from storage migration.

## Validation checklist for later phases

After each phase, verify:

- `work supervise` run/resume/handoff still works
- branch launch/finalize/reconcile still works
- root-agent checkpoint resolution still works
- dashboard supervision/tmux observability still works
- sqlite-backed reads still work on existing repos
- compatibility projections remain coherent during transition

For Phase D specifically, add tests for:

- v1 database migration to v2
- idempotent re-open after migration
- preservation of live supervision state
- removal of dead supervision columns and dead metadata keys
