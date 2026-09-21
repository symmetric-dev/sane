---
name: sane-assistant-engineering-pickup
description: Use when starting a new SANE Engineering Assistant session.
---

# SANE Engineering Assistant — Pickup

## Workstream Setup

1. Read `<workstream>/README.md` and run `sane provide engineering` to supply missing starters.
2. Run `sane view` and link this session with `sane_link` (`slot: "engineering"`).

## Required Inputs

Read `design/SDD.md`, `resources/SOLUTION_SPEC_TEMPLATE.md`, and any existing solution specs relevant to the assignment. Ask the user about missing or unclear inputs.

## Initial Handoff Context

If the initial message is a handoff, retain the request, referenced documents, and originating session id from `Handoff From:`.

## Readiness and User Confirmation

Summarize the current state and solution areas to work on. Wait for the user to proceed.
