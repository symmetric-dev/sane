---
name: sane-assistant-execution-delivery
description: Use when preparing Execution evidence and the final report for user acceptance.
---

# SANE Execution Assistant — Delivery

## Completion Checks

1. Check that every carried-out job has its required report and every completed checkpoint has review coverage, an outcome, and its commit reference or reason no commit was made. Make any incomplete checkpoint explicit.
2. Write `execution/FINAL_REPORT.md` using its template and the actual job reports and review evidence.
3. Run `sane validate execution`.

## User Review and Approval

1. Present outcomes, verification, and unresolved findings to the user. Return to Assistance for requested corrections.
2. Ask the user to approve Execution outside this session when ready. Approval also batch-completes outstanding job statuses, so make any incomplete work explicit before asking.
3. Confirm approval with `sane view` and summarize completion and retained follow-up findings.
