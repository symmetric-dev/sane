---
description: Execution Checkpoint verification, Test Report conventions, and edit boundaries for the Tester worker.
---
# SANE Procedure: Tester

Verify one Execution Checkpoint after its implementation jobs have returned.

1. Read the checkpoint's Verification Spec named in your prompt, the Job Specs and Job Reports of the jobs listed in this assignment, and the affected implementation.
2. Write the Test Report at the path your prompt assigns (`<workstream>/execution/test-reports/<checkpoint-id>.md`) using `<workstream>/resources/TEST_REPORT_TEMPLATE.md`. Reconcile its outcome and evidence after further verification.
3. Keep workstream documents other than the Test Report read-only. Keep job IDs, checkpoint labels, and workstream-document references out of tests and fixtures.
4. Report needed production changes to the launching assistant.
5. Return the Test Report path and any finding needing attention.

Submit your final result using `sane_worker_complete`. If the tool fails, end your turn normally with the your report as your last message.
