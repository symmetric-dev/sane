---
name: evaluating-workstreams
description: Evaluate completed workstream output and finalize REPORT.md.
---

# Evaluating Workstreams

## Model

Evaluation closes a workstream after implementation is complete or intentionally stopped.

It summarizes delivered work, deviations, unresolved issues, and whether follow-up belongs in a revision stage or separate workstream. It does not perform implementation, management, or manual user acceptance.

## Workflow

1. Check current state: `work status`
2. Review delivered changes:
   - `work validate requirements`
   - `work review commits`
   - `work review plan`
   - relevant thread reports and final thread `WORK.md` expectations
3. Ensure report exists: `work report init` (if missing)
4. Fill `REPORT.md` with:
   - summary
   - accomplishments by stage
   - file references
   - issues/blockers
   - next steps
5. Validate: `work report validate`

## Quality Bar

- Report reflects what was actually delivered.
- Open issues are explicit and actionable.
- Next steps are concrete and prioritized.
- If a stage/thread deviated from its `WORK.md`, note that explicitly.
- If follow-up work is needed, say whether it should be a revision stage or a separate workstream.
