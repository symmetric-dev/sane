---
name: planning-work
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
4. Fill each stage's `REQUIREMENTS.md`, `PLAN.md`, and `specs/`.
5. Validate before review:
   - `work validate plan`
   - `work check plan`
   - `work preview`
6. Ask user to approve plan: `!work approve plan`
7. After approval, generated thread `WORK.md` files become the primary worker docs. Review and fill them before execution starts.
8. If the execution handoff should target specific agents, assign them explicitly with `work assign --thread "01.01.01" --agent "frontend-expert"`.
9. Link the planning session using `link_planning_session` once the plan is ready for handoff.

## Document hierarchya

- `README.md` = overall workstream context
- `stages/<n>/REQUIREMENTS.md` = stage constraints and acceptance criteria
- `stages/<n>/PLAN.md` = orchestration only
- `stages/<n>/threads/<thread-id>/WORK.md` = primary worker contract

Notes:
- Root `README.md` is the human-facing source of truth for shared summary, deliverables, dependencies, and resources.
- Stage-local `REQUIREMENTS.md` files capture stage-specific acceptance criteria and inputs.
- Give each stage `PLAN.md` a meaningful H1 title (for example `# Stage 01 Discovery Plan`) so downstream tools preserve the stage name.
- The primary worker doc is `stages/<stage>/threads/<thread-id>/WORK.md`, generated after plan or revision approval.
- Agent assignment is runtime thread metadata set with `work assign` (or `work update --agent`), not inline `@agent:` markers in `PLAN.md` or `WORK.md`.
- If shared root context is missing or incomplete, stop and ask the user to provide it, or help the user draft the root `README.md` first.

## Planning Rules

- No planning without a clear root `README.md`.
- Do not scaffold or edit stage-local plans until the root `README.md` captures the shared goal and constraints.
- Treat each stage `PLAN.md` summary as that stage's current planning-state/horizon note.
- When the plan is intentionally partial, the summary should say: (1) what is planned now, (2) what is intentionally deferred, and (3) what finding or event unlocks more planning.
- If you add, remove, or substantially change stages, update the `## Summary` text so it matches the current planning horizon and scope boundary.
- If uncertainty materially affects downstream implementation, prefer a research/discovery-first stage and keep later stages out of the plan until findings are known.
- Only put threads in the same batch when they are truly parallelizable. If threads mostly touch the same file or state machine, prefer more serial batches instead of fake parallelism.
- Keep thread scope concrete and observable.
- Use clear file paths and concrete outputs.
- Put unresolved decisions in Stage Questions (`- [ ] ...`).

## Thread `WORK.md` quality bar

Before handoff, every thread `WORK.md` should have concrete content for:

- `Done When`
- `Files to Know` (`READ`, `ALLOWED`, `FORBIDDEN`)
- `Verify`
- `Locked Decisions`
- `Not In Scope`
- `If Blocked`

If structure, state, or interaction could be interpreted multiple ways, add a short `Implementation Sketch` inside the thread `WORK.md`. Keep it lightweight: state shape, layout sketch, or interaction flow only.

## Planning handoff checklist

- Root `README.md` is concrete.
- Each stage `PLAN.md` has a meaningful title, not just `Stage 01 Plan`.
- Same-batch threads are truly parallelizable.
- Generated thread `WORK.md` files are reviewed and filled after approval.
- Thread boundaries and verification commands are explicit.
- Agents are assigned with `work assign` if the handoff is agent-specific.

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
work update --thread "01.01.01" --agent "backend-expert" --status in_progress
work prompt --stage 1 --batch 1
```
