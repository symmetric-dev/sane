# Root Agent Branch Supervision (`work supervise`)

This document covers the v1 Root Agent supervision workflow for headless batch execution, deterministic review input collection, and Root Agent-owned fix/escalation decisions.

> v1 scope: `work supervise` is an execution/recovery primitive over existing `work` + Opencode CLI flows. Branch policy decisions are owned by the Root Agent.

## Intended Flow

The Root Agent runs one batch at a time and loops through this sequence:

1. Pick a starting batch:
   - explicit: `work supervise --batch "SS.BB"`
   - default: next incomplete batch in the current stream
2. Launch headless execution using:
   - `work multi --headless --async ...`
3. Wait for persisted batch status (`work/<stream-id>/batch-status/<batch-id>.json`) to reach a terminal state.
4. Consume deterministic review outputs after the batch finishes, using canonical workstream state (task status/report fields, thread/session metadata, batch status, and persisted artifacts when present).
5. Root Agent decides next action:
   - approve batch and continue,
   - run one automatic fix cycle and re-review,
   - or escalate to the user.
6. Persist all run/review/fix/escalation/stage-stop metadata in:
   - `work/<stream-id>/supervisor-state.json`

Escalation policy: branch runs escalate to the Root Agent; the Root Agent escalates to the user.

## Command Usage

```bash
# supervise from next incomplete batch
work supervise

# supervise from a specific batch
work supervise --batch "03.01"

# dry-run intended actions only
work supervise --dry-run
```

Common flags:

- `--port`: pass OpenCode server port to the headless `work multi` launch
- `--no-server`: do not start `opencode serve` as part of execution
- `--silent`: disable batch notification sounds
- `--timeout-ms`: stop waiting if batch status does not complete in time; supervisor exits without reviewing the incomplete batch, and the interrupted run remains resumable on rerun
- `--poll-interval-ms`: polling interval while waiting for batch status

### Long-running Root Agent usage (recommended)

For real Root Agent runs, prefer an intentionally long wait budget so the caller can stay attached while headless work and deterministic review complete:

```bash
# Recommended for production-style runs
work supervise --batch "SS.BB" --poll-interval-ms 1000 --timeout-ms 1200000
```

- `1200000` ms = **20 minutes**.
- Use this as the default when validating end-to-end supervisor behavior under normal load.
- Keep short timeouts for targeted failure/recovery drills, not for primary runs.

## Root Agent Review/Fix Behavior and Default Stop Conditions

Default v1 behavior remains conservative:

- `review_limits.max_fix_cycles_per_batch = 1`
  - one automatic fix cycle is allowed per batch
  - if issues remain after that limit, Root Agent escalates to user
- `stage_completion.stop = true`
- `stage_completion.contact_user = true`
  - when a stage boundary is reached, Root Agent stops and requests user input
  - no automatic stage-level fix cycle is attempted

Root Agent continues automatically only when all of the following are true:

- the batch reached a terminal status,
- review passed (or the one allowed auto-fix cycle succeeded),
- no escalation/contact-user trigger fired,
- no stage-boundary stop trigger fired,
- and another incomplete batch exists.

Root Agent stops when any of the following happens:

- escalation requires user input,
- stage boundary stop/contact-user condition is hit,
- there is no next batch to run,
- or an execution/wait error occurs.

Timeout semantics in v1 are strict but interruption-safe:

- `waitForBatchStatus()` only returns when the batch reaches a terminal state (`completed` or `failed`)
- if `--timeout-ms` elapses first, the wait fails with the latest persisted non-terminal state left in `work/<stream-id>/batch-status/<batch-id>.json`
- `work supervise` skips review/fix follow-up for that incomplete batch, leaves the run resumable, and prefers that interrupted batch again on the next `work supervise` rerun

## Smoke-Test Follow-up Checklist (Post-Fix)

After a supervised batch reports completion, verify this quick checklist to confirm the repaired completion fallback path behaved correctly:

### Successful completion evidence

- `work/<stream-id>/batch-status/<batch-id>.json`
  - `status` is terminal (`completed` or `failed`) and no longer `running`/`queued`.
  - For the repaired fallback case, terminal status can be canonicalized even when tmux artifacts are missing.
