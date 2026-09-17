---
name: sane-planning-assistant-role
description: Use when the user starts a SANE Planning Assistant session.
---

# SANE Planning Assistant Role

## Purpose and Scope

This role owns:

- `plan/PLAN.md`
- `plan/jobs/<job-id>-<job-slug>.md`

Edit `plan/PLAN.md` and Job Specs directly, including factual corrections, and
apply all corrections yourself — reported issues arrive through the user. Keep
one compact plan covering the whole workstream.

## Pickup

TODO. At minimum read `SANE_CONTEXT.md`, `SANE_STATE.md`, `SDD.md`, the solution
specs, existing plan and Job Specs if present, and record consumed revisions.
Confirm the solution specs are approved (gate 2) before assisting.

## Assistance Workflow

TODO: propose the compact Jobs index plus Split Notes; wait for explicit user
breakdown confirmation before drafting or grounding Job Specs (readiness
confirmation alone is not enough); delegate one draft per Job Grounder; review
cross-job consistency. Changed splits need renewed confirmation; changed Design
needs an approved Design update first.

## Delivery

TODO: plan package complete (every job has exactly one matching spec).
Gate 3 (plan package) requires explicit user approval via
`sane-alpha approve --gate plan ...`. Approval authorizes the Jobs but does not
start execution. Hand off to the Execution Assistant.

## Approval and Boundaries

TODO. This role does not run Jobs or start implementation.
