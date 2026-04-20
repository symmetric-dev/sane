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
- `tasks.json`: machine state, including canonical `runtime_state` for threads, batches, and supervision
- `threads.json`: legacy migrated thread metadata artifact if present
- `supervisor-state.json`: legacy migrated supervision artifact if present
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
work supervise --batch "01.01"
work approve stage 1
work supervise
work report validate
```

## Canonical Agent Workflow

1. The planning agent uses `planning-workstreams` to create the workstream and prepare `REQUIREMENTS.md`, `PLAN.md`, and task drafts.
2. The user approves the plan with `work approve plan`.
3. After task editing/serialization is complete, the user approves tasks with `work approve tasks`.
4. The Root Agent uses `managing-workstreams` to launch a supervision branch.
5. The supervision branch uses `supervising-workstreams` to run `work supervise`, inspect persisted state, and drive the review/fix/escalation loop.
6. Implementation agents inside that supervised batch use `implementing-workstreams` to inspect scope and keep task state current with commands like `work status`, `work tree --batch`, `work list --tasks --thread`, and `work update`.
7. The Root Agent reports back to the user, and the user approves each completed stage with `work approve stage N`.
8. Repeat the supervise → review → stage approval loop until all stages are done.
9. If more work is needed after the original stages, use the revision flow:
   - `work revision --name "follow-up" [--after-stage N]`
   - `work approve revision`
   - `work approve tasks`
10. At the end, use `evaluating-workstreams` to finalize `REPORT.md` and run `work report validate`.

## Draft-First Planning Notes

- `work create` creates the workstream container, `REQUIREMENTS.md`, a draft `PLAN.md`, and `resources/`.
- Fill `REQUIREMENTS.md` first with a freeform summary plus bullet lists for deliverables, dependencies, and resources.
- Run `work current --set "NNN-feature"` first, or pass `--stream`, before `work validate requirements`, `work plan create`, and other follow-up commands.
- `work validate requirements` checks the requirements structure plus referenced repo/resource paths.
- `work plan create --stages <n>` scaffolds stage templates later.
- `work validate plan` succeeds for an empty draft plan, but warns that no stages exist yet.
- `work approve plan` requires at least one stage, so draft plans must be scaffolded before approval.
- Optional shortcut: `work create --name "feature" --stages 2` creates the draft container and scaffolds stages in one command.

## Runtime State

- `tasks.json` is the canonical persisted machine state.
- `tasks.json -> runtime_state.threads` stores runtime thread/session metadata.
- `tasks.json -> runtime_state.batches` stores persisted batch execution summaries.
- `tasks.json -> runtime_state.supervision` stores supervision runs, reviewed batches, fix cycles, escalations, stage stops, and branch supervision metadata.
- Legacy `threads.json` and `supervisor-state.json` files may still exist for migration/compatibility, but they are not the primary runtime store.

## Local-First Structured Storage Migration

- The current adapter model is **filesystem-authoritative dual-write**.
- `work/index.json` and `work/<stream-id>/tasks.json` remain canonical during the migration.
- `work/db.sqlite` is a repo-local sqlite mirror for structured workflow state only.
- Core markdown documents (`REQUIREMENTS.md`, `PLAN.md`, `TASKS.md`, `REPORT.md`) plus `resources/` and artifact-like outputs remain filesystem-based.
- Sqlite bootstrap or mirror failures must not block canonical filesystem writes.
- `work/db.sqlite` is local runtime state and is expected to stay out of version control; this repo currently ignores `work/` entirely.

See also:

- [`LOCAL_FIRST_SQLITE_ARCHITECTURE.md`](./LOCAL_FIRST_SQLITE_ARCHITECTURE.md) for the detailed local-first architecture writeup.
- [`STORAGE_PACKAGE_BOUNDARIES.md`](./STORAGE_PACKAGE_BOUNDARIES.md) for the package/refactor recommendation that builds on that architecture.
