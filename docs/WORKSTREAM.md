# Workstream Model

## Hierarchy

- Stage (serial)
- Batch (serial within stage)
- Thread (parallel within batch)
- Task (granular unit)

Task ID format: `SS.BB.TT.NN`.

## Files

Each stream lives at `work/{stream-id}/`.

- `PLAN.md`: structure and intent
- `TASKS.md`: intermediate task editing file
- `tasks.json`: machine state
- `threads.json`: thread-level session metadata
- `REPORT.md`: completion report input

## Minimal Lifecycle

```bash
work create --name "feature"
work current --set "001-feature"
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

- `work create` creates the workstream container and a draft `PLAN.md`.
- Run `work current --set "NNN-feature"` first, or pass `--stream`, before `work plan create` and other follow-up commands.
- `work plan create --stages <n>` scaffolds stage templates later.
- `work validate plan` succeeds for an empty draft plan, but warns that no stages exist yet.
- `work approve plan` requires at least one stage, so draft plans must be scaffolded before approval.
- Optional shortcut: `work create --name "feature" --stages 2` creates the draft container and scaffolds stages in one command.
