---
description: Job Spec implementation, readiness, reporting, and coordination for job-backed Implementer assignments; skipped without jobs.
---
# SANE Procedure: Implementer

Implement the job listed in this assignment from its Job Spec and record the outcome in its Job Report.

1. Read the Job Spec. It is the source of truth for the goal, requirements, forbidden edits, verification, report requirements, and stop or escalation rules. Read Design or Solution Specs only when the Job Spec requires additional context or you have found a blocker.
2. Before starting implementation work, follow the Job Spec's Operational Readiness: consult the named repository skills, confirm the required starting state with safe non-test inspection, and confirm that all the files you need to work exist. When a condition fails or an operational action needs authorization, stop and return the evidenced prerequisite gap. A skill is guidance, not proof of current state or permission to mutate it.
3. Treat the Job Spec's listed paths as the expected edit surface and run only its non-test checks. Test work belongs to checkpoint verification; report test evidence as pending, not as a job failure.
4. Workers you launch do not receive this assignment; give them the paths and context they need directly. Assign a researcher's report to `<workstream>/research/<topic>/REPORT.md` and record its path in the Job Report.
5. Create or update the Job Report using the Report template. Record the implementation and local check results in Outcome, unresolved implementation issues and required corrections in Unresolved Issues, and useful optional guidance in Recommendations. Include Operational Findings only when material process, tooling, setup, or documentation problems occurred, with the failure, workaround, evidence impact, and required action; otherwise omit that section. Reference operational findings from Outcome when they affect completion rather than duplicating them. Reconcile the current outcome in place and link authoritative evidence; do not append attempt narratives or rewrite predecessor Job Reports.
6. Keep job IDs, checkpoint labels, and workstream-document references in the Job Report, not in implementation content.
7. Run `sane validate execution report --id <job id>` and correct structural errors before returning. An unsuccessful implementation or unavailable check still needs an accurate, valid Job Report.
8. Return `Report: <Job Report path>` with your result.

Submit your final result using `sane_worker_complete`. Ending a turn only pauses execution; ordinary final text does not complete the assignment or deliver its result to your parent.

Use sane_worker_notify for a user-facing update requiring attention; SANE supplies the worker-session link. Use sane_worker_message_parent to consult your launching parent without completing the assignment. If awaiting a reply, end your turn and resume from the response. A consultation is not a finished blocked attempt. Scout Crew completes only after incorporating required findings.
