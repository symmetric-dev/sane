# @agenv/workstreams

Workstream management library and CLI.

## Install

```bash
npm install -g @agenv/workstreams
# or
bun install -g @agenv/workstreams
```

## Quick Start

```bash
work init
work create --name "my-feature"
work current --set "001-my-feature"
work validate requirements
work plan create --stages 2
work validate plan
work check plan
work approve plan
```

## Core Workflow

1. Create a draft workstream container: `work create --name "my-feature"`
2. Fill `REQUIREMENTS.md` and add extra inputs under `resources/`
3. Set the current workstream (or pass `--stream`): `work current --set "001-my-feature"`
4. Validate requirements: `work validate requirements`
5. Scaffold plan stages later: `work plan create --stages 2`
6. Edit `PLAN.md`
7. Validate/check the plan:
   - `work validate plan` warns but succeeds for an empty draft plan
   - `work check plan` highlights open questions and missing inputs
8. Approve plan: `work approve plan` (user role, requires at least one stage)
9. Fill `TASKS.md`
10. Approve tasks: `work approve tasks` (user role)
11. Execute batches: `work multi --batch "01.01"`
12. Complete tasks with reports via `work update --status completed --report "..."`
13. Finalize report and complete stream:
   - `work report validate`
   - `work complete`

Shortcut:

- `work create --name "my-feature" --stages 2` still creates the draft container and scaffolds stages immediately.

Generated files on `work create`:

- `REQUIREMENTS.md` for the human-authored summary, deliverables, dependencies, and resources
- `resources/` for supplemental inputs referenced from `REQUIREMENTS.md`
- `PLAN.md` for staged execution planning
- `tasks.json` for machine state
- `docs/` for extra workstream notes

## Useful Commands

```bash
work status
work tree
work list --tasks
work update --task "01.01.01.01" --status in_progress
work update --task "01.01.01.01" --status completed --report "Implemented X"
work report metrics --blockers
work export --format json
```

## Root Agent Supervision Workflow (v1)

Use `work supervise` as the branch execution/recovery primitive for Root Agent orchestration:

```bash
work supervise
work supervise --batch "01.01"
work supervise --dry-run
```

`work supervise` launches `work multi --headless --async`, waits for the batch to become terminal, and produces deterministic review evidence from canonical execution state (task status/report fields, thread/session metadata, and persisted batch status).

The Root Agent then either:

- continues automatically to the next incomplete batch,
- runs one automatic fix cycle (default), or
- escalates to the user based on escalation/stage-boundary policy.

In practice, Root Agent orchestration **continues automatically only when** the batch review is approved and no stop policy is triggered.
It **stops** when escalation requires user input, a stage boundary stop is reached, there is no next batch, or execution/wait fails.

If `--timeout-ms` is reached before the batch becomes terminal, the wait fails and `work supervise` exits without reviewing the incomplete batch. That interrupted run remains resumable and is preferred on the next `work supervise` rerun.

Policy is loaded from `work/supervisor.json` (defaults are used if missing) and interpreted at the Root Agent layer.

After any stop, inspect the batch and supervisor state before resuming:

```bash
# 1) task/thread snapshot for the batch that just ran
work tree --batch "01.01"

# 2) persisted execution state for that batch
work batch-status --batch "01.01" --format json

# 3) persisted supervisor decision history
cat work/<stream-id>/supervisor-state.json
```

Interpretation quick-guide (what success looks like vs what to inspect):

- **Terminal success / safe resume:** `work batch-status` is `completed` and `supervisor-state.json` includes the batch under `reviewed_batches` plus persisted finalization evidence for the run decision (for example completed run state and/or matching `stage_stops` when the supervisor stopped on that batch).
- **Timeout/wait failure:** batch status remains non-terminal; inspect the batch plus `supervisor-state.json`, then rerun plain `work supervise` to resume that same interrupted batch before later incomplete batches.
- **Escalation/stage stop:** inspect `escalations` and `stage_stops` to confirm what operator action is required.
- **Terminal failed run:** `work batch-status` is `failed`; inspect failed thread summaries before retrying.

