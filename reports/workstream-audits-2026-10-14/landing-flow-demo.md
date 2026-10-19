# Workflow audit: landing-flow-demo (process only, no implementation content)

Target: `landing-flow-demo`, /Users/beto/aws-hackaton-talent-agency, FEATURE, created 2026-10-04T11:39Z.
Inventory: 1.4M total. PRD, SDD + 6 solution specs, PLAN, 11 jobs + 11 reports (1:1),
5 verification + 5 test-reports, FINAL_REPORT, 1 experimentation findings doc + 6 evidence
files, 9 template copies in resources/, research/ empty (0 research_reports). ~42 md files.
Headers substantive throughout; no blank templates in output docs.

## Phase flow
- 4/4 phases approved, exactly 1 approval each — cleanest in set, zero re-approval loops.
- Velocity: created 10-04 11:39 → design 10-04 18:54 (~7h) → engineering 10-05 00:20 →
  planning 10-05 00:49 → execution 10-05 15:29. Full gate cycle ~28h.
- Human approvals = only 4 human-actor ops that matter (55 conversation_registered are
  session noise); human touch minimal, system/native carried the flow (59/58/108).

## Handoff/job health
- Handoffs 22/22 completed, 0 failed. Jobs 11/11 completed. job_progressed=22 (2 events/job).
- jobs_registered x3 shows scope growth: 7 → 9 (10-05 14:10) → 11 (10-05 14:46), all
  mid-execution, after the single planning approval. FINAL_REPORT confirms jobs 08–11
  are "two rounds of user-requested revisions" — absorbed with no planning re-approval.

## Rework loops
- Zero phase-level rework (no re-approvals). All revision pressure landed inside
  execution as additive jobs (08–11), never cycling back to design/planning gates.
- Experimentation (casting-animation feasibility, reviewed 10-04) preceded design
  approval and de-risked the approach — likely contributor to zero downstream rework.

## Duplication/bloat
- 1:1 job↔report mirroring (11+11), verification↔test-report pairing (5+5): full
  ceremony on a demo-sized scope (~42 md files for 11 jobs).
- 9 template files copied per-workstream into resources/ — pure bloat, should be shared.
- research/ empty dir + 0 research_reports: dead scaffold; experimentation served the
  discovery role instead. Ceremony disproportionate but harmless here.

## User steering (process effect only)
- 10-04 14:41 branches.json op: user renamed experiment casting-demo →
  casting-demo-animation mid-stream (pre-design-approval). Absorbed silently, no
  rework, no new approval — correct handling of a cosmetic steer.
- Jobs 08–11 user revisions absorbed as additive execution jobs without gate
  re-entry. Pragmatic but sets precedent: planning gate is advisory once execution
  starts. Post-completion: one curation handoff 10-07 (2d after exec approval),
  no artifact changes — clean post-close behavior.

## Top 3 process risks
1. Silent scope absorption: +4 jobs (+57%) with no planning re-approval normalizes
   gate bypass; siblings with formal rework loops may just be the honest version.
2. Ceremony-to-scope ratio: 1:1 job/report + paired verification doubles doc volume;
   fine at 11 jobs, scales badly.
3. Per-workstream template copies + empty research scaffold suggest kickoff
   scaffolding is not pruned to scope — small workstreams carry full-ceremony weight.
