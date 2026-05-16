---
name: planning-workstreams
description: Create and prepare workstreams for execution. Planning only, no code implementation.
---

# Planning Workstreams

## Scope

- Planning only.
- Do not implement code.
- Keep the plan concrete, short, and executable.

## Workflow

1. Create and set stream: `work create --name "feature-name"` and `work current --set "NNN-feature-name"`
2. Work on the root `README.md` along with the user so it captures the overall workstream context, deliverables, dependencies, and shared resources. Add supporting files under `resources/`.
3. Scaffold stages: `work plan create --stages N`. This will create stage directories under `stages/`.
4. Fill each stage's `REQUIREMENTS.md`, `PLAN.md`, `WORK.md`, and `specs/`. Treat stage `WORK.md` as shared stage guidance, not the primary worker doc.
5. Validate before review:
   - `work validate plan`
   - `work check plan`
   - `work preview`
6. Ask user to approve plan: `!work approve plan`
7. Link the planning session using `link_planning_session` once the plan is ready for handoff.

Notes:
- Root `README.md` is the human-facing source of truth for shared summary, deliverables, dependencies, and resources.
- Stage-local `REQUIREMENTS.md` files capture stage-specific acceptance criteria and inputs.
- Stage-local `WORK.md` files capture shared stage guidance; the primary worker doc is `stages/<stage>/threads/<thread-id>/WORK.md`, generated after plan or revision approval.
- If shared root context is missing or incomplete, stop and ask the user to provide it, or help the user draft the root `README.md` first.

## Planning Rules

- No planning without a clear root `README.md`.
- Do not scaffold or edit stage-local plans until the root `README.md` captures the shared goal and constraints.
- Treat each stage `PLAN.md` summary as that stage's current planning-state/horizon note.
- When the plan is intentionally partial, the summary should say: (1) what is planned now, (2) what is intentionally deferred, and (3) what finding or event unlocks more planning.
- If you add, remove, or substantially change stages, update the `## Summary` text so it matches the current planning horizon and scope boundary.
- If uncertainty materially affects downstream implementation, prefer a research/discovery-first stage and keep later stages out of the plan until findings are known.
- Prefer independent threads in the same batch.
- Keep thread scope concrete and observable.
- Use clear file paths and concrete outputs.
- Put unresolved decisions in Stage Questions (`- [ ] ...`).

## Asking Questions

- If you have questions during planning, use the opencode `ask` tool. Mark all questions as open first, then ask the user, and fill with the responses afterwards.
- Keep `custom` enabled so the user can type their own answer (open response).

## Useful Commands

```bash
work create --name "feature-name"
work current --set "001-feature-name"
work plan create --stages 3
work edit
work preview
work revision --name "post-stage-review" --after-stage 3
work agents # list agents
work assign --thread "01.01.01" --agent "backend-expert"
work prompt --stage 1 --batch 1
```
