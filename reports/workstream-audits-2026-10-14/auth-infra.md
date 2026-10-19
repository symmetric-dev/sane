# auth-infra — workflow-process audit (2026-10-14)

Target: youngest FOUNDATION workstream (created 2026-10-13). Read-only; headers/first-15-lines only, no bodies quoted.

## Phase flow

- On disk: FOUNDATION.md present (substantive, multi-paragraph overview header). Design: SDD (~568 lines) + 8 solution specs (~282–630 lines each). Research: 2 REPORTs on disk, both registered in DB.
- Planning artifacts exist while `planning=pending`: PLAN.md substantive (lists 8 jobs + split notes) + 8 job specs on disk (60–73 lines, 8–13 KB each). `execution=pending` yet 4 verification specs on disk (16–28 lines, 4.5–7.4 KB each, full job coverage 01–08).
- DB `phase_states`: design=approved (rev 4), engineering=approved (rev 1), planning=pending, execution=pending. Flow is sequential so far; planning work is staged ahead of its approval gate.

## Handoff/job health

- Handoffs: 11/11 completed, 0 failed/open (`status != 'completed'` count = 0). No stuck queue.
- Jobs table: 0 rows for this workstream vs 8 substantive specs on disk — confirmed spec-before-registration gap.
- Cause is structural, not loss: `jobs` FK requires `planning_approval_id`, so registration is impossible before planning approval. Specs are therefore untracked-by-DB work-in-progress by design.
- Research registration is clean: 2 DB rows match 2 on-disk REPORTs.

## Rework loops

- Design approved 4×: 22:10 → 00:49 → 01:02 → 01:53 (three inside ~3 h overnight; last pair 51 min apart). `phase_states` design revision=4 matches.
- Engineering approved 1× (~03:18). Total 5 `phase_approved` events, all human.
- Pattern reads as genuine rework loop (repeated snapshot approvals), not rubber-stamping. Bar for "approved" appears movable: first approval did not stick through the night.

## Duplication/bloat

- Doc volume: ~4,400 lines across SDD + solutions; workstream dir 564 K, design subtree ~200 K.
- Layering signal (headers/structure only): solution header shows Objective/Scope plus explicit pointers to parent SDD sections — clean layering pattern, not blank-template duplication.
- Bloat risk is volume + timing: 8 solutions + full PLAN + 8 job specs + 4 verification specs staged before planning approval concentrates review burden at one gate. Checkpoint-1 header states it was written during planning grounding with no implementation run — front-loaded verification.
- `resources/` holds 8 templates + notes dir; templates are scaffolding, not duplication.

## User steering (process effect only)

- Human audit footprint is narrow: only `conversation_registered` (22) + `phase_approved` (5). No direct human edit ops in audit trail.
- Steering acts exclusively through approval gates — which explains the 4× design loop: the only human lever is approve/revise, so iteration shows up as re-approvals rather than tracked edits.

## Top 3 process risks

1. Approval bottleneck with invisible WIP: 8 specs + PLAN + 4 checkpoints exist only on disk; DB shows no jobs until planning approves. Loss/divergence window if disk state shifts pre-approval.
2. Verify-before-execute staleness: detailed verification specs written pre-execution can rot before first job runs; no execution-phase revision signal yet.
3. Unclear design-approval bar: 4 approvals in <4 h suggests premature first approval or shifting criteria; costs reviewer cycles and weakens approval as a phase-gate signal.
