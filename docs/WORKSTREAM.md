# Workstream Model

## Hierarchy

- Stage (serial)
- Batch (serial within stage)
- Thread (parallel within batch)

Execution items live under their owning stage/batch/thread, and the supported workflow is fully stage/batch/thread-first.

## Files

Each stream lives at `work/{stream-id}/`.

- `README.md`: overall workstream goals, shared requirements, and workflow note
- `workstream-state.json`: canonical filesystem fallback for structured state when sqlite is absent
- `REPORT.md`: completion report input
- `resources/`: supporting pre-work inputs referenced by root README or stage requirements
- `docs/`: supporting notes and synthesized research
- `stages/<nn>/REQUIREMENTS.md`: stage-local acceptance criteria and resources
- `stages/<nn>/PLAN.md`: stage-local batch/thread planning surface
- `stages/<nn>/WORK.md`: stage-local execution guidance
- `stages/<nn>/specs/`: optional stage specs directory

## Minimal Lifecycle

```bash
work init --sqlite
work create --name "feature"
work current --set "001-feature"
work plan create --stages 2
work approve plan
work supervise --batch "01.01"
work approve stage 1
work supervise
work report validate
```

## Canonical Agent Workflow

1. The planning agent uses `planning-workstreams` to create the workstream, gather context, update the root `README.md`, and then prepare stage-local planning files when planning is ready to start.
2. The user approves the plan with `work approve plan`.
3. Plan approval initializes thread execution state directly from the planned stage/thread structure.
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

- `work create` creates a minimal workstream container with `README.md`, `resources/`, `docs/`, and `stages/`.
- Review `README.md` and gather shared context in `resources/` / `docs/`.
- Run `work current --set "NNN-feature"` first, or pass `--stream`, before `work plan create` and other follow-up commands.
- `work plan create --stages <n>` scaffolds stage directories such as `stages/01/`, `stages/02/`, and so on.
- Each stage gets `REQUIREMENTS.md`, `PLAN.md`, `WORK.md`, and `specs/`.
- `work approve plan` requires at least one stage and seeds thread execution state from the staged planning structure.

## Runtime State

- In sqlite-authoritative repos, `work/db.sqlite` is the canonical structured machine state.
- Without sqlite, `work/<stream-id>/workstream-state.json` is the canonical filesystem runtime store.
- Legacy `threads.json`, `supervisor-state.json`, and `batch-status/*.json` may be imported during migration, but they are not maintained as live runtime state.

## Sqlite-Authoritative Structured Storage

- Recommended bootstrap for new and existing repos: `work init --sqlite`.
- `work/db.sqlite` is the repo-local canonical store for structured workflow state.
- Running `work init --sqlite` in an existing repo hydrates legacy workspace/runtime artifacts into sqlite.
- Core markdown documents (`README.md`, stage-local `REQUIREMENTS.md` / `PLAN.md` / `WORK.md`, `REPORT.md`) plus `resources/` and artifact-like outputs remain filesystem-based.
- `work/db.sqlite` is local runtime state and is expected to stay out of version control; this repo currently ignores `work/` entirely.

Operator guidance:

- inspect live state with `work status`, `work tree`, `work list`, and `work batch-status`
- treat legacy `threads.json`, `supervisor-state.json`, and `batch-status/*.json` as migration inputs only
- use canonical queries and `work batch-status` for live operator state
