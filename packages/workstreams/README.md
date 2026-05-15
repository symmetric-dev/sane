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
work init --sqlite
work create --name "my-feature"
work current --set "001-my-feature"
work plan create --stages 2
```

## Core Workflow

1. Create a draft workstream container: `work create --name "my-feature"`
2. Review `README.md` and capture shared context under `resources/` / `docs/`
3. Set the current workstream (or pass `--stream`): `work current --set "001-my-feature"`
4. Scaffold stage directories: `work plan create --stages 2`
5. Fill `stages/01/REQUIREMENTS.md`, `stages/01/PLAN.md`, `stages/01/WORK.md`, and `stages/01/specs/` (repeat per stage)
6. Approve plan: `work approve plan` (user role, requires at least one stage)
7. `work approve plan` also seeds compatibility `tasks.json` state directly from the thread/stage plan
8. Manually `/fork` the session and ask the forked session to supervise the approved work
9. The supervision branch uses `work supervise`, `work status`, `work tree`, and `work batch-status` to drive the next batch and review loop
10. Implementation agents use `implementing-workstreams` to inspect assigned scope and update task state with `work update`
11. The supervisor reports back; the user approves the completed stage with `work approve stage <n>`
12. Repeat the supervision loop for the next stage
13. If new stages are needed after the original plan, use the revision flow:
    - `work revision --name "follow-up" [--after-stage N]`
    - `work approve revision`
14. Finalize the report with the `evaluating-workstreams` skill:
    - `work report validate`

The optional managed install profile preserves the older Root Agent management-launch workflow. The default manual profile omits the management skill and launch tool so the user controls the `/fork` handoff.

Generated files on `work create`:

- `README.md` for the initial shared workstream description and requirements
- `resources/` for supplemental inputs gathered before stage planning
- `docs/` for extra workstream notes
- `stages/` as the stage workspace root

Deferred artifacts created later in the workflow:

- `stages/<nn>/REQUIREMENTS.md` for stage-local summary, deliverables, dependencies, and resources
- `stages/<nn>/PLAN.md` for stage-local batch/thread planning
- `stages/<nn>/WORK.md` for rich execution guidance
- `stages/<nn>/specs/` for stage specs
- `tasks.json` compatibility JSON after plan approval / compatibility projection

## Useful Commands

```bash
work status
work tree
work tree --batch "01.01"
work batch-status --batch "01.01" --format json
work list
work list --thread "01.01.01"
work list --tasks --thread "01.01.01"   # compatibility task view
work update --task "01.01.01.01" --status in_progress
work update --task "01.01.01.01" --status completed --report "Implemented X"
work report metrics --blockers
work export --format json
```

## Sqlite-authoritative bootstrap and migration

For new repositories, prefer sqlite-authoritative initialization:

```bash
work init --sqlite
```

That bootstraps `work/db.sqlite` as the canonical structured store. `agents.yaml` and `github.json` are still created on disk, and markdown documents plus `resources/` remain filesystem content.

For an existing repository that already has `work/index.json`, `work/<stream-id>/tasks.json`, or legacy runtime artifacts, run the same command:

```bash
work init --sqlite
```

During initialization the CLI hydrates legacy filesystem state into sqlite, keeps the current-stream pointer, imports approval/runtime history, and rewrites compatibility projections when legacy data is present.

After cutover, normal operator commands read canonical sqlite state first:

```bash
work status
work tree --batch "01.01"
work list --thread "01.01.01"
work batch-status --batch "01.01" --format json
```

Rebuild compatibility JSON from sqlite whenever you need fresh `index.json` / `tasks.json` rollback or old-tooling projections:

```bash
work rebuild-compat
work rebuild-compat --stream current
work rebuild-compat --output-root /tmp/sqlite-compat-snapshot
```

- default rebuild writes `work/index.json` plus projected `work/<stream-id>/tasks.json` files back into the repo
- `--stream` only refreshes that workstream's `tasks.json`
- `--output-root` writes a rollback-safe snapshot for `index.json` / `tasks.json` somewhere else so you can inspect the projection before replacing live compatibility files
- `work rebuild-compat` does not currently rebuild legacy runtime compatibility artifacts like `threads.json`, `supervisor-state.json`, or `batch-status/*.json`

For a direct sqlite-vs-compatibility parity check on one workstream:

```bash
STREAM_ID=001-my-feature bun --eval '
import { inspectCriticalWorkflowDualWriteParitySync } from "@agenv/workstreams"

const inspection = inspectCriticalWorkflowDualWriteParitySync(process.cwd(), process.env.STREAM_ID)
console.log(JSON.stringify({
  parity: inspection?.parity,
  summary: inspection?.divergences.summary,
  intentionalMismatches: inspection?.intentionalMismatches,
}, null, 2))
'
```

Rollback-safe inspection flow:

1. Inspect the live sqlite-backed view with `work status`, `work tree`, `work list`, or `work batch-status`.
2. Run `work rebuild-compat --output-root /tmp/sqlite-compat-snapshot`.
3. Inspect `/tmp/sqlite-compat-snapshot/work/index.json` and `/tmp/sqlite-compat-snapshot/work/<stream-id>/tasks.json` without mutating the live repo.
4. Treat that snapshot as an `index.json` / `tasks.json` compatibility snapshot only; it does not currently include `threads.json`, `supervisor-state.json`, or `batch-status/*.json`.
5. If you need to hand legacy JSON back to older tooling, rerun `work rebuild-compat` without `--output-root` after you are satisfied with the snapshot.

When legacy files still matter:

- during one-time hydration of pre-sqlite repositories
- when you need compatibility JSON for rollback drills, audits, or older tooling that still reads `index.json` / `tasks.json`
- when inspecting a rollback-safe snapshot produced by `work rebuild-compat --output-root ...`

When they do **not** matter:

- for normal sqlite-authoritative command execution after `work init --sqlite` has completed successfully
- as the source of truth for structured workstream state while `work/db.sqlite` is present and healthy
- for legacy runtime wrappers like `threads.json`, `supervisor-state.json`, and `batch-status/*.json`, except as migration inputs or explicit compatibility artifacts

Current sqlite-native runtime note:

- `work batch-status` is authoritative and sqlite-backed; do not treat `work/<stream-id>/batch-status/*.json` as a required live runtime surface.
- sqlite-native/new workstreams no longer normally project `threads.json` or `batch-status/*.json`.
- `supervisor-state.json` may still appear as a compatibility/runtime artifact during the current transition period.

## Storage architecture notes

- `work/db.sqlite` is the canonical structured source of truth in sqlite-authoritative repos.
- `work/index.json` and `work/<stream-id>/tasks.json` are compatibility projections rebuilt from sqlite for legacy tooling and inspection workflows.
- `threads.json` and `batch-status/*.json` are no longer normal projected runtime artifacts for sqlite-native workstreams.
- `supervisor-state.json` remains transitional compatibility/runtime output where current supervision flows still expect it.
- Markdown workstream docs, `resources/`, and artifact-like outputs remain filesystem-based.
- Use `work rebuild-compat` when you need to regenerate compatibility JSON from canonical sqlite state.
- Local-first sqlite architecture: [`../../docs/LOCAL_FIRST_SQLITE_ARCHITECTURE.md`](../../docs/LOCAL_FIRST_SQLITE_ARCHITECTURE.md)
- Storage adapter package/refactor recommendation: [`../../docs/STORAGE_PACKAGE_BOUNDARIES.md`](../../docs/STORAGE_PACKAGE_BOUNDARIES.md)

## Supervision Workflow (manual default; managed profile optional)

Use `work supervise` as the branch execution/recovery primitive. In the default manual profile, the user creates that branch with `/fork`; in the optional managed profile, the Root Agent can launch it with the management tool:

```bash
work supervise
work supervise --batch "01.01"
work supervise --dry-run
```

`work supervise` launches `work multi --headless --async`, waits for the batch to become terminal, and produces deterministic review evidence from canonical execution state (task status/report fields, runtime thread metadata, and persisted batch status).

The supervisor branch then either:

- continues automatically to the next incomplete batch,
- runs one automatic fix cycle (default), or
- escalates to the user based on escalation/stage-boundary policy.

Within that supervised batch execution, implementation agents commonly inspect scope with:

```bash
work status
work tree --batch "01.01"
work list --thread "01.01.01"
work list --tasks --thread "01.01.01"   # compatibility task details
```

They are expected to keep task state accurate while they work:

```bash
work update --task "01.01.01.01" --status in_progress
work update --task "01.01.01.01" --status completed --report "1-2 sentence summary"
```

In practice, orchestration continues only when the supervising branch decides the batch is safe to continue.
It stops when the supervising branch decides user input is needed, a stage boundary is reached, there is no next batch, or execution/wait fails.

If `--timeout-ms` is reached before the batch becomes terminal, the wait fails and `work supervise` exits without reviewing the incomplete batch. That interrupted run remains resumable and is preferred on the next `work supervise` rerun.

After any stop, inspect the unified persisted state before resuming:

```bash
# 1) task/thread snapshot for the batch that just ran
work tree --batch "01.01"

# 2) persisted execution state for that batch
work batch-status --batch "01.01" --format json

# 3) projected tasks.json compatibility view (includes runtime_state.supervision)
cat work/<stream-id>/tasks.json
```

Interpretation quick-guide (what success looks like vs what to inspect):

- **Terminal success / safe resume:** `work batch-status` is `completed` and `tasks.json` → `runtime_state.supervision` includes the batch under `reviewed_batches` plus persisted finalization evidence for the run decision.
- **Timeout/wait failure:** batch status remains non-terminal; inspect the batch plus `tasks.json` → `runtime_state.supervision`, then rerun plain `work supervise` to resume that same interrupted batch before later incomplete batches.
- **Escalation/stage stop:** inspect `escalations` and `stage_stops` to confirm what operator action is required.
- **Terminal failed run:** `work batch-status` is `failed`; inspect failed thread summaries before retrying.

Timeout resume smoke checklist (short drill):

1. Force interruption: `work supervise --batch "01.01" --timeout-ms 100`
2. Inspect persisted state: `work batch-status --batch "01.01" --format json` and `cat work/<stream-id>/tasks.json`
3. Resume normally: run plain `work supervise` and confirm it resumes `01.01` first (does not skip to later incomplete batches)
4. Verify outcome class:
   - **Resumed success:** batch becomes terminal `completed`, `reviewed_batches` contains `01.01`, and persisted finalization evidence for that same batch appears in `tasks.json` → `runtime_state.supervision`
   - **Still interrupted/non-terminal:** batch remains non-terminal and no new `reviewed_batches` entry exists yet (wait/investigate before treating as complete)

Persisted-state note: prefer `tasks.json` runtime ordering/evidence to verify same-batch resume, rather than relying only on transient console logs.

Escalation policy: branch runs escalate to the Root Agent; the Root Agent escalates to the user.

Key projected inspection file:

- `work/<stream-id>/tasks.json` (`tasks[]` plus `runtime_state.{threads,batches,supervision}`)

### Reporting model (v1)

For v1 supervision, task-level `report` text plus canonical workstream state are the primary review inputs.
This is sufficient for current automated follow-up decisions, but reporting may evolve in a later revision toward a richer structured format if operator workflows require more granular machine-readable evidence.

Quick post-fix verification checklist:

- **Successful completion path**: batch status is terminal and `tasks.json` → `runtime_state.supervision` records both review evidence (`reviewed_batches`) and persisted finalization evidence for that batch/run.
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

1. Verify each fix/escalate decision is grounded in persisted state inside `tasks.json` (`runtime_state.batches` + `runtime_state.supervision`), not transient logs alone.
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
- validate lineage and branch status from `work/<stream-id>/tasks.json` → `runtime_state.supervision.branch_sessions[]`
- validate the final branch report by exporting the child native session transcript and reading the last completed assistant message
- classify drift when the branch acts like the Root Agent or proposes deeper branching instead of reporting its `work supervise` outcome

For full operator guidance, verification drills, and branching background, see `../../docs/SUPERVISOR.md`, `../../docs/supervision-manual-verification-checklist.md`, and `../../docs/ROOT_AGENT_BRANCHING_ARCHITECTURE.md`.
