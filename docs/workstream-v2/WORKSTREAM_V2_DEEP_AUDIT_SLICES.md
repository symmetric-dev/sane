# Workstream v2 Deep-Audit Slices

## Purpose

The first deep-audit decomposition was too broad: each audit combined several
architectural questions and too many files for one agent context. This document
replaces those broad audits with bounded, specialized slices.

The slices below are grouped under the original five audit themes, but each
subagent receives only one slice. The agents are research-only. They must report
what the repository does today and the implications for v2; they must not
implement or edit anything.

## Shared instructions for every audit agent

Every agent must follow these rules:

1. Read only the relevant sections of:
   - `docs/workstream-v2/WORKSTREAM_PLANNING_STRUCTURE.md`;
   - `docs/workstream-v2/WORKSTREAM_MANAGEMENT_PRINCIPLES.md`; and
   - this document's assigned slice.
   Do not read the repository-wide `AGENTS.md`; its package and test workflow
   instructions are not needed for a read-only delta audit.
2. Treat the v2 documents as the requirements under audit. Do not perform a
   general architecture inventory. The only question is the gap between the
   assigned v2 requirement and the current implementation in the assigned
   files.
3. Inspect the listed files first. Read a direct import or direct caller only
   when it is necessary to establish the requested flow. Do not recursively
   explore the whole repository.
4. Stay within the assigned question. If another subsystem is discovered,
   record it under **Follow-up, not audited** instead of expanding scope.
5. Do not edit, create, delete, rename, format, or generate repository files.
   Do not change Git state. Do not run commands that mutate state.
6. Do not propose implementation code. Report facts, v2 implications,
   invariants, and bounded implementation boundaries.
7. Use exact `path:line` references for every material finding. If a line range
   is approximate because the file changed while reading, say so.
8. Keep the final report below 900 words. Prefer tables and concise bullets.

## Required report format

Each agent must return exactly these sections:

```text
# <slice ID>: <title>

## V2 requirement anchor
Quote or precisely identify the assigned v2 rule(s) being checked.

## Scope result
One sentence stating whether the assigned v2 delta was fully inspected.

## Observed current behavior
At most six bullets, each with a path:line reference. Every bullet must support
the v2 comparison.

## Gap assessment
At most six bullets. Label each gap `compliant`, `partial`, `conflicting`, or
`unknown`, and tie it directly to a v2 rule.

## Required invariants and boundary
At most five bullets describing behavior that implementation must preserve or
change, followed by one paragraph defining what this slice does not own.

## Verification surface
At most six relevant existing tests and/or specific regression scenarios.

## Open decisions
At most four decisions. Mark each `settled`, `needs design`, or `follow-up`.

## Follow-up, not audited
List any discovered paths or questions outside this slice.
```

Agents must distinguish **observed current behavior** from the **v2 gap
assessment**. They must not repeat the v2 design document or describe unrelated
current architecture.

## Slice inventory

### Theme 1 — Planning artifacts and approval

#### A1 — Planning path discovery and consolidation

**Single question:** How does the current implementation locate and combine
workstream and stage planning files, and what is the smallest path-discovery
boundary needed for the new `plan/` tree?

**Primary files:**

- `packages/workstreams/src/lib/repo.ts`
- `packages/workstreams/src/lib/stage-directories.ts`
- `packages/workstreams/src/lib/consolidate.ts`
- direct path/discovery tests only

**Exclude:** Markdown grammar, plan generation, approval state, SQLite, runtime,
and management artifacts.

#### A2 — Planning Markdown parser and domain extraction

**Single question:** What current Markdown grammar and TypeScript structures are
used to parse `PLAN.md`, and what must be replaced to parse the root/stage/phase
planning documents without batches, threads, or `WORK.md`?

**Primary files:**

- `packages/workstreams/src/lib/stream-parser.ts`
- parser-related definitions in `packages/workstreams/src/lib/types.ts`
- `parser_*.test.ts`

**Exclude:** Filesystem discovery, approval side effects, execution state, and
management Job mapping.

