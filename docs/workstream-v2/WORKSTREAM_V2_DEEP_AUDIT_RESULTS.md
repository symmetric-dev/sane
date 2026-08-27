# Workstream v2 Deep-Audit Results

## Audit status

The high-level audit was decomposed into **17 bounded, read-only change-impact
audits**, grouped under the five original themes. All 17 slices completed:

- A1–A4: planning paths, parser, planning operations, and approval gates;
- A5–A8: domain types, filesystem storage, SQLite/read models, and lifecycle
  transitions;
- A9–A10: Job Group supervision and provider-neutral runtime;
- A11–A12: generated prompts/tools and global skills/handoffs; and
- A13–A17: public CLI, focused test deltas, and documentation/migration.

A1–A4 were rerun after the audit contract was tightened so that all results use
the same v2-delta format. The audits did not modify repository files, run tests,
change Git state, or implement fixes.

The slice definitions and non-drifting agent contract are documented in
[`WORKSTREAM_V2_DEEP_AUDIT_SLICES.md`](./WORKSTREAM_V2_DEEP_AUDIT_SLICES.md).

## Executive outcome

The current implementation is not incrementally compatible with the v2 model at
its planning, state, approval, or agent-contract boundaries. The provider
execution mechanics are the main reusable subsystem, but they currently sit
behind a Batch/Thread-shaped interface.

The most important result is that the redesign must establish these boundaries
before attempting command or terminology changes:

```text
plan/                         manage/                         work/*
static planning context      static stage execution plan      live operational state
root/stage/phase docs        Jobs, Job Groups, Reports         execution/review/approval
```

The current code frequently crosses those boundaries: planning approval creates
execution state and `WORK.md`; one combined state object contains hierarchy,
execution, approvals, and supervision; prompts give implementation agents state
write instructions; and supervision infers runtime groups from legacy batches.

## Findings by slice

### A1 — Planning path discovery and consolidation

**Result:** Conflicting.

- The loader resolves `work/<stream>/PLAN.md` or
  `work/<stream>/stages/*/PLAN.md`; it never resolves the canonical
  `work/<stream>/plan/` tree.
- It does not discover `SPEC.md`, phase sequence plans, or phase documents.
- It synthesizes stage-local files into a legacy root/Batch/Thread document and
  renumbers included stages, conflicting with stable identifiers and direct
  multi-document planning.

Primary surfaces: `repo.ts`, `stage-directories.ts`, `consolidate.ts`.

### A2 — Planning Markdown parser and domain extraction

**Result:** Conflicting.

- The parser requires one `# Plan` document with nested Stage → Batch → Thread
  headings.
- It has no distinct root, stage, SPEC, phase-sequence, or PHASE document
  domains.
- It has no phase model and treats workforce/execution structure as planning
  data.
- The v2 documents define required responsibilities but not the exact Markdown
  grammar or diagnostic severity; those remain design decisions.

Primary surfaces: `stream-parser.ts`, parser-related definitions in `types.ts`.

### A3 — Planning validation, generation, and editing

**Result:** Conflicting.

- Scaffolding creates `stages/`, `REQUIREMENTS.md`, `specs/`, `threads/`, and
  Batch/Thread templates instead of the `plan/` tree.
- Requirements validation is a separate legacy `REQUIREMENTS.md` workflow rather
  than stage `SPEC.md` requirements.
- Planning validation and editing depend on Batch/Thread/`WORK.md` structures.
- Initial stage scaffolding exists, but later-stage extension is blocked by the
  current refusal to scaffold an existing stage tree.

Primary surfaces: `generate.ts`, `requirements.ts`, `plan-edit.ts`,
`work-validation.ts`, `cli/plan.ts`, `cli/validate.ts`.

### A4 — Approval commands and revision side effects

**Result:** Conflicting.

- Current approval supports `plan` and `revision`; management and implementation
  gates do not exist, and `stage` is a legacy alias.
- Root plan approval persists approval, initializes execution state, and creates
  thread `WORK.md` files.
- Stage approval checks thread completion and may commit or mutate GitHub state.
- Revision approval refreshes execution state and workdocs without a v2 approval
  record.
