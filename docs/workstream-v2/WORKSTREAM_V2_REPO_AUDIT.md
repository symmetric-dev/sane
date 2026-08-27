# Workstream v2 Repository Audit

## Audit status

This document records the first high-level, read-only audit of the current
AgENV implementation for the workstream v2 redesign.

- No workstream was created or used for this audit.
- No repository files were modified by the audit subagent.
- No tests, builds, or typechecks were run as part of the audit.
- This document is an architectural inventory and change map, not an
  implementation plan.

## Executive summary

The current implementation is coherent, but its core domain model is tightly
coupled to:

```text
Stage -> Batch -> Thread
```

Plan approval parses stage planning documents, initializes execution state, and
generates per-thread `WORK.md` contracts. Runtime execution, supervision,
prompts, agent skills, dashboards, tests, and SQLite storage all depend on that
hierarchy.

The v2 redesign is therefore not only a filesystem migration. It changes the
planning model, management model, agent contract, approval lifecycle, runtime
state model, and execution vocabulary:

```text
plan/                        manage/
  workstream plan              Stage Execution Plan
  stages                       Jobs
    stage plans/specs          Job Groups
    phase sequence             Job Reports
    phase designs              execution/review/approval state
```

The existing provider execution and supervision infrastructure is reusable, but
it must be placed behind the new Job Group and Job concepts rather than
assuming batches and threads are the primary domain model.

## Current architecture

The main package is `@agenv/workstreams` in `packages/workstreams/`. Its
current package surface includes the `work` and `work-sdk` binaries, library
exports, CLI commands, runtime execution, persistence, and supervision.

Important current flow:

1. `loadWorkstreamPlan()` in `packages/workstreams/src/lib/consolidate.ts`
   loads and consolidates staged planning documents.
2. `parseStreamDocument()` in `packages/workstreams/src/lib/stream-parser.ts`
   parses the current planning syntax.
3. Plan approval initializes canonical execution state through
   `initializeCanonicalExecutionStateFromPlan()`.
4. `ensureThreadWorkDocsForPlan()` generates per-thread `WORK.md` contracts.
5. `getPromptContext()` and prompt-generation code prepare implementation-agent
   context.
6. `multi-orchestrator.ts`, `supervision-helper.ts`, and
   `agent-runtime/batch-executor.ts` execute and supervise batches of threads.
7. Structured filesystem/SQLite state persists stages, batches, threads,
   execution items, approvals, batch runs, and supervision records.

## Current workstream assumptions

The current workstream filesystem is based on:

```text
work/<stream>/
├── README.md
├── resources/
├── docs/
├── stages/
│   └── <stage>/
│       ├── REQUIREMENTS.md
│       ├── PLAN.md
│       └── threads/
│           └── <thread-id>/
│               └── WORK.md
├── REPORT.md
└── workstream-state.json
```

The current lifecycle assumes:

- stage plans encode batch/thread structure;
- plan or revision approval initializes execution hierarchy;
- approval creates or preserves per-thread `WORK.md` files;
- implementation agents read `WORK.md` and stage requirements;
- implementation agents use CLI commands such as `work update` to update
  thread state;
- `work supervise` operates on batches and executes their threads in parallel;
- the manager/supervisor reviews persisted thread and batch state; and
- reports are primarily stream-level evaluation artifacts rather than per-job
  implementation reports.

## Target v2 change domains

### 1. Planning artifacts

The parser, planner, generator, validator, revision flow, and planning approval
logic must understand:

```text
plan/PLAN.md
plan/stages/<stage>/PLAN.md
plan/stages/<stage>/SPEC.md
plan/stages/<stage>/phases/PLAN.md
plan/stages/<stage>/phases/<phase>.PHASE.md
```

Planning approval must not generate implementation Jobs, Job Groups, or agent
contracts. Stage planning and management planning become separate concerns.

### 2. Management artifacts

The Stage Manager will create workstream-specific artifacts under:

```text
manage/stages/<stage>/EXECUTION-PLAN.md
manage/stages/<stage>/jobs/<job>.JOB.md
manage/stages/<stage>/reports/<job>.REPORT.md
```

Job files are numbered within a stage, independently of Job Group membership.
Job Groups are sections in `EXECUTION-PLAN.md`; they do not have separate
files. The execution plan records phase-to-Job coverage, Job Group membership,
dependencies, assigned agents, and execution order.

Phase-to-Job mapping is many-to-many. A phase may produce multiple Jobs, and a
Job may cover multiple phases.

### 3. Agent contract and prompting

Implementation agents will receive:

- the path to their `JOB.md`;
- the path to their `REPORT.md`; and
- globally supplied skill/harness instructions for locating the current stage's
  planning documents.

They will not receive a requirement to update workstream state through the
CLI. They write implementation changes and the Job report. The Stage Manager
and execution tooling own state updates.

The current prompt and skill system assumes `WORK.md`, stage
`REQUIREMENTS.md`, and thread-oriented commands, so this is a distinct
integration domain.

### 4. Approval lifecycle

The future approval paths are:

