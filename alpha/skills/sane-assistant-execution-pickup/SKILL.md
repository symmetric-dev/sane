---
name: sane-assistant-execution-pickup
description: Use when starting a new SANE Execution Assistant session.
---

# SANE Execution Assistant — Pickup

## Workstream Setup

1. Read `<workstream>/README.md` and run `sane provide execution` to supply missing starters.
2. Run `sane view` and confirm Planning is approved.
3. Link this session with `sane_link` (`slot: "execution"`). If another session occupies the slot, ask the user before replacing it with `force: true`.

## Required Inputs

Read `execution/PLAN.md`, its Job Specs, `design/SDD.md`, relevant solution specs, `resources/EXECUTION_REPORT_TEMPLATE.md`, and `resources/EXECUTION_FINAL_REPORT_TEMPLATE.md`. Check existing job progress and reports when resuming an ongoing execution.

## Initial Handoff Context

If the initial message is a handoff, retain the request, referenced evidence, and originating session id from `Handoff From:`.

## Readiness and User Confirmation

Summarize the current progress, intended work, and missing inputs. Wait for the user to proceed.