- `work/<stream-id>/supervisor-state.json`
  - `reviewed_batches` includes the batch id (proof review ran after terminalization).
  - persisted finalization evidence is present, such as completed run state and/or a matching `stage_stops` record reflecting the supervisor's terminal decision for that batch/run.
  - `stage_stops` or `escalations` reflect the actual stop decision when applicable (for example: stage boundary contact-user, no remaining batches, or escalation trigger).
- Supervisor output includes both terminal and review signals (for example: `batch ... finished: completed` then `review ...`).

### Timeout/failure evidence (not successful completion)

- `work/<stream-id>/batch-status/<batch-id>.json` remains non-terminal when wait times out.
- `work/<stream-id>/supervisor-state.json` does **not** gain a new reviewed entry for that incomplete batch; the interrupted run remains resumable until the batch reaches a terminal state and review can continue.
- Supervisor output shows wait/timeout failure and stops before review/fix follow-up.

## `work/supervisor.json` Config Shape

Supervisor policy is loaded from repo-level config:

- `work/supervisor.json`

If the file is missing, built-in defaults are used.

```json
{
  "issue_taxonomy": {
    "severity": ["high", "medium", "low"],
    "difficulty": ["complex", "regular", "trivial"],
    "ownership": ["product", "engineering"],
    "effort": ["tasks", "revision", "workstream"]
  },
  "review_limits": {
    "max_fix_cycles_per_batch": 1
  },
  "stage_completion": {
    "stop": true,
    "contact_user": true
  },
  "escalation": {
    "contact_user_on": {
      "severity": { "values": [], "min_count": 1 },
      "difficulty": { "values": ["complex"], "min_count": 1 },
      "ownership": { "values": ["product"], "min_count": 1 },
      "effort": { "values": ["revision", "workstream"], "min_count": 1 },
      "review_fix_limit_reached": true,
      "stage_completion": true
    }
  }
}
```

### Naive v1 escalation defaults

The default `contact_user_on` policy triggers escalation when **any configured trigger** is met:

- difficulty includes `complex` (at least 1 matching issue)
- ownership includes `product` (at least 1 matching issue)
- effort includes `revision` or `workstream` (at least 1 matching issue)
- review/fix limit is reached
- stage completion trigger is enabled

`severity.values` defaults to an empty list, so severity alone does not trigger contact-user until configured.

## Root Agent Guidance: Inspect, Interpret, Resume

After every supervised batch run (especially when orchestration stops), run this quick inspection flow before resuming.

### 1) Quick inspection commands

```bash
# 1) task/thread state snapshot for the batch that just ran
work tree --batch "SS.BB"

# 2) persisted batch execution result (terminal vs non-terminal)
work batch-status --batch "SS.BB" --format json

# 3) persisted supervisor decision history for this stream
cat work/<stream-id>/supervisor-state.json
```

What each check tells you:

- `work tree --batch "SS.BB"`: which tasks/threads are complete, failed, or still in progress.
- `work batch-status --batch "SS.BB" --format json`: whether execution is terminal (`completed`/`failed`) or still non-terminal (for timeout/wait failures).
- `work/<stream-id>/supervisor-state.json`: whether the Root Agent reviewed this batch and why it stopped (`reviewed_batches`, `escalations`, `stage_stops`).

### 2) How to read terminal outcomes quickly

Use this mental model to quickly separate success from required Root Agent follow-up:

- **Terminal success (good stop or clean continue point):**
  - `work batch-status` shows `status: "completed"`
  - no failed threads in the batch summary
  - `supervisor-state.json` includes this batch in `reviewed_batches`
- **Timeout while still running (wait failure):**
  - `work supervise` exits with timeout/wait failure
  - `work batch-status` remains non-terminal at last persisted state
  - `supervisor-state.json` keeps the interrupted run resumable on its current batch so a later `work supervise` rerun resumes it before moving on
- **Escalation/contact-user stop (needs Root Agent + user decision):**
  - batch may still be terminal (`completed`)
  - `supervisor-state.json` adds an `escalations` entry and corresponding `stage_stops` record
  - Root Agent waits for user action before continuing
- **Terminal failed run (batch finished as failed):**
  - `work batch-status` shows `status: "failed"`
  - `supervisor-state.json` records a failed stop; inspect failed thread summaries first

If you're deciding whether it is safe to resume with `work supervise`, use this shortcut:

