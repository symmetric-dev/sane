# Workstream Management Principles

## Purpose and scope

This document records intended cross-workstream semantics for workstream
management. It is a design/reference document, not a workstream artifact.

The canonical operational form of these policies, role definitions, heuristics,
and workflow instructions must be supplied through globally available agent
skills or instructions provided by OpenCode or another agent harness. They are
not assumed to be specific to this repository. They must not be copied into a
workstream's `manage/` directory.

A workstream's `manage/` path is reserved for artifacts specific to that
workstream, such as its stage execution plans, job definitions, group
arrangements, and execution-related decisions.

The management artifact schema, approval flow, and execution-state model are
being defined incrementally. This document records the settled semantics and
identifies the remaining decisions.

## Planning artifacts are context, not codebase authority

The `plan/` and `manage/` trees are mechanisms for preserving context and
coordinating multiple agents. They are not the canonical state of the codebase
and do not override the code, tests, or other actual implementation outputs.

Implementation work may reveal that the plan or execution plan needs to change.
Agents may record those changes in reports or other workstream documentation
while implementation proceeds. Changes do not automatically require a new
approval cycle. The existing `--revoke` approval option may remain available,
but re-approval is an explicit tool for cases where the user wants it, not a
default reaction to every planning adjustment.

## Manual agent invocation

The following are top-level OpenCode agents that the user invokes and hands off
manually:

- Prime Planner Assistant;
- Scope Planner Assistant;
- Implementation Planner Assistant; and
- Stage Manager Agent.

No workstream command, approval operation, supervision process, or other
automated workflow may spawn these agents or decide when to transfer control
between them.

Commands such as `work supervise` are tools used by an already-running agent.
They do not launch a Stage Manager Agent. The user chooses the agent, provides
its prompt, reviews its output, and decides when to continue to the next role.

## Approval gates

The user explicitly approves each planning and execution boundary:

1. `work approve plan --root` approves the initial workstream plan.
2. `work approve plan --stage N` approves the planning documents for Stage N,
   including its phase sequence and phase documents.
3. `work approve management --stage N` approves Stage N's
   `manage/stages/N/EXECUTION-PLAN.md` before any implementation Job Group is
   run.
4. `work approve implementation --stage N` accepts the implementation work for
   Stage N. It replaces the former `work approve stage N` command and records
   that the user has been informed of the implementation outcomes and has
   approved them. When it passes, it marks Stage N as `approved` in the
   existing `work/*` status state.

There is no separate `work approve stage N` command in the new CLI. Stage
planning approval is represented by `work approve plan --stage N`, while final
implementation acceptance is represented by `work approve implementation
--stage N`.

The command paths use `--root` for the workstream-level plan and `--stage N`
for stage-scoped approvals. The management approval command is spelled
`management`.

Approval commands do not start agents, execute Jobs, or transfer control. They
record the user's approval and update the relevant `work/*` state. They do not
modify the codebase, planning documents, management artifacts, or reports by
default. The user separately invokes and prompts the next top-level agent.

Approval commands should not execute Git commands by default during this
transition. Existing Git integration may remain disabled for approval flows so
the structural and state changes can be migrated without adding repository
side effects.

The existing `--revoke` option may be used to revoke an approval. Revocation
only updates the relevant `work/*` state; it does not modify code, planning
documents, management artifacts, reports, or Git state.

## Stage Manager responsibilities

The Stage Manager Agent works on one approved stage at a time. Its general
responsibilities are:

1. Read the workstream context and all planning documents relevant to the
   stage, including the workstream plan, stage plan and specification, phase
   sequence, and individual phase documents.
2. Identify the Jobs required to implement the stage.
3. Review and optimize those Jobs into Job Groups for execution.
4. Run the approved Job Groups through the existing supervision workflow,
   currently using `work supervise`.
5. Manage execution review, failure handling, escalation, and user-requested
   follow-up according to the approved workstream-specific execution plan.

The Stage Manager may make execution-planning decisions within the approved
design. It must surface any discovery that changes the stage's approved
objective, requirements, or major technical decisions to the user rather than
silently changing the planning source of truth.

The Stage Manager may update workstream planning or execution documentation
while implementation is underway when doing so preserves useful context. Such
updates are recorded as notes or report context and do not automatically force
the user through a new approval cycle.

The Stage Manager may perform a review after a Job Group finishes without a
separate user request. It may read the Job reports directly or launch a review
subagent in its current OpenCode session. Review is for obtaining a summary and
identifying incomplete implementation; it never authorizes an automatic fix.

Fixes are outside the planned Job model. A user may explicitly request a
specialized fix agent or other follow-up work, but the Stage Manager must not
start fixes autonomously.

## Jobs

A **Job** is a coherent set of tasks assigned to one implementation agent.

Jobs are derived from the phase documents, but they are not required to be
one-to-one with phases. The relationship between phases and Jobs is
many-to-many:

- one phase may be covered by multiple Jobs; and
- one Job may cover multiple phases.