#### A3 — Planning validation, generation, and editing

**Single question:** Which validation, scaffolding, generation, and editing
operations create or assume the current stage/batch/thread plan shape?

**Primary files:**

- `packages/workstreams/src/lib/requirements.ts`
- `packages/workstreams/src/lib/generate.ts`
- `packages/workstreams/src/lib/plan-edit.ts`
- `packages/workstreams/src/lib/work-validation.ts`
- `packages/workstreams/src/cli/plan.ts`
- `packages/workstreams/src/cli/validate.ts`
- `generate.test.ts`, `plan.test.ts`, and validation tests

**Exclude:** Approval persistence and runtime execution.

#### A4 — Approval commands and revision side effects

**Single question:** What exactly does each current approval/revision path
validate, mutate, generate, commit, or call externally, and how must those
side effects change for the four v2 approval gates?

**Primary files:**

- `packages/workstreams/src/cli/approve/index.ts`
- `packages/workstreams/src/cli/approve/plan.ts`
- `packages/workstreams/src/cli/approve/revision.ts`
- `packages/workstreams/src/cli/approve/utils.ts`
- `packages/workstreams/src/lib/approval.ts`
- `packages/workstreams/src/lib/approval-append.ts`
- approval-specific Git/GitHub call sites only
- approval and role-enforcement tests

**Exclude:** General CLI dispatch, parser internals, SQLite schema, and runtime
scheduling.

## Theme 2 — State, storage, and schema

#### A5 — Domain types and identifier inventory

**Single question:** Where are the current Stage/Batch/Thread/ExecutionItem
types and identifier formats defined, and what type-level vocabulary must be
replaced or retained for v2?

**Primary files:**

- relevant sections of `packages/workstreams/src/lib/types.ts`
- `packages/workstreams/src/lib/model.ts`
- `packages/workstreams/src/lib/multi-types.ts`
- `packages/workstreams/src/lib/stage-id.ts`
- `packages/workstreams/src/lib/execution-ids.ts`
- `packages/workstreams/src/lib/runtime-state.ts`

**Exclude:** Storage implementation and state-transition behavior. Do not read
all 1,300+ lines of `types.ts`; locate only exported domain/status/interface
definitions and their direct uses.

#### A6 — Filesystem state and storage adapters

**Single question:** How is workstream state currently read, written, locked,
and synchronized at the filesystem/storage-adapter boundary, independent of the
SQLite schema?

**Primary files:**

- `packages/workstreams/src/lib/structured-storage.ts`
- `packages/workstreams/src/lib/storage-adapter.ts`
- `packages/workstreams/src/lib/sqlite-storage-adapter.ts`
- `packages/workstreams/src/lib/files.ts`
- `packages/workstreams/src/lib/tree.ts`
- `packages/workstreams/src/lib/repo.ts` path helpers only

**Exclude:** SQL table definitions, dashboard queries, prompt contracts, and
runtime orchestration.

#### A7 — SQLite persistence and read models

**Single question:** Which SQLite tables, queries, synchronization paths, and
dashboard/read-model contracts encode the current hierarchy and status model?

**Primary files:**

- `packages/workstreams/src/lib/sqlite-storage.ts`
- `packages/workstreams/src/lib/hierarchy-query.ts`
- `packages/workstreams/src/lib/workspace-read-model.ts`
- `packages/workstreams/src/internal/dashboard-contracts.ts`
- `packages/workstreams/src/internal/dashboard-observability.ts`
- `sqlite-storage-bootstrap.test.ts` and `dashboard-contracts.test.ts`

**Exclude:** Filesystem adapter details, CLI behavior, provider runtime, and
prompt/skill text.

#### A8 — State mutation, lifecycle transitions, and reset behavior

**Single question:** How do current commands and runtime code mutate execution
status, thread status, batch status, finalization, and reset/recovery state?

**Primary files:**

