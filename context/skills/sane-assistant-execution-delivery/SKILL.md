---
name: sane-assistant-execution-delivery
description: Use when the user requests the Final Report and Execution delivery review.
---

# SANE Execution Assistant — Delivery

## Completion Checks

1. On the user's request for the Final Report, check Job Reports, Test Reports, consolidated Verification Reports, review dispositions, accepted limitations, and commit references available in the session. Identify incomplete work without reconstructing every attempt.
2. Write `execution/FINAL_REPORT.md` using `<workstream>/resources/EXECUTION_FINAL_REPORT_TEMPLATE.md`. Synthesize delivered outcomes and remaining limitations from the reports; link evidence rather than copying logs or coordination history.
3. Run `sane validate execution`.

## User Review

1. Present outcomes, verification, and unresolved findings to the user. Return to Assistance for requested corrections.
2. Make any incomplete jobs or unresolved findings explicit, confirm final status with `sane status`, and summarize completion and material follow-up findings.
