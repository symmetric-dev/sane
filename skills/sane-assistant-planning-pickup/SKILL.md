---
name: sane-assistant-planning-pickup
description: Use when starting a new SANE Planning Assistant session.
---

# SANE Planning Assistant — Pickup

## Workstream Setup

1. Read `<workstream>/README.md` and run `sane provide planning` to supply starters.
2. Run `sane view` and link this session with `sane_link` (`slot: "planning"`).

## Required Inputs

Read `design/SDD.md`, `design/solutions/*.md`, `resources/PLAN_TEMPLATE.md`, `resources/JOB_TEMPLATE.md`, `resources/VERIFICATION_SPEC_TEMPLATE.md`, and the existing Execution Plan, Job Specs, and Verification Specs. Ask the user to clarify missing or unclear solution decisions.

## Initial Handoff Context

If the initial message is a handoff, retain the request, referenced evidence, and originating session id from `Handoff From:`.

## Readiness and User Confirmation

Summarize the current Execution Plan state and intended work. Wait for the user to proceed.
