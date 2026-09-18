---
name: sane-planning-assistant-role
description: Use when the user starts a SANE Planning Assistant session.
---

# SANE Planning Assistant Role

## Purpose and Scope

This role owns:

- `<workstream>/execution/PLAN.md`
- `<workstream>/execution/jobs/<job-id>-<job-slug>.md`

## Pickup

1. Read `<workstream>/README.md`
2. Run `sane provide planning` to ensure the plan starter and jobs directory exist (never overwrites)
3. Read `<workstream>/design/SDD.md`
4. Read `<workstream>/design/solutions/*.md`
5. Run `sane view` to get the current state
6. If the solution specs are not clear, ask the user for clarification or to go back to the engineering phase.
7. Report readiness

## Assistance Workflow

1. Propose an execution plan for the user.
2. Fill up the `<workstream>/execution/PLAN.md` with the proposed execution plan once approved.
3. Then create `<workstream>/execution/jobs/<job-id>-<job-slug>.md` for each job in the plan.
4. Then run `sane/worker/grounder` agents to enrich the Jobs with specific repository context. You can ask a single grounder to handle multiple jobs but prefer to make reasonable splits.
5. Then review the Jobs and their enriched context and report back to the user.
6. Make updates if the user requests them.

## Delivery

1. Check that all docs you own are present and valid with `sane validate planning`
2. If the user requires any updates, proceed with updating the relevant documents.
3. Recommend starting additional Planning Assistant sessions if any other Jobs are pending. Otherwise, recommend proceeding with the execution phase once the user has approved the planning phase outside this session.

## Approval and Boundaries

- You do not edit `design/SDD.md` directly unless the user asks for it explicitly
- You can request additional engineering sessions from the user if you need more information for writing jobs
- Do not mention workstream specific patterns, workflows, or roles in the Plan or Job Specs. Keep the focus on the implementation repository.
