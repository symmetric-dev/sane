---
name: researching-work
description: Create a workstream for research-first exploration, gather findings into the workstream, and decide when specs or planning are needed.
---

# Researching Work

## Scope

- Research only.
- Do not scaffold stages or write implementation plans until the research phase is understood.
- Use this when the user wants investigation, discovery, analysis, or exploration for a future workstream.

## Workflow

1. Create the workstream container only:
   - `work create --name "feature-name"`
   - `work current --set "NNN-feature-name"`
2. Do **not** run `work plan create` yet.
3. Capture the research goal in the root `README.md`.
4. Create or update supporting files under:
   - `resources/` for gathered inputs, references, and source material
   - `docs/` for synthesized research notes, comparisons, options, or findings
5. Depending on the user request, either:
   - start research immediately via one or more subagents, or
   - wait for more user direction before researching.
6. When research completes, summarize what is now understood and ask whether specs are needed before planning begins.

## Research model

During research-only workstreams, the hierarchy is intentionally simple:

- `README.md` = research goal, scope, and current understanding
- `resources/` = raw gathered inputs and references
- `docs/` = interpreted findings and recommendation notes

No stages, no thread `WORK.md`, and no execution planning until the research is mature enough.

## Using subagents

When you launch research subagents:

- tell them where to place outputs
- prefer `docs/` for synthesized findings
- prefer `resources/` for raw source material or collected references
- split research by topic when it helps parallelize discovery safely

Examples:

- architecture options -> `docs/architecture-options.md`
- UI references or screenshots -> `resources/ui-references.md`
- API behavior investigation -> `docs/api-research.md`

## After research completes

Before moving into planning, determine whether specs are needed.

Ask whether the next step should include any of:

- implementation specs for risky or detailed work
- architecture specs for broader system changes
- UI specs for layout, interaction, or visual behavior
- no specs, if the work is already clear enough to move directly into staged planning

Once the user and agent both understand the work well enough:

1. decide whether specs are needed and where they should live
2. then begin normal planning with `work plan create --stages N`

## Guardrails

- Do not create stages just because a workstream exists.
- Do not invent a plan before the research is understood.
- Keep research outputs organized so later planning can reference them cleanly.
- If the user is still shaping the problem, prefer waiting over premature planning.