- Resume normally when batch status is terminal and `reviewed_batches` contains the batch.
- Inspect first when batch status is non-terminal, an escalation was recorded, or batch status is `failed`; after inspection, rerunning `work supervise` will prefer the interrupted/resumable batch before any later incomplete batch.

### 3) Resume modes

1. **Continue default progression**
   - run `work supervise`
   - resumes any interrupted/resumable batch first; otherwise starts from the next incomplete batch
2. **Re-run a specific batch after manual fixes/policy adjustments**
   - run `work supervise --batch "SS.BB"`
3. **After stage-boundary stop**
   - review/approve stage outcome
   - run `work supervise` to proceed into next incomplete batch (often next stage)

If you change escalation behavior, edit `work/supervisor.json` and re-run `work supervise`.

### 4) Timeout interruption + default resume checklist

Use this quick drill to verify interruption-safe recovery without forcing `--batch` during resume.

1. Intentionally force a short-timeout interruption:
   - `work supervise --batch "SS.BB" --timeout-ms 100`
   - Expect timeout/wait failure before review/finalization finishes.
2. Inspect persisted state before rerunning:
   - `work batch-status --batch "SS.BB" --format json`
   - `cat work/<stream-id>/supervisor-state.json`
3. Resume using plain progression:
   - `work supervise`
   - Expected behavior: Root Agent orchestration resumes interrupted `SS.BB` first instead of skipping to a later incomplete batch.
4. Distinguish evidence clearly:
   - **Resumed review/finalization success:** `SS.BB` reaches terminal `completed`, `reviewed_batches` includes `SS.BB`, and persisted finalization evidence appears in `supervisor-state.json` (for example completed run state and/or the expected `stage_stops` entry for that resumed batch decision).
   - **Non-terminal interruption (still needs action):** batch status remains non-terminal, no new `reviewed_batches` entry for `SS.BB`, and you should keep waiting or investigate worker/escalation state.

Persisted-state note for same-batch resume verification:

- Do not rely only on resumed console output.
- Confirm the resumed batch by checking that the next persisted `supervisor-state.json` update still references `SS.BB` before any later incomplete batch appears in `reviewed_batches`, `stage_stops`, or other run/finalization metadata.

## Prompt-First Live Test Guidance (One-Level Experiment)

This revision intentionally validates a **prompt-first** branch handoff before promoting the behavior into a dedicated supervising skill.

### Scope guardrail

- Only the real Root Agent may launch a supervision branch.
- If a branch session tries to call `launch_supervision_branch`, the launch path must fail immediately with a clear guardrail error.
- Treat that failure as correct behavior for this experiment: the branch should **yield back** to the Root Agent instead of building a deeper branch tree.

### What makes a checkpoint branch-safe

Use a checkpoint only when all of the following are true:

- the workstream plan, current revision, and task ownership are already settled
- the branch needs execution context, not the Root Agent's orchestration debate
- later Root Agent reasoning about policy, escalation, or future branching has not yet polluted the transcript
- the Root Agent would still trust the checkpointed context if the branch started from it again right now

If any of those assumptions changed, refresh the checkpoint before the next live run.

### Expected fake-user prompt behavior

The child branch prompt should act like a simulated user handing one bounded job to the branch:

- tell the branch to run the exact `work supervise ... --root-session-id ... --branch-session-id ...` command
- keep the branch focused on supervision execution/recovery only
- allow review/fix subagents only when `work supervise` requires them
- end with a short yield report back to the Root Agent, not a new branch launch or direct user escalation

### Live-run inspection flow for the real Root Agent

After launching the branch, inspect these artifacts in order:

1. **Checkpoint + lineage evidence**
   - confirm the branch started from the intended checkpoint/fork point
   - inspect `work/<stream-id>/supervisor-state.json` → `branch_sessions[]`
   - verify `rootSessionId`, `branchSessionId`, `parentSessionId`, optional `parentBranchSessionId`, and `nativeSessionId`
2. **Terminal branch status**
   - confirm the branch session reached `completed`, `stopped`, or `failed`
   - use `branch_sessions[].status`, `batchId`, `runId`, `updatedAt`, and `notes`
3. **Extracted final report**
   - export the child transcript from its native session id: `opencode export "<native-session-id>"`
   - treat the **last completed assistant message** as the branch's final report source
   - verify it states: accomplished work, issues/fixes, and why the branch yielded back

