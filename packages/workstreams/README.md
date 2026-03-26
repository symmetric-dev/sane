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
work plan create --stages 2
work validate plan
work check plan
work approve plan
```

## Core Workflow

1. Create a draft workstream container: `work create --name "my-feature"`
2. Set the current workstream (or pass `--stream`): `work current --set "001-my-feature"`
3. Scaffold plan stages later: `work plan create --stages 2`
4. Edit `PLAN.md`
5. Validate/check the plan:
   - `work validate plan` warns but succeeds for an empty draft plan
   - `work check plan` highlights open questions and missing inputs
6. Approve plan: `work approve plan` (user role, requires at least one stage)
7. Fill `TASKS.md`
8. Approve tasks: `work approve tasks` (user role)
9. Execute batches: `work multi --batch "01.01"`
10. Complete tasks with reports via `work update --status completed --report "..."`
11. Finalize report and complete stream:
   - `work report validate`
   - `work complete`

Shortcut:

- `work create --name "my-feature" --stages 2` still creates the draft container and scaffolds stages immediately.

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
