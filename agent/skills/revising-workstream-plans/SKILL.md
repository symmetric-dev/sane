---
name: revising-workstream-plans
description: Revise approved workstream plans after implementation has started; use when management escalates blocked work, scope changes, or follow-up implementation planning back to the planner.
---

# Revising Workstream Plans

## Model

Revision is planner re-entry after implementation has started.

Use this when the approved plan no longer matches the work needed. Do not silently rewrite approved scope; create an explicit revision for material changes.

## Inputs

Start from implementation evidence:

- manager final reports
- blocked thread reports
- review findings
- current `work status`, `work tree`, and relevant batch/thread state
- affected `WORK.md`, stage `REQUIREMENTS.md`, stage `PLAN.md`, and root `README.md`

## Decision Rule

- Batch-local, engineering-owned, agent-verifiable correction: belongs to `managing-workstream-implementation` fix cycle.
- Changed requirements, sequencing, new batches/threads, or new implementation stage: revise the plan.
- Product-direction change or scope beyond the workstream goal: recommend a separate workstream.
- Manual user verification, visual review, subjective UX acceptance, or unscripted e2e review: user-owned follow-up, not agent work.

## Workflow

1. Inspect current workstream state and the escalation evidence.
2. Decide whether revision is needed or whether management should handle it.
3. If revision is needed, create a revision with a clear name and boundary, for example:

```bash
work revision --name "post-stage-review" --after-stage 2
```

4. Add or update only the stages, batches, threads, requirements, and specs needed for the revision.
5. Keep new work implementation-oriented and agent-runnable.
6. Validate before handoff:
   - `work validate plan`
   - `work check plan`
   - `work preview`
7. Ask user to approve the revision when ready.
8. Use `handoff-workstream-implementation` to prepare the next management-agent prompt.

## Guardrails

- Do not implement code.
- Do not reopen completed scope unless the escalation evidence requires it.
- Do not add planning/research stages unless a specific unknown blocks implementation planning.
- Do not include manual validation as `Done When` or `Verify` criteria.
- Prefer the smallest revision that restores an executable implementation path.
