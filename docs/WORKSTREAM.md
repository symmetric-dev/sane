# Workstream Model

## Hierarchy

- Stage (serial)
- Batch (serial within stage)
- Thread (parallel within batch)

Internal compatibility still uses task IDs like `SS.BB.TT.NN`, but the supported workflow is now stage/batch/thread-first.

## Files

Each stream lives at `work/{stream-id}/`.

- `REQUIREMENTS.md`: human-authored goals, deliverables, dependencies, and resources
- `PLAN.md`: structure and intent
- `tasks.json`: compatibility projection of structured workstream state when projected from sqlite; also a legacy hydration input for pre-sqlite repos
- `threads.json`: legacy thread metadata artifact if present; sqlite-native workstreams no longer need it projected for normal runtime behavior
- `supervisor-state.json`: legacy supervision artifact if present; still transitional compatibility/runtime output in the current sqlite-native phase
- `REPORT.md`: completion report input
- `resources/`: supporting pre-work inputs referenced by `REQUIREMENTS.md`

`TASKS.md` was removed from the supported workflow in 0.9.0.

## Minimal Lifecycle

```bash
work init --sqlite
work create --name "feature"
work current --set "001-feature"
work validate requirements
work plan create --stages 2
work validate plan
work check plan
work approve plan
work supervise --batch "01.01"
work approve stage 1
work supervise
work report validate
```

## Canonical Agent Workflow

1. The planning agent uses `planning-workstreams` to create the workstream and prepare `REQUIREMENTS.md` and `PLAN.md`.
2. The user approves the plan with `work approve plan`.
3. Plan approval initializes compatibility execution state directly from `PLAN.md`.
4. The user manually `/fork`s the session and asks the forked session to supervise the approved work.
5. The supervision branch uses `supervising-workstreams` to run `work supervise`, inspect persisted state, and drive the review/fix/escalation loop.
6. Implementation agents inside that supervised batch use `implementing-workstreams` to inspect scope and keep execution state current with commands like `work status`, `work tree --batch`, `work list --thread`, and `work update`.
7. The supervisor fork reports back to the user, and the user approves each completed stage with `work approve stage N`.
8. Repeat the supervise → review → stage approval loop until all stages are done.
9. If more work is needed after the original stages, use the revision flow:
   - `work revision --name "follow-up" [--after-stage N]`
   - `work approve revision`
10. At the end, use `evaluating-workstreams` to finalize `REPORT.md` and run `work report validate`.

The older Root Agent management-launch flow is still available through the managed installation profile, but the default profile omits the `managing-workstreams` skill and supervision launch tool so the user controls the `/fork` handoff explicitly.

## Draft-First Planning Notes

- `work create` creates the workstream container, `REQUIREMENTS.md`, a draft `PLAN.md`, and `resources/`.
- Fill `REQUIREMENTS.md` first with a freeform summary plus bullet lists for deliverables, dependencies, and resources.
- Run `work current --set "NNN-feature"` first, or pass `--stream`, before `work validate requirements`, `work plan create`, and other follow-up commands.
- `work validate requirements` checks the requirements structure plus referenced repo/resource paths.
- `work plan create --stages <n>` scaffolds stage templates later.
- `work validate plan` succeeds for an empty draft plan, but warns that no stages exist yet.
- `work approve plan` requires at least one stage, seeds compatibility execution state directly from `PLAN.md`, and generates prompts.
- Optional shortcut: `work create --name "feature" --stages 2` creates the draft container and scaffolds stages in one command.

## Runtime State

- In sqlite-authoritative repos, `work/db.sqlite` is the canonical structured machine state.
- When `tasks.json` exists, `tasks.json -> runtime_state.threads`, `tasks.json -> runtime_state.batches`, and `tasks.json -> runtime_state.supervision` are compatibility projections rebuilt from sqlite.
- Legacy `threads.json` and `supervisor-state.json` files may still exist for migration/compatibility, but they are not the primary runtime store.
- `batch-status/*.json` is not a required live runtime surface for sqlite-native workstreams; use `work batch-status` instead.

## Sqlite-Authoritative Structured Storage

- Recommended bootstrap for new and existing repos: `work init --sqlite`.
- `work/db.sqlite` is the repo-local canonical store for structured workflow state.
- Running `work init --sqlite` in an existing repo hydrates legacy `index.json`, `tasks.json`, and compatible runtime artifacts into sqlite.
- `work/index.json` and `work/<stream-id>/tasks.json` become rebuildable compatibility projections instead of the source of truth.
- Core markdown documents (`REQUIREMENTS.md`, `PLAN.md`, `REPORT.md`) plus `resources/` and artifact-like outputs remain filesystem-based.
- permanent removal of compatibility JSON and any remote/service-backed storage model remain deferred follow-up work.
- `work/db.sqlite` is local runtime state and is expected to stay out of version control; this repo currently ignores `work/` entirely.

Operator guidance:

- inspect live state with `work status`, `work tree`, `work list`, and `work batch-status`
- rebuild `work/index.json` / `work/<stream-id>/tasks.json` compatibility files with `work rebuild-compat` or `work rebuild-compat --stream current`
- use `work rebuild-compat --output-root /tmp/sqlite-compat-snapshot` for rollback-safe inspection of projected `index.json` / `tasks.json` files before replacing live compatibility files
- do not expect `work rebuild-compat` snapshots to include legacy runtime compatibility artifacts like `threads.json`, `supervisor-state.json`, or `batch-status/*.json`
- treat legacy `threads.json` / `supervisor-state.json` as migration inputs or compatibility artifacts only, not as normal runtime authority
- treat on-disk `batch-status/*.json` as legacy/stale if present; `work batch-status` is the authoritative operator interface

See also:

- [`LOCAL_FIRST_SQLITE_ARCHITECTURE.md`](./LOCAL_FIRST_SQLITE_ARCHITECTURE.md) for the detailed local-first architecture writeup.
- [`STORAGE_PACKAGE_BOUNDARIES.md`](./STORAGE_PACKAGE_BOUNDARIES.md) for the package/refactor recommendation that builds on that architecture.
