# Supervision Operator Guide

This guide is the operator-facing reference for supervised workstream runs.

- Use this doc for **how to run, observe, inspect, resume, and troubleshoot** supervision.
- Use [`docs/ROOT_AGENT_BRANCHING_ARCHITECTURE.md`](./ROOT_AGENT_BRANCHING_ARCHITECTURE.md) for **why the branching model works the way it does**.
- Use [`docs/supervision-manual-verification-checklist.md`](./supervision-manual-verification-checklist.md) for **quick validation drills, including the optional tmux/tool E2E smoke test**.

## Where supervision fits in the full workflow

Supervision is the execution layer inside the broader workstream lifecycle:

1. A planning agent uses `creating-workstream-plans` to prepare the workstream.
2. The user approves the plan.
3. The user manually `/fork`s the session and asks the forked session to supervise the approved work.
4. The management branch uses `managing-workstream-implementation` and runs `work supervise`.
5. Implementation agents inside that managed batch use `implementing-workstream-threads` to inspect thread scope, execute their assigned work, and keep thread state accurate.
6. The supervisor fork reports back to the user.
7. The user approves the completed stage with `work approve stage N`.
8. The loop repeats until all stages are complete, then `REPORT.md` is finalized with `evaluating-workstreams`.

So this document is specifically about steps 3-5 above: manually handing work to a supervisor fork, running, observing, resuming, and interpreting supervised execution. The older Root Agent management-launch flow remains available through the managed installation profile, but it is not the default.

## What `work supervise` does now

`work supervise` is a **single-batch execution and recovery helper**.

It does four things:

1. chooses the next resumable or incomplete batch,
2. launches or resumes headless batch execution,
3. waits for persisted `batch-status` to become terminal,
4. records a **handoff** back to the Root Agent or calling branch.

It does **not** approve, reject, escalate, or run fix cycles by itself. Those decisions remain parent-side and are persisted in canonical supervision runtime state.

That distinction is the most important operator mental model:

- `work supervise` gets a batch to a trustworthy handoff point.
- the supervisor fork and user decide what to do next.

## Primary commands

```bash
# resume the current resumable batch, or start the next incomplete one
work supervise

# force supervision to start from a specific batch
work supervise --batch "03.02"

# inspect the planned action without changing state
work supervise --dry-run
```

Common flags:

- `--port`: pass an existing OpenCode server port to the headless launch
- `--no-server`: do not start `opencode serve`
- `--silent`: disable sounds
- `--timeout-ms`: stop waiting after this many milliseconds (default `1200000` / 20 minutes)
- `--poll-interval-ms`: polling interval while waiting for `batch-status` (default `1000`)

Recommended default for real operator runs:

```bash
work supervise --batch "SS.BB"
```

The default 20-minute wait budget is the normal mode. Use short timeouts only for interruption and recovery drills.

## Standard operator workflow

### 1) Pick the right starting point

```bash
work status
work list --batch "SS.BB"
work tree --batch "SS.BB"
work supervise --batch "SS.BB"
```

Use `work supervise` without `--batch` only when you want the tool to prefer the currently resumable batch automatically.

During or after a supervise pass, implementation agents commonly inspect their scope with:

```bash
work status
work tree --batch "SS.BB"
work list --thread "SS.BB.TT"
work read --thread "SS.BB.TT"
```

They are expected to keep thread state current while they work:

```bash
work update --thread "SS.BB.TT" --status in_progress
work update --thread "SS.BB.TT" --status completed --report "1-2 sentence summary"
```

### 2) Watch the CLI for the expected milestones

The normal sequence is:

1. `[supervise] starting run ...` or `[supervise] resume: ...`
2. `[supervise] start batch SS.BB` or `[supervise] recovering terminal batch-status SS.BB`
3. `[supervise] waiting for batch-status SS.BB`
4. `[supervise] batch SS.BB finished: completed|failed`
5. `[supervise] handoff: batch SS.BB reached ...`

Important:

- a terminal `batch-status` plus a `handoff` message means the helper finished its job,
- it does **not** mean the batch was already reviewed or approved.

### 3) Observe tmux correctly

Supervision now has **two distinct tmux layers** when branch supervision is involved:

1. **Supervision branch tmux**: `001-supervision-*`
2. **Implementation batch tmux**: `001-implementation-*`

