---
name: planning-workstreams
description: Create and prepare workstreams for execution. Planning only, no code implementation.
---

# Planning Workstreams

## Scope

- Planning only.
- Do not implement code.
- Keep plan and tasks concrete, short, and executable.

## Workflow

1. Create draft stream: `work create --name "feature-name"`
2. Set current stream: `work current --set "NNN-feature-name"`
3. Fill `REQUIREMENTS.md` and add supporting files under `resources/`.
4. Validate requirements: `work validate requirements`
5. Scaffold stages: `work plan create --stages N`
6. Fill `PLAN.md` with stages, batches, threads, and stage questions.
7. Validate before review:
   - `work validate plan`
   - `work check plan`
   - `work preview`
8. Ask user to approve plan: `!work approve plan`
9. Fill generated `TASKS.md` with specific tasks and agent assignments.
10. Ask user to approve tasks: `!work approve tasks`
11. Link planning session using `workstream_link_planning_session`.

## Supervision Branch

After tasks are approved by the user, the planner can start execution by calling `workstream_launch_supervision_branch`.

- Use the tool from the Root Agent/planner session to launch a supervision branch agent.
- Prefer stage scope unless you intentionally want batch-bounded supervision.
- The branch agent handles the automated supervision workflow.
- You inspect the branch output, review the persisted evidence if needed, and report the result back to the user.

Notes:
- `REQUIREMENTS.md` is the human-facing source of truth for summary, deliverables, dependencies, and resource inputs.
- `REQUIREMENTS.md` is required before planning starts.
- `work validate requirements` must pass before scaffolding or reviewing the execution plan.
- If requirements are missing or incomplete, stop and ask the user to provide them, or help the user draft `REQUIREMENTS.md` first.
- Do not use `work create --name "feature-name" --stages N` in the planning workflow; requirements-first planning is the only supported workflow for agents.
- `work validate plan` warns but succeeds for empty draft plans.
- `work approve plan` requires at least one stage.

If planning changes after an existing stage is reviewed, you can add a revision either at the end with `work revision --name "topic"` or immediately after a specific stage with `work revision --name "topic" --after-stage 3`.

## Planning Rules

- No planning without validated requirements.
- Do not scaffold or edit `PLAN.md` until `work validate requirements` passes.
- Treat `PLAN.md` summary as the current planning-state/horizon note.
- When the plan is intentionally partial, the summary should say: (1) what is planned now, (2) what is intentionally deferred, and (3) what finding or event unlocks more planning.
- If you add, remove, or substantially change stages, update the `## Summary` text so it matches the current planning horizon and scope boundary.
- If uncertainty materially affects downstream implementation, prefer a research/discovery-first stage and keep later stages out of the plan until findings are known.
- Prefer independent threads in the same batch.
- Keep tasks small and observable.
- Use clear file paths and concrete outputs.
- Put unresolved decisions in Stage Questions (`- [ ] ...`).

## Asking Questions

- If you have questions during planning, use the opencode `question` tool. Mark all questions as open first, then ask the user, and fill with the responses afterwards.
- The tool supports asking multiple questions in one call via the `questions` array; use this when collecting related inputs together.
- For each question, provide exactly one predefined option labeled as recommended.
- Keep `custom` enabled so the user can type their own answer (open response).

## Useful Commands

```bash
work create --name "feature-name"
work current --set "001-feature-name"
work validate requirements
work plan create --stages 3
work edit
work preview
work validate plan
work check plan
!work approve plan
!work approve tasks
work revision --name "post-stage-review" --after-stage 3
work agents
work assign --thread "01.01.01" --agent "backend-expert"
work prompt --stage 1 --batch 1
```
