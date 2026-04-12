# Supervisor Automation (`work supervise`)

This document covers the v1 supervisor workflow for headless batch execution, automated review/fix decisions, and operator handoff.

> v1 scope: supervisor automation **wraps existing `work` + Opencode CLI flows**. It does **not** implement live agent-to-agent messaging.

## Intended Flow

The supervisor runs one batch at a time and loops through this sequence:

1. Pick a starting batch:
   - explicit: `work supervise --batch "SS.BB"`
   - default: next incomplete batch in the current stream
2. Launch headless execution using:
   - `work multi --headless --async ...`
3. Wait for persisted batch status (`work/<stream-id>/batch-status/<batch-id>.json`) to reach a terminal state.
4. Run deterministic review over thread outputs only after the batch finishes.
5. Decide next action:
   - approve batch and continue,
   - run one automatic fix cycle and re-review,
   - or stop and escalate to user.
6. Record all run/review/fix/escalation/stage-stop metadata in:
   - `work/<stream-id>/supervisor-state.json`

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
- `--timeout-ms`: fail waiting if batch status does not complete in time; supervisor stops immediately and does not review an incomplete batch
- `--poll-interval-ms`: polling interval while waiting for batch status

## Review/Fix Behavior and Default Stop Conditions

Default v1 behavior is conservative:

- `review_limits.max_fix_cycles_per_batch = 1`
  - one automatic fix cycle is allowed per batch
  - if issues remain after that limit, supervisor stops and escalates
- `stage_completion.stop = true`
- `stage_completion.contact_user = true`
  - when a stage boundary is reached, supervisor stops and requests user input
  - no automatic stage-level fix cycle is attempted

Supervisor continues automatically only when all of the following are true:

- the batch reached a terminal status,
- review passed (or the one allowed auto-fix cycle succeeded),
- no escalation/contact-user trigger fired,
- no stage-boundary stop trigger fired,
- and another incomplete batch exists.

Supervisor stops when any of the following happens:

- escalation requires user input,
- stage boundary stop/contact-user condition is hit,
- there is no next batch to run,
- or an execution/wait error occurs (including timeout while still non-terminal, recorded as failed stop).

Timeout semantics in v1 are strict:

- `waitForBatchStatus()` only returns when the batch reaches a terminal state (`completed` or `failed`)
- if `--timeout-ms` elapses first, the wait fails with the latest persisted non-terminal state left in `work/<stream-id>/batch-status/<batch-id>.json`
- `work supervise` treats that timeout as a run failure and skips review/fix follow-up for the incomplete batch

## Smoke-Test Follow-up Checklist (Post-Fix)

After a supervised batch reports completion, verify this quick checklist to confirm the repaired completion fallback path behaved correctly:

### Successful completion evidence

- `work/<stream-id>/batch-status/<batch-id>.json`
  - `status` is terminal (`completed` or `failed`) and no longer `running`/`queued`.
  - For the repaired fallback case, terminal status can be canonicalized even when tmux artifacts are missing.
- `work/<stream-id>/supervisor-state.json`
  - `reviewed_batches` includes the batch id (proof review ran after terminalization).
  - `stage_stops` or `escalations` reflect the actual stop decision (for example: stage boundary contact-user, no remaining batches, or escalation trigger).
- Supervisor output includes both terminal and review signals (for example: `batch ... finished: completed` then `review ...`).

### Timeout/failure evidence (not successful completion)

- `work/<stream-id>/batch-status/<batch-id>.json` remains non-terminal when wait times out.
- `work/<stream-id>/supervisor-state.json` does **not** gain a new reviewed entry for that incomplete batch and instead records the failed stop outcome.
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

## Operator Guidance: Inspect, Interpret, Resume

After every supervised batch run (especially when supervisor stops), run this quick inspection flow before resuming.

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
- `work/<stream-id>/supervisor-state.json`: whether supervisor reviewed this batch and why it stopped (`reviewed_batches`, `escalations`, `stage_stops`).

### 2) How to read terminal outcomes quickly

Use this mental model to quickly separate success from operator follow-up:

- **Terminal success (good stop or clean continue point):**
  - `work batch-status` shows `status: "completed"`
  - no failed threads in the batch summary
  - `supervisor-state.json` includes this batch in `reviewed_batches`
- **Timeout while still running (wait failure):**
  - `work supervise` exits with timeout/wait failure
  - `work batch-status` remains non-terminal at last persisted state
  - `supervisor-state.json` records a failed stage stop (reason reflects timeout/wait failure)
- **Escalation/contact-user stop (needs operator decision):**
  - batch may still be terminal (`completed`)
  - `supervisor-state.json` adds an `escalations` entry and corresponding `stage_stops` record
  - supervisor waits for operator action before continuing
- **Terminal failed run (batch finished as failed):**
  - `work batch-status` shows `status: "failed"`
  - `supervisor-state.json` records a failed stop; inspect failed thread summaries first

If you're deciding whether it is safe to resume with `work supervise`, use this shortcut:

- Resume normally when batch status is terminal and `reviewed_batches` contains the batch.
- Inspect first (do not blindly resume) when batch status is non-terminal, an escalation was recorded, or batch status is `failed`.

### 3) Resume modes

1. **Continue default progression**
   - run `work supervise`
   - starts from next incomplete batch
2. **Re-run a specific batch after manual fixes/policy adjustments**
   - run `work supervise --batch "SS.BB"`
3. **After stage-boundary stop**
   - review/approve stage outcome
   - run `work supervise` to proceed into next incomplete batch (often next stage)

If you change escalation behavior, edit `work/supervisor.json` and re-run `work supervise`.

## Practical Model for v1

Think of supervisor as an orchestration + policy layer over existing primitives:

- execution primitive: `work multi --headless --async`
- review primitive: deterministic reviewer normalization
- decision primitive: escalation + fix-limit + stage-boundary rules
- persistence primitive: `supervisor-state.json`

It is intentionally simple in v1 so operators can inspect, tune policy, and iterate safely over time.
