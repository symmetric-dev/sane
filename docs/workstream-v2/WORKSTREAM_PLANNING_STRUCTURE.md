# Workstream Planning Structure

## Purpose

This document defines the target planning model for AgENV workstreams. It
replaces the current model in which stages contain batches, threads, and
generated `WORK.md` files.

This is a breaking change. The old planning and execution layout is not a
compatibility target. V2 does not consider migration of existing workstreams;
excluding migration keeps the redesign simple and avoids over-engineering.

This document defines the `plan/` path only. The future `manage/` path,
including workforce division, groups, jobs, execution state, and management
artifacts, is intentionally out of scope here.

Global role definitions, planning policies, management heuristics, and workflow
instructions are not workstream artifacts. They are supplied through globally
available agent skills or instructions provided by OpenCode or another agent
harness. They are not assumed to be specific to this repository or to any one
workstream. A workstream's eventual `manage/` path may contain only management
artifacts specific to that workstream.

## Design principles

- Planning is progressively refined from workstream intent to implementation
  design.
- Each planning level has a distinct scope and a clear human review boundary.
- Stages are milestones and human checkpoints.
- Phases are specialized, ordered implementation-planning units within a
  stage.
- A phase may later be covered by multiple Jobs, and a Job may cover multiple
  phases; this many-to-many mapping is a management concern and does not belong
  in `plan/`.
- Planning and management assistants help the user research, organize, record,
  and execute decisions; they do not make unapproved decisions autonomously.
- Directory boundaries are soft collaboration boundaries for agents and users.
  They are not currently enforced through automated ownership checks.

The `plan/` and future `manage/` documents preserve planning and coordination
context across agents. They are not the canonical state of the codebase. The
implementation, tests, and other actual repository outputs remain authoritative
when implementation work reveals that planning or execution notes should
change.

## Canonical workstream shape

The planning portion of a workstream has this shape:

```text
<workstream>/
├── README.md
├── resources/
├── docs/
└── plan/
    ├── PLAN.md
    └── stages/
        ├── 01/
        │   ├── PLAN.md
        │   ├── SPEC.md
        │   └── phases/
        │       ├── PLAN.md
        │       ├── 01.PHASE.md
        │       └── 02.PHASE.md
        └── 02/
            ├── PLAN.md
            ├── SPEC.md
            └── phases/
                ├── PLAN.md
                ├── 01.PHASE.md
                └── 02.PHASE.md
```

Root-level workstream context, research inputs, and supporting notes remain
filesystem-based. This document does not redefine root operational files such
as reports or runtime state.

Stage and phase identifiers are numeric and stable. Slugs and alternate
identifier schemes are out of scope for this change.

There are no batches, threads, or `WORK.md` files anywhere under `plan/`.

## Planning roles

### Prime Planner Assistant

The Prime Planner Assistant works horizontally across the workstream. It is
the first planning assistant the user engages and is responsible for:

- coordinating research subagents;
- identifying the problem, context, and high-level requirements;
- helping the user establish the workstream objective and boundaries;
- recording cross-stage decisions, constraints, and known dependencies; and
- writing the top-level `plan/PLAN.md`.

The Prime Planner Assistant does not create or detail stages or phases. It does
not specify implementation classes, files, packages, interfaces, or worker
jobs.

### Scope Planner Assistant

`Scope Planner Assistant` is the current working title for the assistant that
bridges the workstream plan and stage implementation planning. It works
horizontally across stages and is responsible for:

- proposing how the workstream should be divided into stages;
- deciding which stages should be planned now and which can be deferred;
- writing each stage's `PLAN.md` and `SPEC.md` at the stage level; and
- creating the initial high-level phase sequence in that stage's
  `phases/PLAN.md`.

It does not write the detailed phase implementation documents.

### Implementation Planner Assistant

An Implementation Planner Assistant works vertically within one stage. It is
responsible for:

- understanding the complete stage context;
- refining the stage's phase division and sequence;
- writing the stage's individual `NN.PHASE.md` files;
- making concrete implementation and architecture decisions for each phase;
- identifying affected paths, interfaces, dependencies, behavior, and
  verification requirements; and
- updating the phase sequence when detailed planning reveals a better
  decomposition.

It does not divide phases into agent jobs or groups. It also must not silently
change the stage objective, requirements, or major stage-level technology
decisions. If detailed planning exposes a stage-level change, that change is
surfaced to the user and Scope Planner Assistant.

## Agent invocation model

The Prime Planner Assistant, Scope Planner Assistant, Implementation Planner
Assistant, and future Stage Manager Agent are all top-level OpenCode agents
that the user invokes and hands off manually. They are not spawned
automatically by workstream commands, workstream approval, or execution
processes.

Workstream commands may provide filesystem and execution operations to an
already-running agent. They do not decide when to start a planning or
management agent, construct its prompt, or transfer control between agents.
The user remains responsible for selecting the agent, providing its prompt,
reviewing its output, and deciding when to hand work to the next role.

## Workstream plan

`plan/PLAN.md` is the highest-level planning document. It records the design
direction that the user has approved for the workstream, including:

- the overall objective and desired outcome;
- problem context and important research conclusions;
- broad scope and non-goals;
- cross-stage constraints and dependencies;
- high-level technical or product direction; and
- the intended progression of the workstream without detailed stage or phase
  implementation design.

It is a workstream-level design document, not a task list and not an agent
assignment plan.

## Stage plan and specification

Each stage is a meaningful milestone and human review checkpoint. Its two
documents deliberately remain at the stage level.

