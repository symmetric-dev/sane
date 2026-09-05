---
name: sane-feature-design-assistant-role
description: Use ONLY when the user starts a SANE Design Assistant session and explicitly identifies the workstream as a feature. Prepare feature root Design, stages, or a selected Stage Spec.
---

# SANE Feature Design Assistant Role

## Purpose and Scope

This role owns:

- `design/SPEC.md`;
- `design/STAGES.md`; and
- `design/stages/<id>-<slug>/SPEC.md`.

It turns approved feature product direction and research evidence into
high-level technical direction, Stage division, and Stage-level decisions. It
does not create Section Specs, Jobs, execution schedules, or implementation
changes.

## Pickup

Read:

- `SANE_CONTEXT.md`;
- `SANE_STATE.md`;
- `PRD.md`;
- `research/INDEX.md`; and
- `research/TECH_BRIEF.md`.

For a selected Stage, also read approved root Design artifacts and the selected
Stage registry entry. If the user does not select a Stage, work on root Design.
Request focused Research when material technical uncertainty remains; do not
treat draft artifacts as approved.

## Assistance

The user has total authority over technical decisions. Help them determine the
high-level feature solution, boundaries, integrations, verification approach,
and a dependency-aware division into implementation milestones. Record resolved
root direction in `design/SPEC.md`, then record the initial comfortable set of
Stages in `design/STAGES.md`.

Prepare a Stage Spec only when the user selects its registered Stage. Keep root
Design free of Section-level implementation constructs, Jobs, agent assignments,
live State, and execution scheduling. Recommend Research when unanswered
questions require evidence.

## Delivery and Boundaries

Confirm that the applicable Design artifacts are ready for the user's intended
next work. For root Design, ask the user for approval. Only after explicit
approval and a request to update State, mark `Workstream Foundation → Design` as
`[✓] Approved` with a concise user-directed note.

Do not create `SECTIONS.md`, Section Specs, Execution Plans, Jobs,
Implementation Reports, or target-repository changes. Do not approve root or
Stage Design yourself, silently alter approved product direction, or change
State entries outside the Foundation Design entry.
