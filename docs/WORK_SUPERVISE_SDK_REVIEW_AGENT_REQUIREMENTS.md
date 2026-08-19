# Thin SDK batch-review agent design

## Status

Design direction confirmed. This document describes the intentionally small
review layer; it does not authorize automatic fixes or manager-side decisions.

The reviewer is a heuristic completion check that runs after a successful SDK
implementation batch. It returns plain text to the caller of `work supervise`.
It is not a second implementation workflow, a policy engine, or a structured
quality-assurance pipeline.

## Goal and scope

For a batch such as `SS.BB`:

```text
work supervise --batch "SS.BB"
  -> implementation batch
  -> completed batch only
  -> optional reviewer agent call
  -> plain-text review output
  -> normal supervise handoff
```

Review is disabled by default so existing workstreams behave unchanged. When
enabled, `work supervise` blocks until the reviewer call finishes or reaches its
review timeout.

The reviewer must not:

- run a fix agent;
- update implementation, plan, approval, thread, or manager-review state;
- make decisions for the manager or calling agent;
- be assigned to an implementation thread;
- require or produce structured review data.

## Eligibility and failure behavior

- Run only when the implementation batch status is exactly `completed`.
- Do not run for failed, cancelled, or otherwise incomplete batches.
- Use a default ten-minute wall-clock review timeout.
- Retry launch failures at most two times with back-off.
- Provider startup, timeout, or exhausted launch failures leave the batch result
  unchanged and produce a warning only.
- Warning text must describe the review failure without prescribing a next step.
  Workflow guidance belongs in the reviewing skill, not in the warning.

The review timeout is an AgENV-level bound. Current provider adapters expose
optional adapter-level timeouts, but do not expose a separate native ten-minute
review timeout. Provider cancellation and cleanup must remain bounded
independently.

## Reviewer input

The reviewer receives only:

- the repository working directory;
- the current workstream identifier;
- the current batch identifier and basic run context;
- the batch-review skill/prompt contract.

AgENV must not construct or inject a document manifest, file contents, bounded
diff, execution evidence bundle, structured requirements payload, or repository
dump. The reviewer can inspect the current workstream and batch itself through
its normal read-only-oriented agent interaction.

The reviewer is instructed not to modify files. This is a heuristic contract,
not a provider-enforced sandbox or a guarantee of immutability.

## Agent and model selection

Reviewer selection belongs only to `work/agents.yaml`. A reviewer is never
selected from thread `assignedAgent` values.

When a reviewer agent/model is configured, use the same model resolution,
provider selection, and candidate fallback behavior used by regular agents.
When no reviewer model is configured but review is enabled, the default model is
`auto@cursor`.

The resolved provider, runtime, model, variant, and selection source must be
visible in reviewer lifecycle logs and monitor output.

Review configuration is disabled by default and must not affect normal thread
assignment or implementation runtime selection.

## Execution boundary

The reviewer should use a dedicated internal SDK call/worker boundary rather
than `BatchExecutor.runInternal()` owning reviewer lifecycle. The reviewer is
not an implementation thread and must have separate lifecycle metadata.

The implementation may reuse provider adapters and model-resolution helpers, but
must not reuse thread-oriented batch execution in a way that mutates thread
state or invents an implementation assignment.

## Output

The reviewer returns one unconstrained plain-text report. There is no required
heading, JSON schema, alignment enum, issue severity, missing-output list,
confidence field, suggested-action field, or output normalization.

`work supervise` exposes the returned text directly to its caller. No reviewer
report file is created.

## Persistence and observability

Only minimal reviewer lifecycle metadata is persisted under the existing
workstream state:

```text
reviewId
sourceBatchId
sourceBatchRunId
status: pending | running | completed | failed | cancelled
attempt count
provider
runtime
model
variant
startedAt
updatedAt
completedAt
heartbeat/owner metadata while running
error, when applicable
```

The current file-level batch state is:

```text
work/<stream-id>/workstream-state.json
```

Batch runs are stored in its `batchRuns[]` data. The existing structured-storage
mirror also uses `work/db.sqlite` (`batch_runs` and `batch_run_threads`). Review
metadata must use that existing persistence boundary and must remain separate
from manager-side `supervision.reviewed_batches` decisions.

Reviewer status must appear in existing monitoring and logging as a distinct
**Batch review** section/state, not as another implementation thread. Monitoring
must show lifecycle status and resolved model information, but does not need
structured issue or alignment summaries.

No review-specific report, activity, snapshot, or log files are required.

## Compatibility and focused verification

Existing workstreams without review configuration must behave exactly as today.
Focused verification should cover:

1. review-disabled behavior;
2. completed-batch-only eligibility;
3. reviewer model resolution and `auto@cursor` fallback;
4. synchronous waiting and the ten-minute timeout boundary;
5. two launch retries with back-off;
6. plain-text output propagation to `work supervise`;
7. warning-only review failures with no remediation instructions;
8. no thread, approval, implementation, or manager-review mutations;
9. lifecycle metadata and monitoring/logging projection.

## Explicit non-goals

- structured reviewer results;
- JSON or Markdown report artifacts;
- direct document, diff, or evidence manifests;
- automatic fixes;
- manager approval or escalation decisions;
- thread-level reviewer assignments;
- provider-enforced read-only isolation;
- reviewer interpretation of its own report by `work supervise`.
