---
name: creating-workstream-plans
description: Create implementation-ready workstream plans from known scope or preparation findings; use to scaffold stages, requirements, batches, and thread contracts for execution handoff.
---

# Creating Workstream Plans

## Model

A workstream plan is an execution handoff for implementation agents.

Planning-only describes this session, not the future workstream. Do not implement code now; do create future implementation stages and thread contracts.

## Workflow

1. Create or select the workstream:
   - `work create --name "feature-name"`
   - `work current --set "NNN-feature-name"`
2. Fill root `README.md` with shared goal, context, deliverables, dependencies, and resources.
3. Scaffold stages: `work plan create --stages N`.
4. Fill each stage's `REQUIREMENTS.md`, `PLAN.md`, and `specs/` as needed.
5. Validate before review:
   - `work validate plan`
   - `work check plan`
   - `work preview`
6. Ask user to approve plan: `!work approve plan`.
7. After approval, review and fill generated thread `WORK.md` files before execution starts.
8. Assign agents with `work assign --thread "01.01.01" --agent "agent-name"` if needed.
9. Link the planning session with `link_planning_session` once ready for handoff.

## Stage and Thread Rules

- Stages should describe future implementation or automated validation work, not more planning.
- Avoid stages whose main output is to research, decide, define, or plan. Keep that work in preparation docs unless one specific unknown blocks all implementation planning.
- `stages/<n>/PLAN.md` is orchestration context.
- `stages/<n>/threads/<thread-id>/WORK.md` is the primary implementation contract.
- Keep thread scope concrete, observable, and assigned to one implementation agent.
- Put unresolved blocking decisions in stage Questions (`- [ ] ...`).

## Verification Boundary

All execution is performed by implementation agents.

Plans may include automated checks agents can run directly: tests, typechecks, linters, or narrow scripted/e2e workflows. Do not include manual user verification, visual review, subjective UX acceptance, or unscripted end-to-end flow review as stages, threads, `Done When`, or `Verify` criteria.

If manual validation is needed, record it as user-owned follow-up outside the workstream.

## Handoff Checklist

- Root `README.md` is concrete.
- Stages are implementation-oriented.
- Same-batch threads are truly parallelizable.
- Thread `WORK.md` files have concrete `Done When`, `Files to Know`, `Verify`, `Locked Decisions`, `Not In Scope`, and `If Blocked` sections.
- Verification is agent-runnable and automated unless a specific automated workflow is provided.