- `packages/workstreams/src/lib/execution-state.ts`
- `packages/workstreams/src/lib/thread-execution.ts`
- `packages/workstreams/src/lib/update.ts`
- `packages/workstreams/src/lib/batch-status.ts`
- `packages/workstreams/src/lib/reset-batch-state.ts`
- `packages/workstreams/src/lib/multi-finalization.ts`
- `update-thread-execution.test.ts` and directly related state tests

**Exclude:** Initial domain-type inventory, SQL schema design, and supervisor
scheduling. Focus on transitions and authority.

## Theme 3 — Management and runtime execution

#### A9 — Supervision and Job Group scheduling

**Single question:** How does supervision select, group, order, launch, monitor,
and finalize current batches, and which control-flow boundaries correspond to
v2 Job Groups?

**Primary files:**

- `packages/workstreams/src/cli/supervise.ts`
- `packages/workstreams/src/lib/multi-orchestrator.ts`
- `packages/workstreams/src/lib/supervision-helper.ts`
- `packages/workstreams/src/lib/supervisor-state.ts`
- `packages/workstreams/src/lib/batch-monitor.ts`
- `supervise-backend.test.ts`, `multi-orchestrator.test.ts`, and
  `supervise-stage-approval-gate.test.ts`

**Exclude:** Provider request details, prompt text, SQL schema, and unrelated
notifications/GitHub behavior.

#### A10 — Agent runtime execution and providers

**Single question:** What provider-neutral execution contract runs one current
thread, and what can be reused when a v2 Job runs inside a Job Group?

**Primary files:**

- `packages/workstreams/src/lib/agent-runtime/contracts.ts`
- `packages/workstreams/src/lib/agent-runtime/batch-executor.ts`
- `packages/workstreams/src/lib/agent-runtime/execute.ts`
- `packages/workstreams/src/lib/agent-runtime/index.ts`
- `packages/workstreams/src/lib/agent-runtime/providers/opencode.ts`
- `packages/workstreams/src/lib/agent-runtime/providers/cursor.ts`
- `batch-executor.test.ts`, `agent-runtime.test.ts`, and provider tests

**Exclude:** Job Group scheduling, approval command parsing, and global skills.
Focus on agent invocation, process outcomes, cancellation, retry, heartbeat,
and evidence/report inputs.

## Theme 4 — Agent contracts, prompts, and skills

#### A11 — Prompt assembly and workstream tool contract

**Single question:** What context and instructions are assembled for an
implementation/runtime agent, and where are `WORK.md`, thread scope, and
state-update assumptions injected?

**Primary files:**

- `packages/workstreams/src/lib/prompts.ts`
- `packages/workstreams/src/lib/prompt-paths.ts`
- `agent/tools/workstream.ts`
- `packages/workstreams/src/cli/prompt.ts`
- `prompt-generation.test.ts` and tool-runtime loader tests

**Exclude:** Global skill prose and provider process mechanics. Report only the
workstream-generated prompt/tool contract.

#### A12 — Global skills and manual handoff contract

**Single question:** What do the global planning, implementation, management,
review, evaluation, and handoff skills instruct agents to do, and what must
change to enforce manual top-level invocation and Job/report ownership?

**Primary files:**

- `agent/skills/implementing-workstream-threads/SKILL.md`
- `agent/skills/managing-workstream-implementation/SKILL.md`
- `agent/skills/reviewing-workstream-implementation/SKILL.md`
- `agent/skills/evaluating-workstreams/SKILL.md`
- `agent/skills/handoff-workstream-implementation/SKILL.md`
- relevant `agent/commands/work:*.md`

**Exclude:** Package prompt assembly and runtime provider code. Do not audit
every skill; read only the listed workflow skills and direct handoff commands.

## Theme 5 — CLI, documentation, tests, and migration

#### A13 — Public CLI dispatch, help, and exports

**Single question:** What is the externally visible command/flag/export surface
that must expose the v2 approval and supervision vocabulary?

**Primary files:**

- `packages/workstreams/bin/work.ts`
- `packages/workstreams/bin/work-sdk.ts`
- `packages/workstreams/src/index.ts`
- `packages/workstreams/src/lib/help.ts`
- `packages/workstreams/src/lib/roles.ts`
- `help_text.test.ts`, `cli-roles.test.ts`, and `sdk-cli.test.ts`