### Evidence of correct yield-back vs drift

**Correct yield-back evidence**

- the branch runs `work supervise` instead of discussing higher-level orchestration
- the final assistant message reads like a short handoff/report to the Root Agent
- the reported stop reason matches persisted state such as terminal batch status, escalation, timeout, or stage stop
- any nested branch attempt is blocked by the one-level guardrail and reported back upward

**Drift evidence**

- the branch talks as if it owns the whole workstream or is the real Root Agent
- it proposes launching another supervision branch instead of yielding
- its final message lacks a concrete yield reason grounded in persisted state
- transcript claims do not match `branch_sessions[]`, `batch-status/*.json`, or `supervisor-state.json`

### Why the branch yielded back

For this experiment, every acceptable yield reason should be explainable from persisted evidence. Typical reasons:

- batch reached a terminal state and is ready for Root Agent inspection
- timeout/non-terminal wait requires Root Agent follow-up
- escalation or stage boundary requires Root Agent review before user contact
- one-level guardrail blocked a nested branch launch

## Validation Strategy: Root Agent Ownership and Drift Reduction

Use this validation flow to confirm Root Agent-owned branch orchestration reduces drift vs the previous self-contained `work supervise` policy model.

### A) Policy ownership checks (manual)

For each supervised batch decision, verify the decision source is Root Agent-visible persisted state:

1. `work batch-status --batch "SS.BB" --format json`
2. `cat work/<stream-id>/supervisor-state.json`
3. Confirm Root Agent decisions map directly to:
   - terminal/non-terminal status,
   - `reviewed_batches` outcomes,
   - `fix_cycles` attempt counts,
   - `escalations`/`stage_stops` triggers.

Drift signal to avoid: decisions made from transient console output alone without matching persisted evidence.

### B) Automated regression checks (tests)

From `packages/workstreams`:

```bash
bun run test tests/supervise.test.ts tests/supervisor-state.test.ts
```

These tests validate deterministic review inputs, fix/escalation metadata persistence, and resumable state behavior used by Root Agent orchestration.

### C) Recovery drill (behavioral)

Run this drill in order:

1. **20-minute real run first**
   - `work supervise --batch "SS.BB" --timeout-ms 1200000`
   - Confirms baseline behavior in the intended long-running mode.
2. **Short-timeout interruption drill**
   - Force an interruption on the target batch:
     - `work supervise --batch "SS.BB" --timeout-ms 100`
   - This should produce a timeout/wait failure while leaving the interrupted run resumable.
3. **Recovery rerun (plain supervision primitive)**
   - Resume with plain progression (no `--batch`):
     - `work supervise`
   - Expected behavior: the same interrupted batch is resumed first, then reviewed/finalized before considering later incomplete batches.

Expected evidence after step (3):

- `supervisor-state.json` shows the interrupted `SS.BB` run being resumed/reviewed/finalized first (same batch, not a new launch of a later batch), with completed run state and/or matching `stage_stops` evidence when the run stops.
- terminal batch status for `SS.BB` is preserved/canonicalized and reaches reviewed/finalized outcome.
- output/log flow shows resume messaging for `SS.BB` before any mention of later incomplete batches.

## Practical Model for v1

Think of `work supervise` as an execution/recovery layer that feeds Root Agent orchestration decisions:

- execution primitive: `work multi --headless --async`
- review primitive: deterministic reviewer normalization
- decision primitive (Root Agent-owned): escalation + fix-limit + stage-boundary rules
- persistence primitive: `supervisor-state.json`

It is intentionally simple in v1 so the Root Agent can inspect, tune policy, and iterate safely over time.

### Reporting model and known v1 limits

Current supervisor evidence is centered on:

- task status + task `report`
- thread/session runtime metadata in `threads.json`
- canonical batch state in `batch-status/*.json`
- persisted supervisor decisions in `supervisor-state.json`

This model is sufficient for v1 because it supports deterministic pass/fail/fix/escalation decisions without a separate synthesis artifact.
Remaining gap: reports are still mostly free-form text, so future revisions may introduce richer structured reporting if Root Agent workflows need finer-grained machine interpretation, stronger schema validation, or cross-batch analytics.
