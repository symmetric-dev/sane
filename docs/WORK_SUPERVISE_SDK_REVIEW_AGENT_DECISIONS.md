# SDK batch review agent decisions

## Status

Open decisions required before implementing the batch-level SDK reviewer. The
technical requirements are in
[`WORK_SUPERVISE_SDK_REVIEW_AGENT_REQUIREMENTS.md`](./WORK_SUPERVISE_SDK_REVIEW_AGENT_REQUIREMENTS.md).

The reviewer is intended to produce evidence for the manager agent. It does not
run fixes or replace the manager workflow defined in
[`../agent/skills/managing-workstream-implementation/SKILL.md`](../agent/skills/managing-workstream-implementation/SKILL.md).

## 1. Eligibility policy

### Question

Should the reviewer run only when every implementation thread completed, or on
any terminal batch including failures and cancellations?

### Recommended default

Start with:

```text
when: batch_completed
```

This keeps the first reviewer focused on implementation alignment after a
successful batch. Failed and cancelled batches should return directly to the
manager with their existing failure evidence. A later diagnostic-review mode
can support `batch_terminal`.

## 2. Synchronous versus asynchronous review

### Question

Should `work supervise` wait for the reviewer report before handing control back,
or launch it and return with `reviewStatus: running`?

### Recommended default

Await one bounded reviewer attempt in the first version. This gives the manager
a deterministic report path and avoids requiring a second command to discover
whether the review started. The reviewer must have its own timeout and terminal
state so it cannot make implementation supervision appear active indefinitely.

An asynchronous mode can be added later after recovery and monitor behavior are
well established.

## 3. Diff scope

### Question

What implementation should the reviewer compare: the batch, the stage, or the
entire workstream branch?

### Recommended default

Use the batch-scoped changed-file/diff set, supplemented by the stage contract.
The reviewer should not judge unrelated prior work in the branch. Include the
stage requirements and plan context needed to understand cross-thread contracts.

## 4. Documentation bounds

### Question

Should stage specs and large plans be included in full?

### Recommended default

- Include the full stage `REQUIREMENTS.md`.
- Include the full `WORK.md` for each thread in the batch when within budget.
- Include the relevant batch section of `PLAN.md`.
- Include the root workstream README summary.
- Include `specs/*` only when referenced by the stage or thread contract.
- Truncate oversized files deterministically and record truncation in the
  manifest.

## 5. Read-only enforcement

### Question

How strongly must the first reviewer prevent file changes?

### Recommended default

Use layered safeguards for the MVP:

1. Explicit prompt and tool instructions to read only.
2. Do not expose AgENV mutation APIs to the reviewer worker.
3. Capture Git status/diff before and after review.
4. Escalate if unexpected files change.

Do not claim this is provider-enforced isolation. A sandbox or provider-level
read-only mode should be a later hardening feature.

## 6. Reviewer configuration and precedence

### Question

How should reviewer agent, runtime, and model overrides be selected?

### Recommended default

Use a top-level `review` block:

```yaml
review:
  enabled: false
  agent: code-reviewer
  when: batch_completed
  runtime: opencode
```

The reviewer agent's model list supplies candidates. If a reviewer-specific
runtime is present, it wins; otherwise the model declaration wins, then the
configured runtime default. Do not let an implementation `--runtime` silently
override reviewer selection. If CLI overrides are added, use explicit flags
such as `--review-runtime` and `--review-timeout-ms`.

## 7. Report format

### Question

Should the reviewer write only structured JSON, only Markdown, or both?

### Recommended default

Write both:

- `reviewer-result.json` for machine state and monitor/API use;
- `implementation-report.md` for direct manager handoff.

The Markdown report should use:

```md
## Accomplished
## Issues Found
## Fixes Applied
## What is Next
```

`Fixes Applied` should explicitly say `None` for a reviewer-only run.

## 8. Review retry and idempotency

### Question

What happens when a review times out, crashes, or the manager reruns
`work supervise`?

### Recommended default

Key review identity by `(sourceBatchId, sourceBatchRunId, review pass)`. A
completed review for the same implementation run should be reused rather than
duplicated. A failed or stale review may be retried with a new `reviewId` and
attempt, while preserving the previous report and failure evidence.

## 9. Review result and manager handoff

### Question

Should `work supervise` interpret the review result or only return its path?

### Recommended default

Return structured review status, report paths, and a concise summary. Do not
automatically update manager review state, thread status, approvals, or
escalations. The manager reads the report and applies the existing fix/report
policy.

## 10. Monitor presentation

### Question

How should reviewer activity appear alongside implementation threads?

### Recommended default

Show a separate **Batch review** panel with:

- reviewer status;
- provider/runtime/model;
- latest activity/heartbeat;
- report path;
- issue/alignment summary.

Do not insert the reviewer into the thread list or represent it as a worker
thread session.

## 11. Approval interaction

### Question

Does review require an additional approval check beyond the implementation batch
gate?

### Recommended default

No new approval mutation or thread-status rule. The implementation batch already
passes the previous-stage approval gate before launch. Review is a post-batch
assessment and must not alter approval state. Thread status updates remain
independent of approval as currently intended.

## 12. Minimum decision set before implementation

Implementation should not start until these are confirmed:

1. `batch_completed` eligibility only;
2. synchronous, bounded reviewer execution;
3. batch-scoped diff plus stage contract context;
4. bounded documentation manifest with referenced specs;
5. prompt plus post-review Git-diff safeguards;
6. top-level `review` configuration with default disabled;
7. JSON plus Markdown reports;
8. idempotent reuse of completed reviews and retry of failed/stale reviews;
9. separate Batch review monitor presentation.