A Job may:

- cover part of one phase;
- cover an entire phase;
- cover the end of one phase and the beginning of another; or
- span multiple phases when that produces a more coherent unit of ownership.

Job boundaries should follow coherent implementation ownership, dependencies,
integration needs, and agent context. Phase boundaries are inputs to Job
planning, not mandatory Job boundaries. The Stage Execution artifact should
make the phase-to-Job coverage explicit so that work is not lost or duplicated.

### Job artifacts

Each Job is represented by a workstream-specific file under its stage:

```text
manage/stages/01/jobs/01.JOB.md
manage/stages/01/jobs/02.JOB.md
manage/stages/01/jobs/03.JOB.md
```

The filename is `<job-number>.JOB.md`. Job numbers are local to the stage. Job
Group membership is tracked separately in the Job Group sections of
`EXECUTION-PLAN.md`, not in the Job filename.

Job numbers are unique within a stage and use the two-digit range `01` through
`99`. They are not reused within that stage after assignment.

The Job file contains only the direct implementation request:

- **What to do** — the specific implementation work required;
- **What not to do** — explicit exclusions and boundaries; and
- **Other Notes** — optional additional guidance.

The request may be technically deep and precise even though it is written
directly and without a large contract template. Job files do not repeat
references to the planning documents. The implementation-agent skill and
execution prompt provide the Job path, the report path, and generic guidance on
finding the current workstream and Stage N planning documents.

Job Groups are represented as sections in the stage execution plan. They do
not receive separate files.

## Implementation-agent execution contract

Implementation agents receive:

- the path to their `JOB.md` file;
- the path where they must write their Job `REPORT.md`; and
- global skill or harness instructions explaining how to work from the Job and
  locate the current stage planning documents.

They focus on implementing the Job. They may use any private task-tracking
method they prefer, but the global instructions do not prescribe such methods.

Implementation agents must not update workstream execution state through the
CLI or any other state-management interface. Their workstream-facing output is
the implementation itself and their Job report.

Each Job report is stored at the mirrored path:

```text
manage/stages/01/reports/01.REPORT.md
```

The report is written by the implementation agent when its process completes.
It contains:

- **Accomplished** — what the implementation agent completed. If nothing was
  accomplished, the agent may write `Nothing was accomplished`;
- **Found issues** — issues, blockers, or deviations discovered. If none were
  found, the agent may write `No issues found`; and
- **Notes** — optional additional context.

The Stage Manager reads the report and decides whether the result is complete
or incomplete.

Job assignment uses the existing `work/agents.yaml` data model. The Stage
Manager may assign one of the configured agents to a Job in the same way that
agents are assigned to current threads. This change does not introduce a new
implementation-agent profile abstraction or extend the agent definition model.

## Job Groups

A **Job Group** is a set of Jobs that can be executed in parallel under the
same execution window.

Job Groups are an optimization and scheduling construct. They do not redefine
the design established by the plan or phase documents.

The current execution adapter maps the concepts as follows:

```text
Job Group        -> current supervise batch
Job              -> current parallel implementation thread
```

The new management artifacts use Job and Job Group terminology. `work
supervise --batch` may remain as an alias for the current runtime command, but
`--job-group` is the intended future command-line terminology. The Stage
Manager invokes supervision for a complete Job Group, not an individual Job.

## Job state lifecycle and authority

Implementation agents have no write access to workstream execution state. State
transitions are performed by the execution tool or through the CLI. The tool
performs execution-result transitions automatically; the Stage Manager normally
performs review and approval transitions; and the user may use the CLI directly
to close a gap when necessary.

Each Job tracks three separate state fields. The fields are intentionally
simple and each has a distinct authority:

```text
execution_state: pending | in_progress | executed | aborted
review_state:    null | completed | incomplete
approval_state:  null | approved | rejected
rejected_reason: optional text, required when approval_state is rejected
```

### Execution state

`execution_state` is controlled by the execution tool:

- **`pending`** — the initial state before the Job has started;
- **`in_progress`** — the tool started or restarted the Job mechanistically;
- **`executed`** — the Job process completed mechanistically; and
- **`aborted`** — the CLI or agent-calling mechanism failed or exited early.

When `work supervise` starts a Job Group, the tool automatically marks every
Job in that group `in_progress`. A normal process exit produces `executed`; an
execution failure produces `aborted`.

An `aborted` Job cannot proceed to review or approval. The Stage Manager must
raise the execution problem to the user, who can resolve the issue and ask the
manager to restart the Job. A rerun transitions directly from `aborted` to
`in_progress`; execution state never returns to `pending`. `pending` is only
the initial state.

### Review state

After `execution_state` becomes `executed`, the Stage Manager reads the report
and may perform or commission a review:

- **`completed`** — the Stage Manager determined that the Job requirements were
  properly met; and
- **`incomplete`** — the Stage Manager found that requirements were not met or
  that a blocker remains.