### `stages/<stage>/PLAN.md`

The stage plan contains:

- **Objective** — what the stage should accomplish and deliver;
- **Execution** — how the stage will achieve its objective at a high level;
  and
- **References** — files and other material needed for further planning.

The stage plan explains the stage's purpose and approach. It does not contain
agent jobs or detailed implementation contracts.

### `stages/<stage>/SPEC.md`

The stage specification contains:

- **Tech Decisions** — technology and architectural choices that constrain
  the stage, such as libraries, database conventions, RDBMS selection,
  frontend frameworks, or monorepo package conventions;
- **Dependencies** — what must exist or be decided before the stage starts;
- **Requirements** — what the stage must accomplish technically;
- **Deliverables** — expected paths, files, services, or other outputs, when
  applicable; and
- **Resources** — focused technical resources, documentation URLs, research
  notes, files, and test scripts.

Stage specifications may establish technology direction and constraints. They
do not need to include exact interfaces, classes, imports, or code examples.
Those details belong in the phase documents.

## Phase sequence plan

`stages/<stage>/phases/PLAN.md` is the planning nexus for the stage's phases.
It is a plan for the division of the stage, not an individual phase document.

It records:

- the ordered list of phases;
- a concise objective for each phase;
- phase-to-phase dependencies;
- expected phase outputs;
- the stage requirements and deliverables covered by each phase;
- the rationale for the proposed sequence and boundaries; and
- unresolved sequencing questions or risks.

The Scope Planner Assistant creates the initial version after the stage
documents exist. The Implementation Planner Assistant then refines it while
planning the stage in depth. The Implementation Planner may split, merge,
reorder, or otherwise adjust phases when technical planning warrants it.

The phase sequence plan should remain high-level. It should not duplicate the
implementation details in `NN.PHASE.md` and should not contain groups, jobs,
agent assignments, or execution status.

## Individual phase documents

Each `stages/<stage>/phases/NN.PHASE.md` is one complete planning document. The
separate phase `PLAN.md` and `SPEC.md` files are intentionally not used because
the phase is the closest planning unit to implementation and needs one
coherent technical design surface.

Each phase document should establish:

- **Objective** — what this phase accomplishes;
- **Scope and non-goals** — what is and is not included;
- **Stage traceability** — which stage requirements or deliverables it
  fulfills;
- **Dependencies** — required earlier phases, artifacts, or external inputs;
- **Implementation decisions** — concrete classes, modules, packages,
  patterns, responsibilities, and technical choices;
- **Affected paths** — files, directories, packages, or services to create or
  modify;
- **Interfaces and contracts** — APIs, types, schemas, events, or boundaries;
- **Data and configuration changes** — persistence, environment, build, or
  deployment changes;
- **Behavior and invariants** — expected behavior, validation, error handling,
  and constraints;
- **Integration points** — how the phase connects to previous and subsequent
  phases;
- **Verification requirements** — tests, checks, and evidence required;
- **Deliverables** — concrete outputs expected from the phase;
- **References and resources** — focused implementation research; and
- **Open decisions or risks** — items requiring user input or escalation.

The phase document defines implementation design, not workforce allocation. It
must not say which agent, group, or job will implement each item.

## Approval and incremental planning

The planning and implementation gates are:

1. `work approve plan --root` — approves the high-level workstream plan.
2. `work approve plan --stage N` — approves the planning documents for one
   stage, including its phase sequence and phase documents.
3. `work approve management --stage N` — approves the stage-specific execution
   plan before any implementation Jobs run.
4. `work approve implementation --stage N` — approves the reviewed
   implementation results for the stage. This replaces the former
   `work approve stage N` command.

The new CLI does not provide a separate `work approve stage N` command. Stage
planning approval is scoped through `work approve plan --stage N`, and final
implementation acceptance is scoped through `work approve implementation
--stage N`.

The workstream does not need all stages planned at once. The user may:

- approve the workstream plan at the root level;
- plan and approve an initial subset of stages;
- have each stage's Implementation Planner refine its phase sequence and phase
  documents;
- have the Stage Manager create and obtain approval for a stage execution plan;
- begin implementation work only after management approval; and
- add and approve additional stages later.

No planner or manager agent is automatically started by any of these gates.
Approval records the user's decision about the documents; the user separately
chooses which top-level agent to invoke next.

The initial phase sequence may be provisional. For a stage to be considered
fully planned at `work approve plan --stage N`, its phase sequence and
individual phase documents should be sufficiently refined for the Stage
Manager to create an execution plan without inventing design decisions.

Management approval is a separate gate from stage planning approval, and must
occur before `work supervise` runs any implementation Job Group. Implementation
approval is the final user-controlled acceptance of the stage's implementation;
it may pass only when every Job has `execution_state: executed` and
`approval_state: approved` or `rejected`, and it is not performed automatically
by the Stage Manager.

## Out of scope

This planning model does not yet define:

- the `manage/` directory structure;
- groups, jobs, or workforce allocation;
- implementation-agent prompts;
- execution state or runtime persistence;
- supervision, retries, or review automation; or
- compatibility with the previous stages/batches/threads layout; and
- global planner or manager policies, role instructions, or optimization
  heuristics.

The workstream-specific management model will be designed separately after the
`plan/` model is settled. The intended global management principles are
recorded for reference in
[`WORKSTREAM_MANAGEMENT_PRINCIPLES.md`](./WORKSTREAM_MANAGEMENT_PRINCIPLES.md),
but their operational source of truth must be the globally supplied agent
skills or harness instructions rather than any individual workstream.