Useful commands:

```bash
tmux list-sessions
tmux attach -t <session-name>
```

Operator expectations:

- watch `001-supervision-*` when you need the branch/root-agent supervision timeline,
- watch `001-implementation-*` when you need the actual worker batch execution,
- treat tmux as an observability aid, not the source of truth.

If tmux disappears but persisted state reaches a terminal result, trust persisted evidence first.

## Source-of-truth hierarchy

For any supervised run, inspect these in this order:

```bash
# 1) canonical batch execution view
work batch-status --batch "SS.BB" --format json

# 2) human-friendly thread/runtime projection
work tree --batch "SS.BB"

```

Important operator rule:

- prefer the `work batch-status` CLI as the public batch-status interface
- do **not** rely on a literal `work/<stream>/batch-status/<batch>.json` path in scripts or runbooks
- treat tmux state and transcript export as supporting evidence, not primary truth

### `work batch-status`

Use this to answer: **did batch execution become terminal?**

The CLI abstracts the persisted storage layout. Operators should rely on the command output rather than a hard-coded on-disk file path.

Key fields to inspect:

- `status`: `queued` / `running` / `completed` / `failed`
- `summary`: thread counts
- `updatedAt`
- `completedAt` when terminal
- `tmuxSessionName` when the launch recorded one

Some code paths and historical discussion still use the label `supervisor-state`; today the canonical persisted runtime lives in sqlite-backed supervision state.

Key areas:

- `active_run_id`: optional resume pointer; treat it as a hint that must be checked against `runs[]` and current `work batch-status` output
- `runs[]`: current batch, run status, and stop metadata
- `reviewed_batches[]`: parent-side review records after handoff
- `fix_cycles[]`: fix attempts recorded after review
- `escalations[]`: reasons that required Root Agent or user input
- `stage_stops[]`: deliberate stage/boundary stop records
- `branch_sessions[]`: branch supervision launch/finalization evidence

Important operator rule:

- **handoff only**: expect `runs[]` to pause before any new `reviewed_batches[]` entry exists
- **review/fix/escalation complete**: expect additional records in `reviewed_batches[]`, `fix_cycles[]`, `escalations[]`, or `stage_stops[]`
- do **not** treat `active_run_id` by itself as proof that a run is still live or as the latest truth after recovery/finalization

## How to interpret stop conditions

### A. Clean supervise-pass handoff

This is the expected result of a normal `work supervise` pass.

Evidence:

- `batch-status` is terminal (`completed` or `failed`)
- `runs[]` for that run is `paused`
- `active_run_id` is usually cleared after handoff; if not, verify the matching `runs[]` record and current `work batch-status` output before assuming the run is still active
- CLI printed `handoff:`
- `reviewed_batches[]` may still be unchanged

Meaning:

- execution finished,
- the helper yielded safely,
- the Root Agent still needs to review and decide whether to continue, fix, escalate, or stop.

### B. Timeout or interrupted wait

Evidence:

- CLI printed `timeout:` and exited with a timeout error
- `runs[]` remains `running`
- `active_run_id`, if still present, should point at the same resumable run
- `reviewed_batches[]` does not gain a new entry for that batch

Meaning:

- the helper stopped waiting,
- the underlying batch may still be running or may finish later,
- rerunning `work supervise` should resume the same batch before any later incomplete batch.

### C. Already-terminal recovery

Evidence:

- CLI prints `resume: batch SS.BB already reached completed|failed; recovering persisted results from run`
- then `recovering terminal batch-status SS.BB`
- then the usual `handoff:` line

Meaning:

- the first caller stopped or detached,
- persisted state later became terminal,
- the next `work supervise` recovered the same run instead of relaunching work.

### D. No incomplete batches remain

Evidence:

- CLI prints `No incomplete batches remain ...`

Meaning:

- there is nothing left to supervise in the current default scope,
- for stage-scoped branches, this is also the normal end-of-scope condition.

### E. Escalation or stage stop

`work supervise` itself does not create the final policy decision, but parent-side supervision does.

Evidence in canonical supervision runtime state:

- `escalations[]` entry for the batch or stage,
- `stage_stops[]` entry with the stop reason,
- related `runs[]` stop metadata.

Meaning:

- execution reached handoff,
- parent-side review decided not to continue automatically.