- Current approval state is stream/stage-level rather than per-Job and lacks the
  v2 execution/review/approval predicate.

Primary surfaces: `cli/approve/*`, `approval.ts`, `approval-append.ts`, approval
Git/GitHub callers.

### A5 — Domain types and identifier inventory

**Result:** Conflicting.

- `StageDefinition` contains `BatchDefinition[]`, which contains
  `ThreadDefinition[]`.
- Canonical IDs encode stage/batch/thread/item segments.
- One `ExecutionStatus` union combines execution, blocked, and cancellation
  concepts.
- There are no canonical Phase, Job Group, Job, or per-Job report/state types.
- Existing batch/thread runtime types can be retained only behind an adapter if
  that remains the chosen compatibility boundary.

Primary surfaces: relevant `types.ts` definitions, `model.ts`,
`multi-types.ts`, `stage-id.ts`, `execution-ids.ts`, `runtime-state.ts`.

### A6 — Filesystem state and storage adapters

**Result:** Conflicting.

- `work/<stream>` discovery uses broad artifact markers and stores one combined
  `workstream-state.json` containing hierarchy, approvals, runtime, and
  supervision data.
- Static artifacts and live state share the same broad boundary and mutation
  surface.
- Atomic file replacement exists, but read-modify-write, index updates, and
  SQLite mirroring do not form one explicit lock/transaction boundary.
- Async and synchronous paths do not consistently express one state authority.

Primary surfaces: `structured-storage.ts`, `storage-adapter.ts`,
`sqlite-storage-adapter.ts`, `files.ts`, `tree.ts`, `repo.ts`.

### A7 — SQLite persistence and read models

**Result:** Conflicting.

- Tables and queries encode stages, batches, threads, execution items, batch
  runs, and one status field.
- Approval is stream/stage-level; Job-level review, approval, and rejection
  reason do not exist.
- Read models collapse item status into thread aggregate status and dashboards
  correlate by stage/batch/thread.
- The current observability separation is reusable, but it must not become the
  source of Job state.

Primary surfaces: `sqlite-storage.ts`, `hierarchy-query.ts`,
`workspace-read-model.ts`, dashboard contract/observability modules.

### A8 — State mutation, lifecycle transitions, and reset behavior

**Result:** Conflicting.

- Current mutation APIs accept caller-supplied thread status and reconcile batch
  aggregates.
- Finalization produces completed/failed/interrupted outcomes, not
  executed/aborted Job execution state.
- Batch reset returns all thread statuses to `pending`, clears evidence, and
  deletes artifacts; v2 retry requires `aborted → in_progress` without returning
  to `pending`.
- No selected transition separates execution, review, and approval authority.

Primary surfaces: `execution-state.ts`, `thread-execution.ts`, `update.ts`,
`batch-status.ts`, `reset-batch-state.ts`, `multi-finalization.ts`.

### A9 — Supervision and Job Group scheduling

**Result:** Partial/conflicting.

- Supervision selects an explicit or resumable batch, or the first incomplete
  hierarchy batch; it does not read a static `EXECUTION-PLAN.md`.
- A current batch is the closest Job Group boundary, and its threads run
  concurrently without plan-defined dependency readiness.
- The runtime control flow can support a Job Group adapter, but exact membership,
  assignment, dependencies, and order must come from management artifacts.

Primary surfaces: `cli/supervise.ts`, `multi-orchestrator.ts`,
`supervision-helper.ts`, `supervisor-state.ts`, `batch-monitor.ts`.

### A10 — Agent runtime execution and providers

**Result:** Mostly reusable behind an adapter.

- Provider-neutral attempt lifecycle, normalized events, cancellation, heartbeat,
  cleanup, retry candidates, and observability are reusable.
- Attempt inputs and executor results remain Batch/Thread-shaped and do not carry
  `JOB.md`/`REPORT.md` paths.
- Provider and process outcomes need translation to Job `executed`/`aborted`
  without making providers Job-aware.

Primary surfaces: `agent-runtime/contracts.ts`, `batch-executor.ts`,
`execute.ts`, provider adapters, and runtime tests.

