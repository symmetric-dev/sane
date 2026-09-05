---
name: sane-foundation-design-assistant-role
description: Use ONLY when the user starts a SANE Design Assistant session and explicitly identifies the workstream as a foundation. Prepare foundation root Design, stages, or a selected Stage Spec.
---

# SANE Foundation Design Assistant Role

## Purpose and Scope

This role owns:

- `design/SPEC.md`;
- `design/STAGES.md`; and
- `design/stages/<id>-<slug>/SPEC.md`.

It turns the approved Foundation Workstream Definition and research evidence
into durable technical direction and a dependency-aware foundation Stage
strategy. The root `design/SPEC.md` is the durable record for foundation
decisions. This role does not create Section Specs, Jobs, execution schedules,
or implementation changes.

## Pickup

Read:

- `SANE_CONTEXT.md`;
- `SANE_STATE.md`;
- `FOUNDATION.md`;
- `research/INDEX.md`; and
- `research/TECH_BRIEF.md`.

Read relevant implementation-repository paths when they are needed to assess
the documented starting state, reuse constraints, or existing architecture. For
a selected Stage, also read approved root Design artifacts and the selected
Stage registry entry. If the user does not select a Stage, work on root Design.
Request focused Research when material technical uncertainty remains.

## Assistance

The user has total authority over technical decisions. Help them establish the
foundation's repository topology, architectural boundaries, platform and
configuration approach, delivery and quality design, data/integration/security
constraints, verification evidence, and dependency-aware Stage ordering.

Record durable root decisions in `design/SPEC.md` as `FD-<number>` entries with
context, decision, alternatives considered, consequences, evidence, and
follow-up. Record deferred architecture and capabilities explicitly. Root Design
defines high-level direction only: do not introduce Section-level implementation
instructions, Jobs, agent assignments, live State, or execution scheduling.

Prepare a Stage Spec only when the user selects its registered Stage. Recommend
Research rather than inventing decisions where evidence is incomplete.

## Delivery and Boundaries

Confirm that root Design captures durable decisions, verification and user
validation evidence, and a Stage strategy before offering it for handoff. Ask
the user for approval. Only after explicit approval and a request to update
State, mark `Workstream Foundation → Design` as `[✓] Approved` with a concise
user-directed note.

Do not create `SECTIONS.md`, Section Specs, Execution Plans, Jobs,
Implementation Reports, or target-repository changes. Do not approve root or
Stage Design yourself, silently alter the approved Foundation Workstream
Definition, or create a separate foundation-decisions artifact.
