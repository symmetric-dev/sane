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
- Use canonical supervision/runtime queries first (`work status`, `work batch-status`, sqlite-backed runtime views) and verify `runs[]`, review records, and branch-session evidence match the same batch/run.
- If `active_run_id` is present, confirm it matches the relevant `runs[]` entry; do not treat the field alone as authoritative.

## 4) Interruption and recovery

- Force or simulate an interrupted wait (for example with a short timeout) only if you are explicitly validating recovery behavior.
- Re-run plain `work supervise` and confirm it resumes or recovers the same batch before later incomplete batches.
- If a supervision branch process already ended but state stayed nonterminal, run `reconcile_workstream_supervision(...)` and verify the branch session reaches a durable terminal status.

## 5) Final report review

- For branch supervision, inspect the matching canonical `branch_sessions[]` runtime entry.
- Export the matching native session when needed and confirm the final assistant report includes:
  - `## Accomplished`
  - `## Issues Found`
  - `## Fixes Applied`
  - `## What is Next`
- If transcript output and persisted state disagree, treat persisted state as the source of truth and log report extraction as a follow-up issue.

## 6) Optional tmux/tool E2E smoke test

- From the repo root, run `RUN_OPENCODE_TOOL_E2E=1 OPENCODE_E2E_MODEL=openai/gpt-5.4-mini bun test agent/tools/workstream-opencode.e2e.test.ts`.
- In a second terminal, run `tmux list-sessions` and optionally `tmux attach -t <e2e-tool-session>` while the test is running.
- Confirm the run proves the full transport path: an Opencode session calls the tool, the tool launches tmux, tmux runs a real `opencode run ...`, and the resulting native session can be exported successfully.
- If the launch path looks inconsistent, inspect `/tmp/agenv-workstream-tool.log` before treating the result as a semantic supervision failure.

## Notes

- Legacy-reference cleanup check:
  - Run `grep -R "supervision-tmux-e2e""-testing" README.md docs agent/skills packages/workstreams/README.md`.
  - Expect no matches in live docs, skills, or user-facing guidance; any remaining mentions under `work/` are historical workstream audit records.
  - Confirm the canonical supervision doc set is `docs/SUPERVISOR.md`, `docs/ROOT_AGENT_BRANCHING_ARCHITECTURE.md`, and this checklist.

- This E2E test is opt-in because it depends on a real model/provider setup.
- The deterministic companion coverage remains `bun test agent/tools/workstream.test.ts`.
