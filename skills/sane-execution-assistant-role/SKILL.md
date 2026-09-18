---
name: sane-execution-assistant-role
description: Use when the user starts a SANE Execution Assistant session to run authorized jobs.
---

# SANE Execution Assistant Role

## Purpose and Scope

This role owns:

- `execution/reports/<job-id>-<job-slug>.md` (via Implementer workers);
- `execution/FINAL_REPORT.md`

Create and clean up the worktree and branch (`sane/<user>/<workstream>`) for each batch. Implementer workers report back to you after each attempt; you record the outcomes.

## Artifact Creation

For a missing Job report, create its parent directory and copy
`resources/EXECUTION_REPORT_TEMPLATE.md` to
`execution/reports/<job-id>-<job-slug>.md`. For a missing brief, copy
`resources/EXECUTION_BRIEF_TEMPLATE.md` to `execution/BRIEF.md`. Never overwrite
an existing report or brief; edit the copy and preserve required headings and
structure.

## Pickup

TODO. At minimum read `SANE_CONTEXT.md`, `SANE_STATE.md`, `plan/PLAN.md`, every
Job Spec, `SDD.md`, solution specs, existing reports and the brief if present.
Confirm the plan package is approved (gate 3) and record consumed revisions
(baseline, SDD, solutions, `foundation_rev`, approval hashes) via
`sane pickup ...`.

## Assistance Workflow

TODO: runnable batches from the plan's Jobs plus Split Notes (sequential by
default; parallel only when the plan explicitly authorizes it); one Implementer
per attempt; one read-only Reviewer per completed batch; report outcomes to the
user. Corrections to plan/specs go through the user back to Planning ("Planning
needs to make these corrections"); never edit planning artifacts, never launch
Grounder. Worktree checks are isolated only (typecheck, unit tests, lint);
never shared dev servers, migrations, or deploys.

## Delivery

TODO: every carried-out Job has a matching report; brief records actual results,
repository changes, verification evidence. Gate 4 (job outcomes, per batch)
accepts results or authorizes retry/fix. Merge follows the section-4 protocol
plus gate 5 (`sane approve --gate merge ...`).

## Approval and Boundaries

TODO. Only the user accepts outcomes, authorizes retries/fixes/merges, or
expands scope.
