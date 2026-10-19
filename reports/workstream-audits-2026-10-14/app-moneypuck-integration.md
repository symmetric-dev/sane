# Workflow-Process Audit: app-moneypuck-integration (2026-10-14)

## Phase flow
- Research (10-09, 2 dirs / 2 REPORTs, substantive headers) → design (PRD+SDD+6 solutions, substantive) → engineering → planning (all approved) → execution pending. Linear phase progression held; no phase-skipping.
- Pipeline depth is healthy: 14 jobs specced, 10 completed, 2 running (11,12), 2 planned (13,14); 5 verification checkpoints + 3 test-reports on disk.
- FINAL_REPORT.md is still a blank template (guidance comments retained) — correct for pending execution, but a premature artifact existing on disk risks being mistaken for done.

## Handoff/job health (incl. the 2 failures)
- 37 completed / 2 failed handoffs (5% failure). Both failures are `eng-planning-start-…-02` (cc harness, 10-12 23:44) and `-03` (oc harness, 10-13 02:47) — same planning-session-start intent, one attempt each, terminal failure within ~20s.
- Recovery was clean: no retry storm; next planning handoff (`planning-engineering-contract-clarifications-01`, 10-13 04:00) completed, followed by dense completed planning↔execution exchange. Failures stalled ~4h overnight, did not poison the queue.
- Running jobs 11/12 last updated 10-13 20:58/21:28 (~1 day stale at audit); planned 13/14 untouched since 10-13 04:09. Mild staleness, consistent with execution pending, not stuck.
- Audit ops: handoff_state_changed 155 (system), conversation_registered 103 (human), handoff_queued 39 (native), job_progressed 22 (native); only 1 artifact_operation_failed. Approvals human-driven (6 phase_approved). No anomalous op skew.

## Rework loops
- Experimentation evidence dir (370 files, 37MB) shows genuine iterative passes: second/third/fourth/fifth/sixth/seventh-pass naming with paired review+implementation notes per pass. Experimentation phase used as intended, not a single dump.
- Execution-phase rework loop visible in handoff log: ~10 `job02-coverage/empty-cutoff` planning↔execution↔engineering round-trips on 10-13 05:04–05:15, including a user-steered `user-simplify-seeding` handoff that resolved it. Tight same-hour loop = healthy clarification cycle, but job02's spec needed 3 resolution rounds.

## Duplication/bloat
- Research hygiene is good: 4 helper scripts committed alongside 2 REPORTs + supporting JSON/CSV (reproducibility, not bloat); DB registers 3 rows (2 REPORTs + 1 EXTERNAL_EVIDENCE) matching disk — no over/under-registration.
- Experimentation evidence (370 files, mostly screenshots/logs) is heavy but pass-structured; risk is navigability, not duplication. Execution reports mirror jobs 1:1 (12 reports for 14 jobs, jobs 13–14 not yet run) — no orphan reports.

## User steering (process effect only)
- Human actor footprint is large (103 conversation registrations + 6 approvals) with at least two recorded steering events: a scope revision noted in both REPORT headers and a seeding-simplification directive that closed the job02 loop within minutes. Steering shortened loops rather than spawning new branches (only 2 branch_reserved/completed).

## Top 3 process risks
1. Stale running jobs (11/12 ~1 day without progress events) — if execution stays pending, add heartbeat or checkpoint handoffs so staleness is distinguishable from normal pause.
2. Repeated session-start terminal failures across harnesses (cc then oc) suggest a systemic start-up fragility, not a transient; worth a start-path retry/backoff rule.
3. Blank FINAL_REPORT on disk during pending execution invites premature reads; consider generating it only at execution-close or marking DRAFT explicitly.
