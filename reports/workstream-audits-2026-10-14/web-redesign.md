# web-redesign — WORKFLOW-PROCESS audit (2026-10-14)

Target: FEATURE workstream, created 2026-10-08. Disk: 94 files, ~17MB. Docs (headers only): PRD, SDD, PLAN, FINAL_REPORT all substantive; no blank templates in phase outputs. No `experimentation/` dir.

## Phase flow
- DB `phase_states`: design=approved (rev 5), engineering=approved (rev 2), planning=approved (rev 1), execution=pending (rev 0). Workstream status=open.
- Approvals timeline: 5 design approvals 21:47→23:58 on 10-08, 2 engineering 00:10→00:28 on 10-09, 1 planning 00:50 on 10-09. Design→planning approved in ~3h; execution opened 00:51, still pending after substantive outputs landed.
- `phase_assigned` ×11 interleaved with approvals; no blocked states recorded.

## Handoff/job health
- `handoffs`: 64 completed, 0 in any other status. `handoff_attempts`=64 total, no handoff with >1 attempt — zero retries, zero failures.
- `jobs` table: 15/15 completed; disk matches (15 specs + 15 reports). `job_progressed` ×30 (~2 transitions/job, clean planned→running→completed).
- `audit_events`: 495 total (human 82, native 124, system 289). Top ops: handoff_state_changed 256, conversation_registered 74, handoff_queued 64. No error/failure-class ops present.

## Rework loops
- Design revision counter (rev 5) matches 5 design approvals — repeated approve cycles within ~2h confirm a rework loop, not a single pass. Engineering rev 2 / 2 approvals = one rework pass. Planning rev 1 / 1 approval = single pass.
- Approval cadence (4 design approvals in 21:47→23:52, then 2 within 6 min) suggests iterative tightening rather than rejection-driven restart; no failed handoffs accompanied the loop.

## Duplication/bloat
- `resources/` holds 9 process templates; JOB_TEMPLATE.md byte-identical to another workstream's copy — per-workstream template duplication confirmed.
- Research: 14 registered reports across 8 on-disk dirs (evidence files registered as reports inflates count ~1.75×). No orphan dirs; registration matches disk.
- Bloat signal: research/ is ~16MB of 17MB total (images/PDF artifacts); process docs themselves are lean.

## User steering (process effect only)
- Human audit footprint is 82 events = 74 conversation_registered + 8 phase_approved; zero other human op types. Steering expressed solely through approval gates, not mid-phase edits/annotations.
- Effect: gates functioned (rework loops above correlate with human approval spacing), but no human-authored correction/redirect ops are visible in the log.

## Top 3 process risks
1. **Stale execution status**: 5 verification checkpoints + 5 test reports + substantive FINAL_REPORT exist while `execution=pending` — completion signaling never flipped the gate; downstream consumers reading phase state get the wrong signal.
2. **Approval-count ≠ recorded rationale**: 5 design approvals with no rejection/failure trace — rework reason is invisible; future audits cannot distinguish polish from defect.
3. **Template-per-workstream duplication**: identical templates copied per workstream (verified identical) — drift risk; a shared versioned template source would remove it.
