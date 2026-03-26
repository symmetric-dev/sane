# Workstream Model

## Hierarchy

- Stage (serial)
- Batch (serial within stage)
- Thread (parallel within batch)
- Task (granular unit)

Task ID format: `SS.BB.TT.NN`.

## Files

Each stream lives at `work/{stream-id}/`.

- `REQUIREMENTS.md`: human-authored goals, deliverables, dependencies, and resources
- `PLAN.md`: structure and intent
- `TASKS.md`: intermediate task editing file
- `tasks.json`: machine state
- `threads.json`: thread-level session metadata
- `REPORT.md`: completion report input
- `resources/`: supporting pre-work inputs referenced by `REQUIREMENTS.md`

## Minimal Lifecycle

```bash
work create --name "feature"
work current --set "001-feature"
work validate requirements
work plan create --stages 2
work validate plan
work check plan
work approve plan
work approve tasks
work multi --batch "01.01"
work report validate
work complete
```

## Draft-First Planning Notes

- `work create` creates the workstream container, `REQUIREMENTS.md`, a draft `PLAN.md`, and `resources/`.
- Fill `REQUIREMENTS.md` first with a freeform summary plus bullet lists for deliverables, dependencies, and resources.
- Run `work current --set "NNN-feature"` first, or pass `--stream`, before `work validate requirements`, `work plan create`, and other follow-up commands.
- `work validate requirements` checks the requirements structure plus referenced repo/resource paths.
- `work plan create --stages <n>` scaffolds stage templates later.
- `work validate plan` succeeds for an empty draft plan, but warns that no stages exist yet.
- `work approve plan` requires at least one stage, so draft plans must be scaffolded before approval.
- Optional shortcut: `work create --name "feature" --stages 2` creates the draft container and scaffolds stages in one command.