```bash
work approve plan --root
work approve plan --stage N
work approve management --stage N
work approve implementation --stage N
```

The former `work approve stage N` command is replaced by
`work approve implementation --stage N`. Approval commands update relevant
`work/*` state only by default and should not execute Git commands during the
transition.

### 5. Separate execution, review, and approval state

Each Job needs independent state fields:

```text
execution_state: pending | in_progress | executed | aborted
review_state:    null | completed | incomplete
approval_state:  null | approved | rejected
rejected_reason: required for rejected Jobs
```

`work supervise` starts a Job Group and automatically marks its Jobs
`in_progress`. Normal process completion produces `executed`; an execution
failure produces `aborted`. The Stage Manager sets review state. The user is
informed and ultimately establishes approval state.

Implementation approval can pass only when every Job has
`execution_state: executed` and `approval_state: approved | rejected`.
Review state does not block approval state.

### 6. Runtime and supervision vocabulary

The existing execution adapter currently maps:

```text
Job Group -> Batch
Job       -> Thread
```

`work supervise --batch` may remain as an alias, while `--job-group` becomes
the intended future terminology. The runtime must stop treating Batch and
Thread as the user-facing planning model while preserving reusable provider,
parallel execution, heartbeat, cancellation, retry, and observability
infrastructure where appropriate.

### 7. State ownership and reporting

The current implementation-agent state-update contract must be removed. The
execution tool will own mechanical transitions; the Stage Manager will own
review and normal approval transitions; users may use the CLI directly to
close gaps.

The current stream-level `REPORT.md` concept must be distinguished from
per-Job reports with the sections:

- `Accomplished`;
- `Found issues`; and
- optional `Notes`.

## Major implementation surfaces

### Planning and approval

- `packages/workstreams/src/lib/consolidate.ts`
- `packages/workstreams/src/lib/stream-parser.ts`
- `packages/workstreams/src/lib/stage-directories.ts`
- `packages/workstreams/src/lib/requirements.ts`
- `packages/workstreams/src/lib/generate.ts`
- `packages/workstreams/src/lib/plan-edit.ts`
- `packages/workstreams/src/lib/thread-workdocs.ts`
- `packages/workstreams/src/lib/work-validation.ts`
- `packages/workstreams/src/cli/approve/plan.ts`
- `packages/workstreams/src/cli/approve/revision.ts`

These modules currently assume that approved planning structures can be
converted directly into batches, threads, and `WORK.md` documents.

### State and persistence

- `packages/workstreams/src/lib/types.ts`
- `packages/workstreams/src/lib/structured-storage.ts`
- `packages/workstreams/src/lib/execution-state.ts`
- `packages/workstreams/src/lib/thread-execution.ts`
- `packages/workstreams/src/lib/storage-adapter.ts`
- `packages/workstreams/src/lib/sqlite-storage.ts`
- `packages/workstreams/src/lib/hierarchy-query.ts`
- `packages/workstreams/src/lib/update.ts`
- `packages/workstreams/src/lib/batch-status.ts`

These modules encode the current batch/thread hierarchy and single or
thread-oriented status assumptions. SQLite tables also directly encode stages,
batches, threads, execution items, approvals, batch runs, and supervision.

### Runtime and supervision

- `packages/workstreams/src/cli/supervise.ts`
- `packages/workstreams/src/lib/multi-orchestrator.ts`
- `packages/workstreams/src/lib/supervision-helper.ts`
- `packages/workstreams/src/lib/supervisor-state.ts`
- `packages/workstreams/src/lib/reset-batch-state.ts`
- `packages/workstreams/src/lib/agent-runtime/batch-executor.ts`
- `packages/workstreams/src/lib/agent-runtime/contracts.ts`
- `packages/workstreams/src/lib/agent-runtime/execute.ts`

The provider-neutral runtime, parallel execution, heartbeat, cancellation,
observability, and recovery mechanisms are likely reusable. Their identity,
state, and scheduling inputs need to be redesigned around Job Groups and Jobs.

### Prompts and agent integration

- `packages/workstreams/src/lib/prompts.ts`
- `packages/workstreams/src/lib/prompt-paths.ts`
- `packages/workstreams/src/lib/agent/tools/workstream.ts`
- implementation, management, reviewing, and evaluating agent skills
- prompt-generation and execution-agent tests

These surfaces currently tell agents to read `WORK.md`, inspect thread scope,
and use state-update commands. They must be aligned with the new Job/report
contract and manual top-level agent handoffs.

## Reusable infrastructure

The following areas can likely remain conceptually intact behind new adapters:

- repository/workstream discovery;
- filesystem discovery and atomic writes;
- locking and filesystem-authoritative/SQLite synchronization;
- provider-neutral runtime contracts;
- OpenCode and Cursor adapters;
- heartbeat, cancellation, observability journals, snapshots, and recovery;
- `work/agents.yaml` assignment data;
- dashboard/read-model APIs after hierarchy adaptation;
- notifications and general CLI argument infrastructure; and
- existing storage, runtime, approval, prompt, and supervision test seams.

## Main risks

