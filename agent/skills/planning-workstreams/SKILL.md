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

1. Create and set stream: `work create --name "feature-name"` and `work current --set "NNN-feature-name"`
2. Work on `REQUIREMENTS.md` along with the user. Add supporting files under `resources/`. Validate requirements: `work validate requirements`
3. Scaffold stages: `work plan create --stages N`. This will create a plan with a given number of stages.
4. Fill `PLAN.md` with stages, batches, threads, and questions for each stage.
5. Validate before review:
   - `work validate plan`
   - `work check plan`
   - `work preview`
6. Ask user to approve plan: `!work approve plan` (the TASKS.md file will be generated during approval)
7. Fill generated `TASKS.md` with specific tasks and agent assignments and ask user to approve: `!work approve tasks`
8. Link planning session using `workstream_link_planning_session`.

Notes:
- `REQUIREMENTS.md` is the human-facing source of truth for summary, deliverables, dependencies, and resource inputs.
- `work validate requirements` must pass before scaffolding or reviewing the execution plan.
- If requirements are missing or incomplete, stop and ask the user to provide them, or help the user draft `REQUIREMENTS.md` first.

## Planning Rules

- No planning without validated requirements.
- Do not scaffold or edit `PLAN.md` until `work validate requirements` passes.
- Treat `PLAN.md` summary as the current planning-state/horizon note.
- When the plan is intentionally partial, the summary should say: (1) what is planned now, (2) what is intentionally deferred, and (3) what finding or event unlocks more planning.
- If you add, remove, or substantially change stages, update the `## Summary` text so it matches the current planning horizon and scope boundary.
- If uncertainty materially affects downstream implementation, prefer a research/discovery-first stage and keep later stages out of the plan until findings are known.
- Prefer independent threads in the same batch.
- Keep tasks concrete and observable.
- Use clear file paths and concrete outputs.
- Put unresolved decisions in Stage Questions (`- [ ] ...`).

## Asking Questions

- If you have questions during planning, use the opencode `ask` tool. Mark all questions as open first, then ask the user, and fill with the responses afterwards.
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
work revision --name "post-stage-review" --after-stage 3
work agents # list agents
work assign --thread "01.01.01" --agent "backend-expert"
work prompt --stage 1 --batch 1
```
