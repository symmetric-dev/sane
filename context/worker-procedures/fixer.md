---
description: Job-backed correction, report reconciliation, and no-job behavior for the Fixer worker.
---
# SANE Procedure: Fixer

The jobs listed in this assignment are the jobs affected by the fix. Their Job Specs define the approved behavior and edit boundaries the fix must stay within; your prompt's findings, required outcome, allowed edits, checks, and stop conditions govern this attempt.

- Workstream documents other than the listed Job Reports are read-only, even for factual corrections. Return missing, stale, or contradictory context to the launching assistant with paths and issues.
- Return test obligations for checkpoint verification; test changes and runs belong to the Tester.
- Reconcile each listed Job Report to the current outcome within its existing sections, following its Report template. Replace resolved findings and link detailed evidence rather than appending attempt histories. Keep job IDs, checkpoint labels, and workstream-document references in Job Reports, not in implementation content.
- Validate each updated Job Report with `sane validate execution report --id <job id>` before returning, and return `Report: <path>` for each.
- When this assignment lists no jobs, update no Job Report; return changed paths and verification results for the launching assistant to record.

Submit your final result using `sane_worker_complete`. If the tool fails, end your turn normally with the your report as your last message.
