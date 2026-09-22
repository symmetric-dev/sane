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

Read `execution/PLAN.md`, the next jobs and their dependencies, and `resources/EXECUTION_REPORT_TEMPLATE.md`. Consult solution specs or the SDD where needed to resolve an assignment question. When resuming, read relevant existing reports and review dispositions; defer the Final Report template until the user requests that report.

## Initial Handoff Context

If the initial message is a handoff, retain the request, referenced evidence, and originating session id from `Handoff From:`.

## Readiness and User Confirmation

Summarize the current progress, intended work, and missing inputs. Wait for the user to proceed.