Timeout resume smoke checklist (short drill):

1. Force interruption: `work supervise --batch "01.01" --timeout-ms 100`
2. Inspect persisted state: `work batch-status --batch "01.01" --format json` and `cat work/<stream-id>/supervisor-state.json`
3. Resume normally: run plain `work supervise` and confirm it resumes `01.01` first (does not skip to later incomplete batches)
4. Verify outcome class:
   - **Resumed success:** batch becomes terminal `completed`, `reviewed_batches` contains `01.01`, and persisted finalization evidence for that same batch appears in `supervisor-state.json` (for example completed run state and/or `stage_stops`)
   - **Still interrupted/non-terminal:** batch remains non-terminal and no new `reviewed_batches` entry exists yet (wait/investigate before treating as complete)

Persisted-state note: prefer `supervisor-state.json` ordering/evidence to verify same-batch resume, rather than relying only on transient console logs.

Escalation policy: branch runs escalate to the Root Agent; the Root Agent escalates to the user.

Key persisted files:

- `work/<stream-id>/batch-status/<batch-id>.json` (batch execution state)
- `work/<stream-id>/supervisor-state.json` (review/fix/escalation/stage-stop history)

### Reporting model (v1)

For v1 supervision, task-level `report` text plus canonical workstream state are the primary review inputs.
This is sufficient for current automated follow-up decisions, but reporting may evolve in a later revision toward a richer structured format if operator workflows require more granular machine-readable evidence.

Quick post-fix verification checklist:

- **Successful completion path**: batch status is terminal and `supervisor-state.json` records both review evidence (`reviewed_batches`) and persisted finalization evidence for that batch/run (including completed run state and/or the resulting `stage_stops` outcome for repaired canonical completion fallback cases).
- **Timeout/failure path**: batch status remains non-terminal at timeout; no new reviewed entry is recorded for the incomplete batch, and supervisor state keeps the interrupted run resumable until review can continue.

Resume examples:

```bash
# timeout/resume drill: force interruption on a known batch
work supervise --batch "01.01" --timeout-ms 100

# resume interrupted work first (same batch), otherwise continue from next incomplete batch
work supervise

# rerun a specific batch after manual fixes or policy edits
work supervise --batch "01.01"
```

For the timeout/resume drill, verify recovery by confirming `01.01` reaches reviewed/finalized persisted state before Root Agent orchestration progresses to any later incomplete batch.

### Validation checks for Root Agent ownership (drift reduction)

To confirm reduced drift vs the previous self-contained `work supervise` model:

1. Verify each fix/escalate decision is grounded in persisted state (`batch-status/*.json` + `supervisor-state.json`), not transient logs alone.
2. Confirm `reviewed_batches`, `fix_cycles`, and `escalations` entries match the Root Agent decision taken for that batch.
3. Run regression tests from `packages/workstreams`:

```bash
bun run test tests/supervise.test.ts tests/supervisor-state.test.ts
```

These tests validate deterministic review evidence, escalation/fix-cycle persistence, and interruption-safe resume behavior relied on by Root Agent orchestration.

### Prompt-first branch handoff live validation

For the current one-level prompt-first experiment:

- treat supervision branches as single-hop children of the Root Agent only
- if a branch tries to launch another supervision branch, the launch must fail with a guardrail error and the branch should yield back upward
- validate lineage and branch status from `work/<stream-id>/supervisor-state.json` → `branch_sessions[]`
- validate the final branch report by exporting the child native session transcript and reading the last completed assistant message
- classify drift when the branch acts like the Root Agent or proposes deeper branching instead of reporting its `work supervise` outcome

For full operator guidance and config details, see `../../docs/SUPERVISOR.md`.
