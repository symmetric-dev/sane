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
5. Fill `stages/01/REQUIREMENTS.md`, `stages/01/PLAN.md`, and `stages/01/specs/` (repeat per stage).
6. Approve plan: `work approve plan` (user role, requires at least one stage)
7. `work approve plan` also initializes thread execution state directly from the stage/thread plan and generates `stages/<nn>/threads/<thread-id>/WORK.md`
8. Optionally assign agents to threads before execution, for example: `work assign --thread "01.01.01" --agent "frontend-expert"`
9. Manually `/fork` the session and ask the forked session to supervise the approved work
10. The supervision branch uses `work supervise`, `work status`, `work tree`, and `work batch-status` to drive the next batch and review loop
11. Implementation agents use `implementing-workstreams` to inspect assigned scope and update thread state with `work update`
12. The supervisor reports back; the user approves the completed stage with `work approve stage <n>`
13. Repeat the supervision loop for the next stage
14. If new stages are needed after the original plan, use the revision flow:
    - `work revision --name "follow-up" [--after-stage N]`
    - `work approve revision`
15. Finalize the report with the `evaluating-workstreams` skill:
    - `work report validate`

The optional managed install profile preserves the older Root Agent management-launch workflow. The default manual profile omits the management skill and launch tool so the user controls the `/fork` handoff.

Generated files on `work create`:

- `README.md` for the initial shared workstream context
- `resources/` for supplemental inputs gathered before stage planning
- `docs/` for extra workstream notes
- `stages/` as the stage workspace root

Deferred artifacts created later in the workflow:

- `stages/<nn>/REQUIREMENTS.md` for stage-local summary, deliverables, dependencies, and resources
- `stages/<nn>/PLAN.md` for stage-local batch/thread planning
- `stages/<nn>/specs/` for stage specs
- `stages/<nn>/threads/<thread-id>/WORK.md` for the primary worker doc generated after plan/revision approval

## Useful Commands

```bash
work status
work tree
work tree --batch "01.01"
work batch-status --batch "01.01" --format json
work list
work list --thread "01.01.01"
work read --thread "01.01.01"
work assign --thread "01.01.01" --agent "frontend-expert"
work update --thread "01.01.01" --status in_progress
work update --thread "01.01.01" --status completed --report "Implemented X"
work report metrics --blockers
work export --format json
```

## Sqlite-authoritative bootstrap and migration

For new repositories, prefer sqlite-authoritative initialization:

```bash
work init --sqlite
```

That bootstraps `work/db.sqlite` as the canonical structured store. `agents.yaml` and `github.json` are still created on disk, and markdown documents plus `resources/` remain filesystem content.

For an existing repository that already has `work/index.json` or legacy runtime artifacts, run the same command:

```bash
work init --sqlite
```

During initialization the CLI hydrates legacy filesystem state into sqlite, keeps the current-stream pointer, and imports approval/runtime history when legacy data is present.

After cutover, normal operator commands read canonical sqlite state first:

```bash
work status
work tree --batch "01.01"
work list --thread "01.01.01"
work batch-status --batch "01.01" --format json
```

Legacy runtime files only matter as one-time migration inputs.

## Storage architecture notes

- `work/db.sqlite` is the canonical structured source of truth in sqlite-authoritative repos.
- `work/<stream-id>/workstream-state.json` is the canonical filesystem fallback when sqlite is absent.
- Legacy `threads.json`, `supervisor-state.json`, and `batch-status/*.json` are migration inputs only and are not maintained as live runtime artifacts.
- Markdown workstream docs, `resources/`, and artifact-like outputs remain filesystem-based.

## Supervision Workflow (manual default; managed profile optional)

Use `work supervise` as the branch execution/recovery primitive. In the default manual profile, the user creates that branch with `/fork`; in the optional managed profile, the Root Agent can launch it with the management tool:

```bash
work supervise
work supervise --batch "01.01"
work supervise --dry-run
```

