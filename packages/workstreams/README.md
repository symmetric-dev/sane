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

The supervisor launches `work multi --headless --async`, reviews outputs, then either:

- continues to the next batch,
- runs one automatic fix cycle (default), or
- stops for user input based on escalation/stage-boundary policy.

If `--timeout-ms` is reached before the batch becomes terminal, the wait fails and supervisor exits without reviewing the incomplete batch.

Policy is loaded from `work/supervisor.json` (defaults are used if missing).

For full operator guidance and config details, see `../../docs/SUPERVISOR.md`.