1. Treating v2 as a filename migration while retaining the old batch/thread
   domain model underneath.
2. Allowing plan approval to continue generating execution contracts or
   initializing management assignments.
3. Mixing static execution plans with live runtime state.
4. Preserving implementation-agent CLI state writes accidentally through old
   prompts or skills.
5. Confusing stream-level reports with per-Job reports.
6. Losing many-to-many phase-to-Job coverage when adapting the current
   batch/thread hierarchy.
7. Leaving old approval, revision, dashboard, and help-text assumptions active
   after the new gates are introduced.
8. Changing provider/runtime behavior unnecessarily while changing the domain
   model.

## Recommended deep-audit themes and slices

The high-level audit originally identified **five deep-audit themes**. To avoid
context drift, those themes were decomposed into **17 focused slices**, each
with one v2 change-impact question and a bounded file list. The slice contract
and execution protocol are documented in
[`WORKSTREAM_V2_DEEP_AUDIT_SLICES.md`](./WORKSTREAM_V2_DEEP_AUDIT_SLICES.md).

The completed findings are documented in
[`WORKSTREAM_V2_DEEP_AUDIT_RESULTS.md`](./WORKSTREAM_V2_DEEP_AUDIT_RESULTS.md).

The five umbrella themes remain:

1. planning artifacts and approval;
2. state, storage, and schema;
3. management and runtime execution;
4. agent contracts, prompts, and skills; and
5. CLI, documentation, tests, and migration.

Each slice answers a direct question about the gap between the current
implementation and the v2 documents. No slice is a general repository audit.

### Original deep-audit theme 1: Planning artifact and approval

The following four slices cover the theme:

1. planning path discovery and consolidation;
2. planning Markdown parser and domain extraction;
3. planning validation, generation, and editing; and
4. approval commands and revision side effects.

### Original deep-audit theme 2: State, storage, and schema

The following four slices cover the theme:

5. domain types and identifier inventory;
6. filesystem state and storage adapters;
7. SQLite persistence and read models; and
8. state mutation, lifecycle transitions, and reset behavior.

### Original deep-audit theme 3: Management and runtime execution

The following two slices cover the theme:

9. supervision and Job Group scheduling; and
10. agent runtime execution and providers.

### Original deep-audit theme 4: Agent contracts, prompts, and skills

The following two slices cover the theme:

11. prompt assembly and workstream tool contract; and
12. global skills and manual handoff contract.

### Original deep-audit theme 5: CLI, documentation, tests, and migration

The following five slices cover the theme:

13. public CLI dispatch, help, and exports;
14. planning and approval test delta;
15. state and storage test delta;
16. runtime and prompt test delta; and
17. documentation, templates, and clean-break migration.

### Earlier broad audit scopes

The following broad scopes are retained only as historical rationale for the
focused slices above. They are not execution instructions.

#### Broad state/storage scope

The state/storage theme covers the new stage, phase, Job, Job Group, report,
approval, and three-field Job state model across filesystem state, SQLite,
read models, and CLI updates.

Primary scope:

- `types.ts`
- `structured-storage.ts`
- `execution-state.ts`
- `thread-execution.ts`
- `storage-adapter.ts`
- `sqlite-storage.ts`
- `hierarchy-query.ts`
- `update.ts`
- `batch-status.ts`

#### Broad runtime scope

The runtime theme maps the Stage Manager's execution plan, Job Group scheduling,
Job assignment, many-to-many phase coverage, and state transitions onto
supervision and provider execution.

Primary scope:

- `cli/supervise.ts`
- `multi-orchestrator.ts`
- `supervision-helper.ts`
- `supervisor-state.ts`
- `reset-batch-state.ts`
- `agent-runtime/batch-executor.ts`
- runtime contracts and execution adapters

#### Broad agent-contract scope

The agent-contract theme replaces current `WORK.md` and `work update`
assumptions with the Job/report contract and manual handoff rules.

Primary scope:

- `prompts.ts`
- `prompt-paths.ts`
- `agent/tools/workstream.ts`
- implementation and management skills
- prompt, execution, and agent-runtime tests

#### Broad integration scope

The integration theme covers command changes, aliases, exports, dashboards,
help text, fixtures, tests, legacy reads, and manual migration requirements.

Primary scope:

- all `cli/` command entry points and help tests;
- approval, validation, prompt, runtime, storage, and supervision tests;
- `README.md`, `docs/WORKSTREAM.md`, staged-workstream docs, and skills;
- templates and generated artifacts; and
- the current pilot workstream migration procedure.

## Completed execution order

The 17 slices were run in bounded groups:

1. A1–A4: planning and approval;
2. A5–A8: state and persistence;
3. A9–A10: supervision and runtime;
4. A11–A12: prompts and global skills;
5. A13: public CLI dispatch and exports;
6. A14–A16: focused test deltas; and
7. A17: documentation, templates, and migration.

The first two groups establish the planning and live-state gaps. Runtime and
agent-contract findings build on those boundaries. The final groups identify
the externally visible and migration surface. See the results document for
the synthesized findings and remaining design decisions.
