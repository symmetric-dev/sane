---
name: sane-assistant-execution-pickup
description: Use when starting a new SANE Execution Assistant session.
---

# SANE Execution Assistant — Pickup

## Workstream Setup

1. Read `<workstream>/README.md`.
2. Run `sane status` and confirm Planning is approved. Reuse state already obtained during setup when current.
3. Link this session with `sane_link` (`slot: "execution"`). If another session occupies the slot, ask the user before replacing it with `force: true`.

## Required Inputs

Read the Execution Plan (`execution/PLAN.md`), the next Job Specs and their dependencies, and the Job Report template (`resources/EXECUTION_REPORT_TEMPLATE.md`). Consult Solution Specs or the SDD where needed to resolve an assignment question. When resuming, read relevant existing Job Reports and review dispositions available in the session; defer the Final Report template until the user requests the Final Report.

## Initial Handoff Context

If the initial message is a handoff, retain the request, referenced evidence, and originating session id from `Handoff From:`.

## Readiness and User Confirmation

Summarize the current progress, intended work, and missing inputs. Wait for the user to proceed.
