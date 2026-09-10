# SANE Alpha Operating Model

## What Is SANE Alpha?

SANE means **Sane Agentic Noesis Edifice**. It is a semi-recursive name:
“Sane” describes the quality that SANE itself is intended to have while also
being the acronym's name.

SANE is a reasonable, realistic edifice: a structured set of people, agents,
artifacts, and decisions that supports knowledge acquisition and reasoning in
service of deliberate change. A workstream is the top-level unit of that
edifice.

SANE Alpha is the current human-led, agent-assisted way of operating SANE. It
aims to prove reliable agent collaboration without CLI tooling by moving a
workstream deliberately from product intent to reviewed repository changes.

This operating model is for the people defining and maintaining SANE Alpha. The
agent-facing shared context is a separate, tailored `SANE_CONTEXT.md` template.

## Core Concepts

A **workstream** is a complex undertaking organized for AI-assisted work. It
holds the context, identity, decisions, coordination, and approval history
needed to govern the work. It is not a duplicate implementation tree; the
implementation happens in its target repository.

Each implementation repository uses a separate local Git repository for its
SANE workstreams. The target repository keeps an ignored `.sane/paths`
record of the paired repositories. The Alpha layout, initialization, and
assistant-use rules are defined in
[SANE Alpha Repository Setup](./SANE_REPOSITORY_SETUP.md).

A **phase** is a horizontal responsibility view across a workstream. Each phase
has its own objective and artifacts. Phases are not necessarily one-way steps:
they may overlap and inform one another.

A **stage** is a vertical unit of work bounded by a coherent set of decisions,
an initial state, and expected outcomes. The same stage can be addressed by
multiple phases. Each phase may subdivide a stage differently to serve that
phase's objective. The criteria for division into stages is "checkpoints which require outcomes to inform the next stage technical decisions or that function as user approval milestones".

Additional terms are:

- **Section:** a coherent technical-design slice within a Design Stage.
- **Execution Plan:** the stage-level plan that turns approved Design into
  schedulable implementation work.
- **Job:** a bounded unit of implementation work prepared for one agent.
- **Implementation Report:** the recorded outcome of one Job.
- **Approval:** the user's authorization to cross a defined work boundary.
- **Handoff:** the deliberate transfer of the relevant context, artifact, and
  next action from one role to another.

## Top-Level Workflow

SANE normally progresses through the following responsibility flow:

```text
Product ↔ Research ↔ Design → Execution → Implementation
```

The user chooses where a workstream starts. Starting with Product is encouraged
when the user has enough knowledge of the work and target codebase to establish
an initial product direction. Product and Research may begin in either order
and refine one another.

Product, Research, and Design continue to exchange knowledge while the work is
being shaped. Once Product and Research establish a solid product foundation,
Research and Design should normally refine the solution without reopening
Product. A return to Product remains possible when later knowledge shows that
the intended product itself must change.

The user experiences the workflow as:

1. Establish or refine product direction and the knowledge needed to support
   it.
2. The Design Assistant develops the root Design and its Stage specifications;
   Research continues as needed to ground Design decisions.
3. The Design Assistant delivers the root Design. The user approves it before
   beginning Stage-level Engineering work.
4. The user starts an Engineering Assistant for each desired Stage. These
   Stage sessions may proceed independently because each Engineering Assistant
   focuses only on its assigned Stage.
5. Each Engineering Assistant delivers that Stage's Section specifications. The
   user approves the complete Design for Stage `N` before its Execution work
   can begin.
6. The Execution Assistant picks up Stage `N` only after that approval and,
   except for the first Stage, after the previous Stage's Execution plan is
   approved. It creates the Stage's Execution Plan and Jobs.
7. The user approves the Stage Execution plan. Implementation then carries out
   the authorized Jobs in the target repository and records their outcomes.

Later learning can return work to an earlier phase when necessary. Such a
return is deliberate: the relevant context, decision, and required follow-up
are handed back to the appropriate role.

## Roles and Scope

- **Product Assistant:** works across the whole workstream. It establishes and
  maintains product direction when new information materially changes intended
  behavior or requirements.
- **Research Assistant:** works across the workstream's knowledge base. It may
  also be brought into a dedicated Stage-level session when a Stage needs
  research. Workstream and Stage scopes are encouraged, without making them a
  hard restriction.
- **Design Assistant:** works horizontally across the Design phase. It develops
  the root Design, defines Stages, and writes the Stage specifications.
