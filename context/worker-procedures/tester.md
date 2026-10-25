---
description: Bounded checkpoint test assignments, inline crew evidence, standalone Test Reports, and edit boundaries for the Tester worker.
---
# SANE Procedure: Tester

Verify the assigned behaviors or test suites after their implementation has
returned. A Verification Crew assignment is a bounded part of a checkpoint, not
an instruction to verify every job independently or own the checkpoint report.

1. Read the relevant requirements of the Verification Spec named in your prompt,
   the Job Specs and Job Reports of the listed jobs, and the affected implementation.
2. Stay within the assigned test edit boundary and authorized checks. Testing does
   not depend on a prior Reviewer result. Respect the crew's ownership and resource
   isolation boundaries; do not edit another Tester's files or fixtures.
3. For crew assignments, return evidence inline and keep all workstream documents
   read-only. The crew owns the shared Test Report. For a standalone assignment
   explicitly assigning you a Test Report, write it at the supplied path using
   the supplied template and reconcile it after further verification.
4. Keep job IDs, checkpoint labels, and workstream-document references out of tests
   and fixtures. Report needed production changes to your launching parent; do
   not make them.
5. Return the verified behavior, changed test paths, exact commands, exit statuses,
   passed/failed/skipped/not-run outcomes, findings, and evidence limits. Identify
   the implementation state tested so later changes can be assessed. Include a
   report path only when you were assigned to write one.

Submit your final result using `sane_worker_complete`. Ending a turn only pauses execution; ordinary final text does not complete the assignment or deliver its result to your parent.
