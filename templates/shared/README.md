# SANE Context

## SANE

SANE means **Sane Agentic Noesis Edifice**. It is a structured, reasonable, and agile way for people and agents to acquire and apply knowledge in service of deliberate change.

A **workstream** groups the documents and state for an undertaking. Its documents describe current requirements, solutions, and outcomes; the CLI and sessions hold progress, approvals, and collaboration history. Implementation happens in the target repository, not in a separate duplicate tree.

The user directs the work and makes decisions with the assistant. Follow your
role's skills for the assigned work and coordination with other sessions.

There are 2 types of agents: **Assistants**, and **Workers**. Assistants work directly with the user while workers can be run by assistants to perform tasks.

You shall never talk about or reference workstream specific language or workflow in the implementation repository contents. Keep the meta-language separate from the implementation repository.

## Context

**Knowledge Gaps** are missing understanding needed to make a product,
design, or implementation decision—for example, how a feature should
behave or how a dependency integrates with the solution. They are often
visible in Design and Engineering documents.

**Operational Gaps** are missing procedures, tooling, or repository
context needed for agents to carry out assigned work—for example, how a
worker locates relevant code, prepares the environment, runs verification,
or updates artifacts. They are often visible in Planning and Execution
documents.

**Context Artifacts** preserve reusable knowledge and operational guidance
for future work. Skills and documentation are examples; the term is
independent of how that context is represented or stored.

## Lifecycle

Workstreams have a Main Track and Support Tracks.

The Main Track follows four phases: Design → Engineering → Planning → Execution.

Support Tracks may run alongside the Main Track to help resolve Knowledge Gaps and Operational Gaps along the way.

## State

View current status with `sane view` and use the CLI to record state.

1. **Pickup:** at new session start, read the assigned context and check required
   inputs. Confirm readiness and wait for the user to proceed, including when
   the session starts from a handoff.
2. **Assistance:** work with the user within the agreed scope. This may include
   handoff or handling updates from other sessions, following your role's skill.
3. **Delivery:** check outputs, present them for review, and obtain the applicable
   user approval. The user records phase approval with `sane approve <phase>`,
   which validates first. Delivery may include handoff when the user requests it.
   If revisions are requested, return to Assistance and then Delivery.

## State Statuses

- `pending` — Not started or not approved.
- `in_progress` — Session is in progress.
- `approved` — User explicitly approved the tracked outcome.
