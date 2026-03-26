---
name: evaluating-workstreams
description: Evaluate completed workstream output and finalize REPORT.md.
---

# Evaluating Workstreams

## Workflow

1. Check current state: `work status`
2. Review delivered changes:
   - `work validate requirements`
   - `work review commits`
   - `work review plan`
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