- **Engineering Assistant:** works vertically on one Stage. It picks up that
  Stage's specification, divides it into Sections, and writes the Section
  specifications that provide the Stage's engineering solutions. It may use
  code examples and pseudocode, but does not implement the complete solution.
- **Execution Assistant:** works on one approved Stage. It picks up the Stage's
  complete Design, then produces its Execution Plan and Jobs.
- **Implementation Assistant:** normally works on one authorized Stage. It
  reads that Stage's Execution documentation, launches the required
  implementation and review agents, reports state to the user, and only
  relaunches or fixes work at the user's direction.
- **Worker agent:** executes one Job in the target repository
  and records its outcome.
- **Review agent:** reviews a Stage's Job reports and repository changes
  against the Execution documentation. It is instructed to be read-only and
  reports its findings to the Implementation Assistant.

## Session Lifecycle

Every SANE Alpha session is started by the user and follows this lifecycle:

1. **User starts the session.** The user identifies the workstream, Phase, and,
   when relevant, Stage to work on.
2. **Assistant ingests context.** The assistant receives the shared SANE
   context, its role context, and the role skill that it must use for the
   session.
3. **Assistant performs pickup.** The assistant checks that the inputs required
   for its role exist.
4. **Assistant reports readiness.** The assistant reports its pickup result and
   a concise summary of the selected workstream, assigned scope, relevant State,
   and any missing inputs or blockers. It then waits; it does not begin role
   Assistance merely because the user started the session.
5. **User resolves pickup status or authorizes Assistance.** The user may return
   to an earlier role for Updates, resolve a missing input in another way, add
   session details, or explicitly authorize the assistant to proceed.
6. **Assistant performs its role.** The assistant helps the user produce its
   assigned outcome. This may involve back-and-forth with the user.
7. **Assistant performs delivery.** The assistant checks that the files and
   artifacts it owns are present and complete, then reports delivery to the
   user.

Pickup verifies the inputs needed to begin the role. Delivery verifies only the
outputs that the role owns.

Delivery completes the assistant's current action. The assistant must not
presume that a later user response—or no response—is approval. After delivery,
it expects either a request for Updates or an explicit user approval.

When the user requests **Updates**, the responsible assistant applies the
requested update and then performs an **Updates Delivery**: it verifies that
the changed artifacts it owns are present and complete. An Update
does not repeat the full session lifecycle unless the change introduces new
required inputs.

## User Authority and Collaboration

The user governs every transition in SANE Alpha. The user chooses the scope and
role for each session, starts sessions, resolves pickup failures, owns
decisions, and alone approves, redirects, or stops work.

The user approval gates are:

- Research readiness;
- root Design;
- Design for each Stage; and
- the Execution Plan for each Stage.

An assistant cannot self-approve. After its delivery, it asks for and waits for
an explicit user approval or Updates. When the user approves its
delivery, that assistant records the approval in the workstream's state-tracking
file. The user may update that file directly instead.

Delivery makes an assistant's output available for handoff; it does not start a
new session or transfer control. The user starts the next role, identifies its
scope, and directs it to pick up the relevant delivered work.

## Alpha Execution Model


After the user approves a Stage Execution plan, the user starts a
Stage-scoped Implementation Assistant and asks it to run the authorized Jobs.
The user does not separately authorize every Job in that approved plan.

Execution and repository implementation proceed sequentially by Stage. An
Implementation Assistant runs the Job Groups in its authorized Stage in their
Execution-plan order. Jobs within the same Job Group may run in parallel; the
coordination harness launches their worker in parallel.

After each Job Group, the Implementation Assistant launches one review
agent. That agent is instructed to be read-only and reviews the Job Group's
reports and repository changes against its Jobs and Stage Execution plan. It
may produce findings, but it does not make changes or accept work. The
Implementation Assistant reports the implementation and review state to the
user, who decides whether to proceed or request Updates.

## Agent Context Model

Every SANE workstream receives a `SANE_CONTEXT.md` file created from the Alpha
agent-context template. It provides the shared orientation for every role that
works in that workstream.

Agent configuration provides a short, role-specific introduction: who the agent
is, the outcome it helps the user create, and which role skill it must use. It
does not repeat the full SANE model.

The role skill contains most role-specific instructions, boundaries, and
repeatable procedure. It applies the shared SANE model to that role without
redefining it.

The assigned workstream artifacts provide the active session's concrete scope.
They identify the relevant workstream, Phase, Stage, Job, decisions, and
outcomes needed for pickup and delivery.

Worker and review agents receive an explicit prompt that tells
them to read their implementation skill and the relevant Job and context
materials. Their prompts provide only the context needed for their assigned
implementation or review work.
