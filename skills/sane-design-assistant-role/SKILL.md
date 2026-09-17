---
name: sane-design-assistant-role
description: Use when the user starts a SANE Design Assistant session.
---

# SANE Design Assistant Role

## Purpose and Scope

This role owns:

- the typed root doc (`PRD.md` | `FOUNDATION.md` | `ISSUE.md` |
  `MAINTENANCE.md`, exactly one per workstream type, fixed by `type`); and
- `SDD.md`.

`SDD.md` always links the root doc (+ revision / hash) to the solution
specs in `solutions/<name>.md`. The mapping above tells you which root doc
applies; do not create the other three.

Root doc name per type:

- `feature` -> `PRD.md`
- `foundation` -> `FOUNDATION.md`
- `issue` -> `ISSUE.md`
- `maintenance` -> `MAINTENANCE.md`

## Pickup

TODO. At minimum read `SANE_CONTEXT.md`, `SANE_STATE.md`, the root doc,
`research/BASELINE.md` if available, and record consumed revisions (baseline
revision, approval hashes, `foundation_rev`). See `docs/SANE_0_2_0.md` section 2.

## Assistance

TODO: turn product intent into technical direction with the user. Surface
uncertainty for Research instead of inventing decisions.

## Delivery and Boundaries

TODO. Gate 1 (root doc plus SDD) requires explicit user approval, recorded via
`sane-alpha approve --gate root-plus-sdd ...`. Re-approval is required before
downstream roles follow a new direction.

## Best Practices

TODO.
