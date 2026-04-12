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
3. Wait for persisted batch status (`batch-status.json`) to reach a terminal state.
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

Supervisor stops when any of the following happens:

- escalation requires user input,
- stage boundary stop/contact-user condition is hit,
- there is no next batch to run,
- or an execution/wait error occurs (including timeout while still non-terminal, recorded as failed stop).

Timeout semantics in v1 are strict:

- `waitForBatchStatus()` only returns when the batch reaches a terminal state (`completed` or `failed`)
- if `--timeout-ms` elapses first, the wait fails with the latest persisted non-terminal state left in `batch-status.json`
- `work supervise` treats that timeout as a run failure and skips review/fix follow-up for the incomplete batch

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

## Operator Guidance: Resume After Escalation or Stage Completion

When supervisor stops, first inspect:

- terminal summary from `work supervise`
- `work/<stream-id>/supervisor-state.json` (`stage_stops`, `escalations`, `reviewed_batches`)
- `work status` and `work list --tasks --batch "SS.BB"`

Then choose a resume mode:

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
