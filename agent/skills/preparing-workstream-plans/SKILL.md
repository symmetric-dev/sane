---
name: preparing-workstream-plans
description: Prepare workstream plans by researching uncertainty before stage planning; use when scope, constraints, risks, or direction are not clear enough to create an implementation plan.
---

# Preparing Workstream Plans

## Model

Preparation resolves uncertainty so planning can start. It does not create stages, batches, threads, or implementation work.

Output from this phase should answer: what should the future implementation plan do?

## Workflow

1. Create or select the workstream:
   - `work create --name "feature-name"`
   - `work current --set "NNN-feature-name"`
2. Capture the research goal and current understanding in root `README.md`.
3. Store raw inputs under `resources/` and synthesized findings under `docs/`.
4. Use research subagents when parallel discovery is useful; tell them where to write findings.
5. Stop preparation when direction, constraints, risks, and remaining blockers are clear enough for planning.

## Handoff to Planning

Before switching to `creating-workstream-plans`, summarize:

- recommended implementation direction
- constraints and locked decisions
- unresolved blockers, if any
- relevant `docs/` and `resources/` files
- any manual/user validation needs, clearly marked as user-owned and outside agent execution

Do not create discovery stages just to continue researching. If research is still needed, keep it in this preparation phase.