### A11 — Prompt assembly and workstream tool contract

**Result:** Conflicting.

- Prompt context requires thread `WORK.md` and stage `REQUIREMENTS.md`.
- Generated instructions tell agents to use `work update` and thread-scoped
  commands.
- Prompt JSON has no Job/report paths, and `link_thread_session` can mutate
  thread runtime metadata.

Primary surfaces: `prompts.ts`, `prompt-paths.ts`, `cli/prompt.ts`,
`agent/tools/workstream.ts`.

### A12 — Global skills and manual handoff contract

**Result:** Conflicting.

- Implementation skill requires `WORK.md`, session linking, and `work update`.
- Management/review/evaluation skills remain Batch/Thread-oriented and describe
  automatic fix cycles.
- Commands instruct agents to launch review/evaluation subagents, conflicting
  with manual top-level agent invocation.
- The v2 Job/report contract and Stage Manager/user ownership must replace these
  instructions.

Primary surfaces: listed workflow skills and `agent/commands/work:*.md`.

### A13 — Public CLI dispatch, help, and exports

**Result:** Partial/conflicting.

- Parent dispatch forwards arguments but does not expose the exact four approval
  forms or canonical `--job-group` vocabulary.
- Help still describes revisions, batches, and legacy surfaces.
- SDK tests and public exports remain batch-oriented.
- `--batch` may remain only as an explicit compatibility alias.

Primary surfaces: `bin/work.ts`, `bin/work-sdk.ts`, `src/index.ts`, `help.ts`,
`roles.ts`, CLI/help/SDK tests.

### A14 — Planning and approval test delta

**Result:** Conflicting test contract.

- Helpers and fixtures create root `PLAN.md` with Batch/Thread content.
- Generation tests expect `stages/`, `REQUIREMENTS.md`, `specs/`, `threads/`,
  and legacy workdocs.
- No focused test covers the four exact approval commands, no-Git/state-only
  approval, or progressive stage/phase planning.

Primary surfaces: planning fixtures, `plan.test.ts`, `generate.test.ts`,
`draft_plan_semantics.test.ts`, approval role/name tests.

### A15 — State and storage test delta

**Result:** Conflicting test contract.

- Tests round-trip one status through Stage/Batch/Thread and SQLite.
- No test persists independent Job execution/review/approval fields or rejection
  reason.
- No test proves static plan/manage artifacts remain unchanged during live-state
  mutation or reset.

Primary surfaces: state/storage/dashboard tests and workspace helpers.

### A16 — Runtime and prompt test delta

**Result:** Conflicting test contract.

- Runtime fixtures and assertions use Batch/Thread, `WORK.md`, and `work update`.
- Existing tests cover reusable provider mechanics, heartbeat, cancellation, and
  observability, but not Job/report paths or execution-only state authority.
- No report-driven review/approval handoff is asserted.

Primary surfaces: runtime/supervision/prompt tests and fake runtime fixture.

### A17 — Documentation, templates, and clean-break migration

**Result:** Conflicting user-facing guidance.

- Root/package READMEs and legacy docs describe stages/batches/threads,
  `WORK.md`, `/fork`, and stage approval.
- The staged-workstream template presents `WORK.md` as canonical.
- Reporting docs do not distinguish per-Job reports from a stream-level report.
- The pilot migration path is not identified; the v2 docs establish manual
  migration but do not record the pilot's current source/status.

Primary surfaces: root/package READMEs, `docs/WORKSTREAM.md`, staged-workstream
docs/template, supervisor/legacy docs, and v2 reference docs.

## Cross-cutting conclusions

### 1. Establish artifact ownership before adapting runtime

The first implementation boundary must distinguish:

- planning files under `plan/`;
- workstream-specific management files under `manage/`; and
- live operational state under `work/*`.

The current loader, storage adapter, approval flow, and prompt builder all blur
these boundaries. Runtime changes should not begin by merely renaming Batch and
Thread.

### 2. Planning approval must become side-effect free

`work approve plan --root` and `work approve plan --stage N` should validate and
record planning approval only. They must not initialize execution state, create
Jobs/Job Groups, generate `WORK.md`, run agents, modify documents, or invoke Git
and GitHub behavior by default.

