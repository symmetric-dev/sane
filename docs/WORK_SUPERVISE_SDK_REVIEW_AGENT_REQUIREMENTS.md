# SDK batch review agent technical requirements

## Status

Technical requirements for a proposed batch-level SDK reviewer. This document
does not authorize implementation and does not change the current
`work supervise` behavior.

The reviewer is a read-only implementation assessor. It produces a report for
the manager agent; it does not run a fix cycle, mutate workstream state, or
replace the manager's review and escalation decisions.

Related references:

- [`WORK_SUPERVISE_SDK_ARCHITECTURE.md`](./WORK_SUPERVISE_SDK_ARCHITECTURE.md)
- [`WORK_SUPERVISE_SDK_IMPLEMENTATION_PLAN.md`](./WORK_SUPERVISE_SDK_IMPLEMENTATION_PLAN.md)
- [`../agent/skills/managing-workstream-implementation/SKILL.md`](../agent/skills/managing-workstream-implementation/SKILL.md)

## Scope

The first version reviews one completed implementation batch:

```text
work supervise --batch "SS.BB"
  -> detached SDK implementation batch
  -> terminal batch state
  -> optional detached SDK batch reviewer
  -> reviewer report and manager handoff
```

The reviewer is batch-level, not a thread assignment. It runs once for an
eligible implementation run and receives the batch's requirements, contracts,
thread work documents, changed implementation, and execution evidence.

The manager remains responsible for:

- deciding whether the report is accepted;
- deciding whether a fix cycle is safe;
- starting or supervising any fix agent;
- producing the final manager report and escalation decision.

## Lifecycle and architecture

### Required lifecycle

The reviewer must start only after the implementation batch reaches a terminal
state and satisfies the configured eligibility policy. The minimum viable policy
is successful completion of every implementation thread.

The implementation executor and reviewer must be separate processes and have
separate ownership metadata. The reviewer must not extend the implementation
executor's heartbeat, PID ownership, cancellation scope, or terminalization
logic.

The preferred shape is:

```text
supervise.ts
  -> waitForBatchStatus(...)
  -> verify review eligibility
  -> launch detached work-sdk batch-review worker
  -> wait for or record review terminal state
  -> return report path and review state to the manager
```

The reviewer must be exposed through a dedicated internal command, such as
`work-sdk batch-review`, so it can be tested, recovered, and observed
independently of the implementation worker. `BatchExecutor.runInternal()` must
not own the reviewer lifecycle.

### Ownership, recovery, and idempotency

Each review run must have:

- a unique `reviewId`;
- a unique owner token, separate from the implementation owner token;
- a PID and heartbeat while running;
- a source implementation `runId` and `batchId`;
- terminal status and error/reason fields;
- an idempotency check for an already completed review of the same source run.

Duplicate review launches for the same source batch run must be rejected or
resolved to the existing active/completed review. A stale reviewer must be
recoverable without changing the implementation batch's terminal result.

Reviewer timeout, cancellation, provider failure, or crash must produce a
review-terminal failure and manager-visible handoff; none may reopen or mutate
implementation thread state.

## Configuration

Reviewer configuration must be separate from per-thread `assignedAgent` values
in `work/agents.yaml`. The proposed shape is:

```yaml
agents:
  - name: code-reviewer
    description: Reviews completed implementation batches.
    best_for: Requirements alignment, implementation review, and reporting.
    models:
      - { model: provider/model, variant: review, runtime: opencode }

execution:
  defaultRuntime: cursor

review:
  enabled: false
  agent: code-reviewer
  when: batch_completed
  runtime: opencode
```

Requirements:

- `review.enabled` defaults to `false` for existing workstreams.
- `review.agent` must reference a declared agent.
- `review.when` must use a closed enum; the initial supported value should be
  `batch_completed`.
- `review.runtime`, when present, must use the existing runtime validation.
- Reviewer model candidates must use the same provider/model validation and
  fallback rules as implementation candidates.
- Reviewer configuration must not alter thread agent assignment or normal
  implementation runtime selection.
- CLI overrides, if added, must be reviewer-specific; `--runtime` for an
  implementation batch must not silently change reviewer configuration.

The configuration parser must preserve compatibility with workstreams that do
not contain a `review` block.

## Review input contract

The reviewer input should be a bounded manifest plus document contents, not an
unbounded dump of the repository.

For batch `SS.BB`, resolve the stage directory using the existing workstream
path helpers and provide:

```text
work/<stream>/README.md
work/<stream>/stages/<stage-dir>/PLAN.md
work/<stream>/stages/<stage-dir>/REQUIREMENTS.md
work/<stream>/stages/<stage-dir>/specs/*       # policy-controlled
work/<stream>/stages/<stage-dir>/threads/<SS.BB.TT>/WORK.md
```

The reviewer must also receive:

- the batch and thread terminal status;
- the configured agent/model/runtime selection;
- the relevant changed-file list and bounded diff;
- focused verification evidence and failure summaries;
- report/artifact paths for deeper evidence when needed.

The manifest must identify each source path, scope, and truncation status. The
reviewer should receive full stage requirements and thread contracts when they
fit the configured budget, while large plans, specs, diffs, and logs must be
bounded deterministically.

Relevant implementation seams include the existing prompt and work-document
helpers, including `prompts.ts`, `thread-workdocs.ts`, and plan/stage path
resolution in `consolidate.ts`.

## Reviewer behavior contract

The reviewer must:

- read the supplied requirements, plans, thread contracts, implementation diff,
  and execution evidence;
- assess alignment, completeness, verification evidence, and contract
  violations;
- write one structured result and one manager-facing Markdown report;
- make no source, plan, state, approval, or thread-status changes;
- launch no fix agent or additional management loop;
- avoid mutating provider sessions or external services.

The provider SDK does not currently provide a hard read-only capability. The
initial implementation therefore requires:

- an explicit read-only prompt contract;
- no AgENV mutation APIs in the reviewer worker;
- a pre-review and post-review Git status/diff check;
- failure/escalation if unexpected source or plan changes are detected.

A future sandbox or provider-level read-only mode may strengthen this contract.

## Report and artifacts

Reviewer artifacts should live under the source implementation run:

```text
work/<stream>/runtime/batches/<batch>/runs/<run>/review/
  reviewer-result.json
  implementation-report.md
  review-activity.jsonl
  review.log
  review-snapshot.json
```

`reviewer-result.json` must use the existing reviewer result normalization
contract where possible (`reviewer/types.ts` and `reviewer/output.ts`). It must
contain at least:

- schema version;
- alignment status and rationale;
- missing outputs;
- issues with severity, evidence, ownership, and suggested action;
- confidence;
- source batch/review identifiers.

`implementation-report.md` must use the manager workflow headings:

```md
## Accomplished
## Issues Found
## Fixes Applied
## What is Next
```

The reviewer must state that no fixes were applied. The existing manager review
state must remain separate from the provider reviewer result.

## Canonical review state

Review lifecycle state must not be stored as a session on an implementation
thread. Add a batch-level review record or `reviewRuns[]` projection with fields
equivalent to:

```text
reviewId
kind: reviewer
status: pending | running | completed | failed | cancelled
sourceBatchId
sourceBatchRunId
ownerToken
pid
attemptId
provider
runtime
model
startedAt
updatedAt
heartbeatAt
completedAt
reportPath
markdownReportPath
summary
error
```

The review record must be observable without changing implementation thread
status, approval state, or manager-side `SupervisorReviewedBatch` decisions.

## Observability and monitor requirements

Reviewer events must be distinguishable from implementation events. Use a
review role/kind and a separate review activity/session path, for example:

```text
review/review-activity.jsonl
review/sessions/<attempt-id>/session.log
```

At minimum record:

- review started/completed/failed/cancelled;
- provider/runtime/model;
- source batch and implementation run;
- report path;
- current heartbeat and terminal summary.

The monitor must show a separate **Batch review** section or badge. Reviewer
state must not appear as an additional implementation thread or be confused
with a thread attempt.

## Compatibility and focused verification

Existing workstreams without reviewer configuration must behave exactly as they
do today. The first implementation requires focused tests for:

1. `agents.yaml` review configuration parsing and validation;
2. completed-batch eligibility and disabled-review behavior;
3. stage/thread document manifest construction;
4. reviewer output normalization and Markdown report creation;
5. one reviewer attempt with a fake provider and no thread-state mutation;
6. duplicate/recovery/timeout handling;
7. supervise integration after terminal batch state;
8. monitor review status and report path projection;
9. unexpected Git changes or malformed reviewer output.

The full workstreams suite is not a requirement for the initial design phase;
focused agent-runnable checks are required before enabling the feature.

## Explicit non-goals

- automatic fix-agent execution;
- updating thread status, approvals, or manager review decisions;
- replacing the manager's review/fix/escalation loop;
- reviewing each thread independently;
- unbounded repository or log ingestion;
- claiming provider-enforced read-only behavior before a sandbox exists.