`work supervise` launches `work multi --headless --async`, waits for the batch to become terminal, and produces deterministic review evidence from canonical execution state (thread/item status and reports, runtime thread metadata, and persisted batch status).

The supervisor branch then either:

- continues automatically to the next incomplete batch,
- runs one automatic fix cycle (default), or
- escalates to the user based on escalation/stage-boundary policy.

Within that supervised batch execution, implementation agents commonly inspect scope with:

```bash
work status
work tree --batch "01.01"
work list --thread "01.01.01"
work read --thread "01.01.01"
```

They are expected to keep thread state accurate while they work:

```bash
work update --thread "01.01.01" --status in_progress
work update --thread "01.01.01" --status completed --report "1-2 sentence summary"
```

In practice, orchestration continues only when the supervising branch decides the batch is safe to continue.
It stops when the supervising branch decides user input is needed, a stage boundary is reached, there is no next batch, or execution/wait fails.

If `--timeout-ms` is reached before the batch becomes terminal, the wait fails and `work supervise` exits without reviewing the incomplete batch. That interrupted run remains resumable and is preferred on the next `work supervise` rerun.

After any stop, inspect the unified persisted state before resuming:

```bash
# 1) thread/item snapshot for the batch that just ran
work tree --batch "01.01"

# 2) persisted execution state for that batch
work batch-status --batch "01.01" --format json

# 3) filesystem fallback snapshot when sqlite is absent
cat work/<stream-id>/workstream-state.json
```

Interpretation quick-guide (what success looks like vs what to inspect):

- **Terminal success / safe resume:** `work batch-status` is `completed`.
- **Timeout/wait failure:** batch status remains non-terminal; inspect `work batch-status` first.
- **Escalation/stage stop:** inspect `escalations` and `stage_stops` to confirm what operator action is required.
- **Terminal failed run:** `work batch-status` is `failed`; inspect failed thread summaries before retrying.

Timeout resume smoke checklist (short drill):

1. Force interruption: `work supervise --batch "01.01" --timeout-ms 100`
2. Inspect persisted state: `work batch-status --batch "01.01" --format json`
3. Resume normally: run plain `work supervise` and confirm it resumes `01.01` first (does not skip to later incomplete batches)
4. Verify outcome class:
   - **Resumed success:** batch becomes terminal `completed`, `reviewed_batches` contains `01.01`, and the same finalization evidence is visible in canonical runtime state
   - **Still interrupted/non-terminal:** batch remains non-terminal and no new `reviewed_batches` entry exists yet (wait/investigate before treating as complete)

Persisted-state note: prefer `work batch-status` and canonical runtime queries to verify same-batch resume, rather than relying only on transient console logs.

Escalation policy: branch runs escalate to the Root Agent; the Root Agent escalates to the user.

Optional filesystem fallback inspection file:

- `work/<stream-id>/workstream-state.json`

### Reporting model (v1)

For v1 supervision, thread/item-level `report` text plus canonical workstream state are the primary review inputs.
This is sufficient for current automated follow-up decisions, but reporting may evolve in a later revision toward a richer structured format if operator workflows require more granular machine-readable evidence.

Quick post-fix verification checklist:

- **Successful completion path**: batch status is terminal and canonical supervision state records both review evidence (`reviewed_batches`) and persisted finalization evidence for that batch/run.
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

1. Verify each fix/escalate decision is grounded in persisted canonical runtime state, not transient logs alone.
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
- validate lineage and branch status from canonical supervision state
- validate the final branch report by exporting the child native session transcript and reading the last completed assistant message
- classify drift when the branch acts like the Root Agent or proposes deeper branching instead of reporting its `work supervise` outcome

For full operator guidance, verification drills, and branching background, see `../../docs/SUPERVISOR.md`, `../../docs/supervision-manual-verification-checklist.md`, and `../../docs/ROOT_AGENT_BRANCHING_ARCHITECTURE.md`.