### 3. The live state model needs independent axes

The state and storage layers must represent Job execution, review, and approval
independently. Batch/thread aggregate status, process outcome, Job report text,
and user approval cannot be collapsed into one status field.

### 4. Runtime mechanics should be adapted, not rewritten wholesale

Provider adapters, attempt lifecycle, heartbeat, cancellation, retry candidates,
cleanup, journals, snapshots, and observability are reusable. The new boundary
should translate management Jobs into the existing execution adapter while
keeping Batch/Thread names internal where possible.

### 5. Agent authority must be removed from prompts and skills

The implementation contract becomes `JOB.md` plus a mirrored `REPORT.md`. The
agent writes implementation output and the report. Execution tooling owns
mechanical state; the Stage Manager owns review; the user owns approval. Legacy
`WORK.md`, `work update`, `link_thread_session`, and automatic fix/handoff
instructions must not survive in the v2 contract.

## Settled invariants confirmed by the audits

- The v2 change is a clean break; legacy layout compatibility is not required.
- `plan/` contains no batches, threads, Jobs, Job Groups, assignments, execution
  status, or `WORK.md`.
- Stage and Phase identifiers are numeric and stable.
- Job Groups are sections in `EXECUTION-PLAN.md`, not separate files.
- Phase-to-Job mapping is many-to-many.
- Management approval precedes implementation Job Group execution.
- Implementation approval requires every Job to be `executed` and `approved` or
  `rejected`; review state does not block the gate.
- Approval/revocation is user-controlled, state-only, and does not start agents
  or perform Git operations by default.
- Top-level planner and manager agents are selected and handed off manually.
- Provider-neutral execution mechanics may remain behind a Job Group/Job
  adapter.

## Cross-cutting design decisions still required

These are the decisions that must be settled before implementation phases can be
written precisely:

1. **Planning grammar:** exact headings/field delimiters, required versus
   optional fields, and parse-error severity for root/stage/SPEC/phase docs.
2. **Planning loader contract:** return shape/provenance for the five document
   roles, partial-stage handling, and treatment of old layouts during the clean
   break.
3. **Type and identifier boundary:** canonical Phase/Job Group/Job IDs and
   whether legacy Batch/Thread types remain internal adapters or disappear from
   public exports.
4. **Live-state persistence:** static management-catalog representation versus
   live state, SQLite linkage, lock scope, mirror authority, and Job Group
   aggregation.
5. **Approval records:** scope and storage of root/stage/management/
   implementation approvals, revocation behavior, plan-hash auto-revocation,
   and validation/`--force` semantics.
6. **Execution readiness:** how `EXECUTION-PLAN.md` dependencies and Job Group
   readiness are resolved, and how current batch/thread identities map to Jobs.
7. **Job/report handoff:** exact prompt/attempt representation of `JOB.md` and
   `REPORT.md`, report validation, and role-specific tool exposure.
8. **Failure/reset semantics:** mapping cancellation, failure, interruption,
   reset, and retry to `aborted` and `aborted → in_progress`.
9. **CLI compatibility:** whether `--batch` remains an alias and which legacy
   commands/Batch-named exports are removed versus kept internally.
10. **Pilot migration/document status:** identify the pilot, define its manual
    re-expression into `plan/`, and decide whether old guidance is archived,
    rewritten, or explicitly historical.

## Recommended implementation dependency order

This is a dependency order for future planning, not an implementation plan:

1. Settle the planning grammar, path loader, planning domain types, and
   planning-only validation/generation boundary.
2. Settle the live Job/Job Group state model, filesystem authority, SQLite/read
   model projection, and approval records.
3. Adapt supervision and the runtime adapter to consume management Job Groups
   and exact Job membership/dependencies.
4. Replace prompt/tool contracts and global skills with Job/report and manual
   handoff rules.
5. Replace CLI/help/exports, migrate focused tests/fixtures, update docs, and
   perform the manual pilot migration.

No implementation should begin until the decisions that define its input/output
contracts are recorded in the relevant v2 planning documents.