## Persisted evidence patterns to check

### Normal run

Check for:

1. terminal `work batch-status --batch "SS.BB" --format json` output
2. `runs[]` moved to `paused`
3. branch session, if present, still shows the supervision session lineage
4. later parent-side review evidence in `reviewed_batches[]` and follow-up arrays

### Interrupted run

Check for:

1. non-terminal or later-updated `work batch-status --batch "SS.BB" --format json` output
2. `active_run_id` may still be set, but confirm against `runs[]`
3. the same `currentBatchId` still present in `runs[]`
4. no premature review/fix/escalation record for that batch

Safe resume command:

```bash
work supervise
```

Do not jump to a later batch unless persisted state shows the interrupted one was already recovered and handed off.

### Reconciled branch-supervision run

When a supervision branch process ended before explicit finalization, inspect `branch_sessions[]` for:

- terminal `status` (`completed`, `stopped`, or `failed`)
- `processEndedAt`
- `processExitCode`
- `finalizationSource`
- `finalizationReason`
- `nativeSessionId`
- `notes`

Typical reconciliation evidence:

- `finalizationSource: "parent_process_exit_reconciliation"`
- `finalizationReason` explains whether transcript/report evidence was recovered
- the stuck nonterminal branch session is no longer blocking a fresh launch for the same scope

This is the main signal that a branch ended, parent-side recovery inspected it, and durable terminal state was written afterward.

## Final report signals for branch supervision

When the run was launched through Root Agent branch supervision, final report evidence is split across persisted metadata and transcript export.

Check:

1. `branch_sessions[]` terminal state in canonical supervision runtime state
2. `nativeSessionId` from the matching branch record
3. `opencode export "<native-session-id>"`

Expected branch report shape:

- `## Accomplished`
- `## Issues Found`
- `## Fixes Applied`
- `## What is Next`

If transcript export and persisted state disagree, trust persisted state first, then treat report extraction as a follow-up debugging problem.

## Safe resume checklist

Resume with plain `work supervise` when all of these are true:

- the interrupted or active run is still the current `active_run_id`,
- or, if `active_run_id` is absent/unclear, the most recent relevant `runs[]` entry still points at that same batch,
- `runs[]` still points at the same `currentBatchId`,
- no later batch has already been reviewed ahead of it,
- no unresolved escalation or stage stop tells you to pause for user input.

Use `work supervise --batch "SS.BB"` only when you intentionally need to pin the resumed target.

## Troubleshooting

### Duplicate supervision launch was refused

If the tool reports an active nonterminal supervision session already exists:

- inspect the existing `branch_sessions[]` record,
- attach to its tmux session if `tmuxSessionName` is present,
- do not launch a second overlapping supervision session for the same scope.

### Tmux session vanished unexpectedly

If the tmux session is gone:

1. inspect `work batch-status --batch "SS.BB" --format json`
2. if state is already terminal, proceed from persisted evidence
3. if branch supervision is stuck nonterminal, reconcile it

Recovery tool:

```text
reconcile_workstream_supervision({ streamId: "001-my-stream" })
```

Optional narrowing:

```text
reconcile_workstream_supervision({
  streamId: "001-my-stream",
  branchSessionId: "branch-supervision-..."
})
```

### A run looks stuck or contradictory

Use this order:

1. `work batch-status --batch "SS.BB" --format json`
2. `tmux list-sessions`
3. inspect the workstream tool log

Default log path:

```text
/tmp/agenv-workstream-tool.log
```

Override with:

```bash
WORKSTREAM_TOOL_LOG_PATH=/path/to/log.jsonl
```

### A branch ended but no clear final report was captured

Inspect `branch_sessions[]` first.

- If `processEndedAt` and reconciliation fields exist, the runtime likely recovered the process-end state even if the transcript report was partial.
- If `nativeSessionId` exists, export the transcript and inspect the last completed assistant message.
- If evidence is ambiguous, treat the run as `stopped` or `failed`, not as implicit success.

## Related references

- [`docs/ROOT_AGENT_BRANCHING_ARCHITECTURE.md`](./ROOT_AGENT_BRANCHING_ARCHITECTURE.md)
- [`docs/supervision-manual-verification-checklist.md`](./supervision-manual-verification-checklist.md)
- [`docs/INSTALL.md`](./INSTALL.md)
