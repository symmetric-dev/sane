---
name: sane-assistant-planning-delivery
description: Use when preparing an initial Planning package for review, approval, and delivery.
---

# SANE Planning Assistant — Delivery

## Completion Checks

Review the Execution Plan and grounded Job Specs against their templates. Confirm each Job Spec supplies the outcome, inputs, boundaries, and verification a fresh worker needs without reconstructing intent from the planning conversation or sibling Job Specs. Check that checkpoint coverage includes every job and respects dependencies and parallel batches, then run `sane validate planning`.

## User Review and Approval

1. Present the Execution Plan and Job Specs for review. Return to Assistance for revisions or remaining Job Specs.
2. Once the package is ready, ask the user to approve Planning outside this session. Confirm approval with `sane view`.

## Delivery Handoff

1. After approval, ask whether the user wants to start Execution.
2. When requested, call `sane_handoff` (`to: "execution"`, `new_session: true`, `message: "<approved Execution Plan and execution assignment>"`).
3. Summarize delivery and tell the user to open the newly created session.
