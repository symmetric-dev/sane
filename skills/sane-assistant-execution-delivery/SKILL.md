---
name: sane-assistant-execution-delivery
description: Use when the user requests the Final Report and Execution delivery review.
---

# SANE Execution Assistant — Delivery

## Completion Checks

1. On the user's request for the Final Report, check Job Reports, Test Reports, review dispositions, accepted limitations, and commit references available in the session. Identify incomplete work without reconstructing every attempt.
2. Write `execution/FINAL_REPORT.md` using `resources/EXECUTION_FINAL_REPORT_TEMPLATE.md`. Synthesize delivered outcomes and remaining limitations from the reports; link evidence rather than copying logs or coordination history.
3. Run `sane validate execution`.

## User Review and Approval

1. Present outcomes, verification, and unresolved findings to the user. Return to Assistance for requested corrections.
2. Ask the user to approve Execution outside this session when ready. Approval also batch-completes outstanding job statuses, so make any incomplete work explicit before asking.
3. Confirm approval with `sane status` and summarize completion and material follow-up findings.