**Exclude:** Detailed behavior inside approval, runtime, storage, or prompt
modules; those belong to A4, A9/A10, A6/A7, and A11.

#### A14 — Planning and approval test delta

**Single question:** Which planning, validation, generation, and approval tests
encode behavior explicitly removed or changed by the v2 planning tree and four
approval gates?

**Primary files:**

- `packages/workstreams/tests/helpers/test-workspace.ts`
- `packages/workstreams/tests/helpers/cli-runner.ts`
- `packages/workstreams/tests/fixtures/plans/*`
- `packages/workstreams/tests/plan.test.ts`
- `packages/workstreams/tests/generate.test.ts`
- `packages/workstreams/tests/draft_plan_semantics.test.ts`
- `packages/workstreams/tests/approve_role_enforcement.test.ts`
- `packages/workstreams/tests/approval_name_resolution.test.ts`

**Exclude:** State/storage/runtime/prompt tests and unrelated integrations. Do
not rerun tests; produce only a focused test delta and acceptance cases for
planning and approval.

#### A15 — State and storage test delta

**Single question:** Which state, persistence, hierarchy, dashboard, and reset
tests must change or be added to enforce static-plan/live-state separation and
independent Job state axes?

**Primary files:**

- `packages/workstreams/tests/helpers/test-workspace.ts`
- `packages/workstreams/tests/sqlite-storage-bootstrap.test.ts`
- `packages/workstreams/tests/dashboard-contracts.test.ts`
- `packages/workstreams/tests/update-thread-execution.test.ts`
- `packages/workstreams/tests/status-thread-counts.test.ts`
- `packages/workstreams/tests/sdk-state-metadata.test.ts`

**Exclude:** Planning parser/generator tests, provider runtime tests, prompt
tests, and CLI help. Do not rerun tests; inspect only relevant cases.

#### A16 — Runtime and prompt test delta

**Single question:** Which supervision, orchestration, provider-runtime, and
prompt tests encode the old Batch/Thread execution contract and must prove the
v2 Job Group/Job execution behavior without giving agents state authority?

**Primary files:**

- `packages/workstreams/tests/fixtures/fake-agent-runtime.ts`
- `packages/workstreams/tests/batch-executor.test.ts`
- `packages/workstreams/tests/agent-runtime.test.ts`
- `packages/workstreams/tests/multi-orchestrator.test.ts`
- `packages/workstreams/tests/supervise-backend.test.ts`
- `packages/workstreams/tests/supervise-stage-approval-gate.test.ts`
- `packages/workstreams/tests/prompt-generation.test.ts`

**Exclude:** SQL schema/read-model tests, planning tests, global skill prose,
and unrelated provider/GitHub/notification tests. Do not rerun tests.

#### A17 — Documentation, templates, and clean break

**Single question:** Which user-facing documents/templates describe the old
layout or lifecycle, and what documentation replacement is needed to establish
the V2 clean break?

**Primary files:**

- `README.md`
- `packages/workstreams/README.md`
- `docs/WORKSTREAM.md`
- `docs/staged-workstreams/README.md`
- `docs/staged-workstreams/WORK.md.template.md`
- `docs/workstream-v2/*.md`
- legacy workstream documentation directly linked from those files

**Exclude:** Source-code design and test implementation. Migration is
intentionally out of scope; document that V2 has no migration or compatibility
path rather than designing one.

## Execution protocol

Run slices in bounded batches so results remain independently reviewable:

1. A1–A4: planning and approval;
2. A5–A8: state and persistence;
3. A9–A10: supervision and runtime;
4. A11–A12: prompts and global skills;
5. A13: public CLI dispatch and exports;
6. A14–A16: focused test deltas;
7. A17: documentation, templates, and clean break.

The batches may be parallelized internally, but a subagent must never be given
more than one slice. After each batch, retain the returned reports as separate
findings. Cross-slice synthesis happens only after all seventeen reports exist.
