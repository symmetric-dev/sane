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

## Supervisor Workflow (v1)

Use `work supervise` to run headless batch execution with deterministic review/fix decisions:

```bash
work supervise
work supervise --batch "01.01"
work supervise --dry-run
```

The supervisor launches `work multi --headless --async`, waits for the batch to become terminal, and reviews canonical execution state (task status/report fields, thread/session metadata, and persisted batch status) before deciding whether to continue, fix, or stop.

It then either:

- continues automatically to the next incomplete batch,
- runs one automatic fix cycle (default), or
- stops and asks for user input based on escalation/stage-boundary policy.

In practice, it **continues automatically only when** the batch review is approved and no stop policy is triggered.
It **stops** when escalation requires user input, a stage boundary stop is reached, there is no next batch, or execution/wait fails.

If `--timeout-ms` is reached before the batch becomes terminal, the wait fails and supervisor exits without reviewing the incomplete batch. That interrupted run remains resumable and is preferred on the next `work supervise` rerun.

Policy is loaded from `work/supervisor.json` (defaults are used if missing).

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

- **Terminal success / safe resume:** `work batch-status` is `completed` and `supervisor-state.json` includes the batch under `reviewed_batches`.
- **Timeout/wait failure:** batch status remains non-terminal; inspect the batch plus `supervisor-state.json`, then rerun `work supervise` to resume that interrupted batch before later incomplete batches.
- **Escalation/stage stop:** inspect `escalations` and `stage_stops` to confirm what operator action is required.
- **Terminal failed run:** `work batch-status` is `failed`; inspect failed thread summaries before retrying.

Key persisted files:

- `work/<stream-id>/batch-status/<batch-id>.json` (batch execution state)
- `work/<stream-id>/supervisor-state.json` (review/fix/escalation/stage-stop history)

### Reporting model (v1)

For v1 supervision, task-level `report` text plus canonical workstream state are the primary review inputs.
This is sufficient for current automated follow-up decisions, but reporting may evolve in a later revision toward a richer structured format if operator workflows require more granular machine-readable evidence.

Quick post-fix verification checklist:

- **Successful completion path**: batch status is terminal and `supervisor-state.json` records both review evidence (`reviewed_batches`) and the resulting stop outcome for that batch (including repaired canonical completion fallback cases).
- **Timeout/failure path**: batch status remains non-terminal at timeout; no new reviewed entry is recorded for the incomplete batch, and supervisor state keeps the interrupted run resumable until review can continue.

Resume examples:

```bash
# resume interrupted work first, otherwise continue from next incomplete batch
work supervise

# rerun a specific batch after manual fixes or policy edits
work supervise --batch "01.01"
```

For full operator guidance and config details, see `../../docs/SUPERVISOR.md`.
