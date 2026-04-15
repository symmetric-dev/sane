# Supervision Manual Verification Checklist

Use this checklist for a quick operator validation pass. For background and troubleshooting detail, see [`docs/SUPERVISOR.md`](./SUPERVISOR.md).

## 1) Supervised launch

- Run `work supervise --batch "SS.BB"`.
- Confirm the CLI reports a start/resume decision and then a wait or recovery path for the requested batch.
- If you are validating branch supervision, also confirm the parent branch launch returned a supervision handoff/result instead of hanging on UI state alone.

## 2) tmux observation

- Run `tmux list-sessions`.
- Confirm supervision sessions use `001-supervision-*` and worker execution uses `001-implementation-*` when both layers are expected.
- Treat tmux as observability only; do not use tmux presence/absence as the final correctness signal.

## 3) Persisted-state inspection

- Run `work batch-status --batch "SS.BB" --format json` and confirm the batch status matches the observed phase.
- Inspect `work/<stream-id>/tasks.json` and verify `runtime_state.supervision.runs[]`, review records, and any branch-session evidence match the same batch/run.
- If `active_run_id` is present, confirm it matches the relevant `runs[]` entry; do not treat the field alone as authoritative.

## 4) Interruption and recovery

- Force or simulate an interrupted wait (for example with a short timeout) only if you are explicitly validating recovery behavior.
- Re-run plain `work supervise` and confirm it resumes or recovers the same batch before later incomplete batches.
- If a supervision branch process already ended but state stayed nonterminal, run `reconcile_workstream_supervision(...)` and verify the branch session reaches a durable terminal status.

## 5) Final report review

- For branch supervision, inspect the matching `branch_sessions[]` entry in `tasks.json` runtime state.
- Export the matching native session when needed and confirm the final assistant report includes:
  - `## Accomplished`
  - `## Issues Found`
  - `## Fixes Applied`
  - `## What is Next`
- If transcript output and persisted state disagree, treat persisted state as the source of truth and log report extraction as a follow-up issue.