The Stage Manager reports this pre-user-approval result to the user. Review
state does not block approval state: a user may reject an incomplete Job, for
example, without requiring the Job to become completed first.

### Approval state

After the user has knowledge of the outcome, the approval state may become:

- **`approved`** — the user accepts the Job result; or
- **`rejected`** — the user decides that the result should not be retained or
  pursued.

When a Job is rejected, `rejected_reason` records the user's reason. The CLI
does not perform code reversal, Git reversion, or other cleanup as part of this
state transition. The user may request a fix agent or perform any reversal
manually.

The approval state does not require `review_state` to be `completed`. It does
require `execution_state` to be `executed`; an aborted execution must be
resolved and restarted before the Job can reach an approval state.

The state model intentionally does not add a separate blocked or fix state. An
incomplete Job may remain incomplete while the user works elsewhere. If the
user requests a fix, the Stage Manager may re-evaluate the Job afterward
without automatically creating a new planned Job or adding lifecycle states.

`work approve implementation --stage N` may succeed only when every Job in the
stage has `execution_state: executed` and `approval_state: approved` or
`rejected`. The `review_state` values do not block this gate. This makes the
implementation approval a confirmation that the user has knowledge of every
Job outcome, including work that was intentionally rejected.

## Stage execution plan

The Stage Manager creates a workstream-specific execution plan at:

```text
manage/stages/01/EXECUTION-PLAN.md
```

`EXECUTION-PLAN.md` is a static, reviewable management plan. It should contain
the Job catalog, assigned agents from `work/agents.yaml`, explicit phase-to-Job
coverage, Job Group sections, group membership, group dependencies, execution
order, and the rationale for any scheduling
optimization. It is approved with:

```bash
work approve management --stage 1
```

The file is not the live execution-state store. Runtime state is updated by the
tool and Stage Manager through the existing state mechanism.

Job Groups are sections in `EXECUTION-PLAN.md`; they do not have separate
files. Job numbers and Job Group membership are therefore tracked separately:
the Job files use only the stage-local Job number, while the execution plan
records which Jobs belong to each Job Group. Live Job and Job Group state is
maintained through the existing `work/*` state mechanism. Job and report files
are the per-workstream artifacts that accompany the execution plan.

## Critical-path optimization policy

The objective of Job Group planning is to reduce the stage's realistic
critical-path duration while preserving correctness and coherent ownership.
It is not to maximize the number of Job Groups or to make the execution tree
look more parallel.

The Stage Manager must follow these rules:

1. Define the smallest coherent Jobs that make sense for one implementation
   agent before optimizing their scheduling.
2. Identify real dependencies, shared-file conflicts, integration boundaries,
   and other reasons that Jobs must remain ordered.
3. Place independent Jobs in the same Job Group when parallel execution is
   useful and safe.
4. A Job Group containing one Job is valid and often preferable to artificial
   parallelization.
5. Never split a coherent Job merely to create more Job Groups or increase a
   parallelism count.
6. A Job may be reshaped only when the new boundary remains coherent for one
   agent and produces a meaningful reduction in waiting or critical-path
   time.
7. Do not place Jobs in parallel when they have unresolved dependencies,
   overlapping writes, incompatible assumptions, or an integration order that
   has not been planned.
8. When the benefit of parallelization is uncertain, preserve the coherent
   sequential Job and record the uncertainty for user review.

In short:

> Optimize the critical path, not the number of Job Groups.

This policy belongs in the globally supplied Stage Manager skill or harness
instructions. This document records it for design/reference purposes. It
should not be duplicated as a generic policy inside every workstream's
`manage/` directory. A workstream execution artifact may record how this
policy was applied to that particular stage.

## Workstream-specific management artifacts

The current management shape is:

```text
<workstream>/
└── manage/
    └── stages/
        └── 01/
            ├── EXECUTION-PLAN.md
            ├── jobs/
            │   ├── 01.JOB.md
            │   ├── 02.JOB.md
            │   └── 03.JOB.md
            └── reports/
                ├── 01.REPORT.md
                ├── 02.REPORT.md
                └── 03.REPORT.md
```

`manage/stages/<stage>/EXECUTION-PLAN.md` describes the execution decomposition
and Job Group schedule for that specific stage. `jobs/` contains the direct
implementation requests, and `reports/` contains the implementation agents'
reports. These are all workstream-specific artifacts; global policies and
instructions do not belong in this tree.

## Stage completion and user authority

The Stage Manager may summarize the result of a completed Job Group and may
report that all planned Jobs have reached a reviewable state. It may not declare
the stage complete on the user's behalf.

The user decides when the stage is complete. The implementation approval
command is the replacement for the former stage approval command. It can pass
only after every Job has `execution_state: executed` and
`approval_state: approved` or `rejected`, ensuring that the user has knowledge
of every Job outcome. After the user runs
`work approve implementation --stage N`, the Stage Manager stops working on
that stage. The user may instead return to planning, manage another approved
stage, or end the workstream.
