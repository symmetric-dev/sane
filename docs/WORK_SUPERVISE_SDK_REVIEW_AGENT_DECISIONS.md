# Thin SDK batch-review agent decisions

## Confirmed direction

The proposed reviewer is intentionally a thin heuristic completion layer. It
does not implement a structured review protocol.

### 1. Eligibility

Review only batches whose implementation status is exactly `completed`.
Failed, cancelled, and incomplete batches do not trigger review.

### 2. Synchronous execution

`work supervise` blocks until the reviewer completes, times out, or exhausts
its launch retries. There is no asynchronous `reviewStatus: running` handoff in
the first version.

### 3. Input boundary

Pass only the repository context, current workstream, current batch/basic run
information, and the batch-review skill. Do not pre-load or inject files,
requirements, plans, thread contracts, diffs, logs, or execution evidence.

### 4. Reviewer behavior

The reviewer is asked not to make changes and is used heuristically. This is a
prompt/tooling convention, not a provider-enforced read-only guarantee.

The reviewer does not run fixes, mutate state, update approvals, or make
manager-side decisions.

### 5. Configuration and model selection

Review is disabled by default. Reviewer configuration belongs in
`work/agents.yaml`, never in thread assignments. Regular agent model/provider
resolution and fallback logic should be reused. If review is enabled without a
configured reviewer model, use `auto@cursor`.

The resolved provider, runtime, model, and variant must be visible in logs and
monitoring.

### 6. Timeout and retries

Use a default ten-minute AgENV-level review timeout. Retry launch failures twice
with back-off. Review failure is non-fatal: preserve the completed batch result
and print a warning only.

Warnings must not contain instructions such as “run a review yourself.” Such
guidance belongs in the relevant skill.

### 7. Output

The reviewer produces unconstrained plain text. `work supervise` exposes that
text directly to the calling agent/user. No JSON schema, Markdown template,
alignment status, issue taxonomy, or output parser is needed.

### 8. Persistence

Do not create reviewer report or activity files. Persist only minimal lifecycle
and model metadata through the existing workstream state:

```text
work/<stream-id>/workstream-state.json
```

The existing SQLite mirror under `work/db.sqlite` remains part of the current
structured-storage boundary. Reviewer lifecycle data remains separate from
manager-side `supervision.reviewed_batches`.

### 9. Monitoring

Include reviewer lifecycle and model information in existing monitoring and
logging as a distinct **Batch review** state. Do not represent it as an
implementation thread and do not require structured issue summaries.

### 10. Default rollout

Start with review disabled. Implement and test locally, then enable it
gradually on real workstreams during general development.

## Cleanup before implementation

The old structured reviewer layer is noise for this design and should be
removed before adding the thin call path:

```text
packages/workstreams/src/lib/reviewer/types.ts
packages/workstreams/src/lib/reviewer/output.ts
packages/workstreams/src/lib/reviewer/index.ts
packages/workstreams/src/lib/supervisor/review.ts
packages/workstreams/src/lib/supervisor/index.ts
packages/workstreams/tests/reviewer-output.test.ts
```

Remove their package exports and tests. Keep provider adapters, model
resolution, batch-status persistence, existing manager supervision state, and
the unrelated `work review` command.

## Questions remaining before thin-layer implementation

1. What exact `review:` shape should be added to `work/agents.yaml`?
2. Should the plain-text report be persisted as a string in metadata, or only
   returned through the `work supervise` process output?
3. Should best-effort Git-change detection be omitted, or emit only a warning?
4. What back-off intervals should the two launch retries use?
5. Should completed review text be reused on repeated supervision of the same
   implementation run?
