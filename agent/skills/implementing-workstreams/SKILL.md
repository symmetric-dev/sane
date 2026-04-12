---
name: implementing-workstreams
description: Execute tasks for an existing workstream and keep task state accurate.
---

# Implementing Workstreams

## Start Here

```bash
work status
work tree --batch "01.01"
work list --tasks --thread "01.01.01"
```

## Execution Rules

1. Work only on your assigned thread.
2. Mark task start: `work update --task "ID" --status in_progress`
3. Mark completion with report:
   `work update --task "ID" --status completed --report "1-2 sentence summary"`
4. If blocked:
   `work update --task "ID" --status blocked --report "reason and dependency"`

## Questions

- Do not ask questions to the user during implementation.
- If a task or plan is unclear, mark the task as blocked:
  `work update --task "ID" --status blocked --report "unclear: <specific question>"`
- Describe the exact ambiguity so it can be resolved during review.

## Report Quality

- Mention concrete files or modules changed.
- Include notable decisions or deviations.
- Keep it short and factual.

## Recovery

- If work is already done but status is stale, update status and add report.
- If task intent is unclear, review:
  - `work validate requirements`
  - `work review plan`
  - `work read --task "ID"`

## Root Agent Branch Supervision Runbook

When implementing tasks that involve branch supervision, treat `work supervise` as an execution/recovery primitive and keep policy decisions at the Root Agent layer.

### 1) Launch a branch supervision run

Use long-running defaults unless the task explicitly asks for interruption testing:

```bash
work supervise --batch "SS.BB" --poll-interval-ms 1000 --timeout-ms 1200000
```

### 2) Read branch review outputs from persisted state

```bash
work batch-status --batch "SS.BB" --format json
cat work/<stream-id>/supervisor-state.json
work tree --batch "SS.BB"
```

Prioritize these fields for Root Agent decisions:
- `batch-status/*.json`: terminal vs non-terminal batch outcome
- `reviewed_batches`: whether review completed for the batch
- `fix_cycles`: whether an automatic retry was already consumed
- `escalations` + `stage_stops`: whether Root Agent escalation/user contact is required

### 3) Decide fix-cycle vs user escalation

- If batch is terminal and review is approved with no escalation trigger: continue to next incomplete batch.
- If review requests changes and fix budget allows: run one fix cycle, then re-check persisted state.
- If escalation exists (or fix budget is exhausted): escalate to the Root Agent (you), then escalate to the user with concrete evidence and next-step options.

Policy statement: branch runs escalate to the Root Agent; the Root Agent escalates to the user.

### 4) Resume interrupted runs

For timeout/non-terminal interruptions:
1. Confirm non-terminal persisted state (`work batch-status ...`).
2. Resume with plain `work supervise` (no `--batch`) so the interrupted batch is preferred.
3. Verify resumed batch reaches reviewed/finalized evidence before later batches progress.
