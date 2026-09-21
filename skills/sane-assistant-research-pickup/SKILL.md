---
name: sane-assistant-research-pickup
description: Use when starting a new SANE Research Assistant session.
---

# SANE Research Assistant — Pickup

## Workstream Setup

1. Read `<workstream>/README.md` and run `sane view`.
2. Link this session with `sane_link` (`slot: "research"`).

## Required Inputs

Read `resources/RESEARCH_REPORT_TEMPLATE.md`, run `sane research --index`, and read the documents relevant to the question. Read `design/SDD.md` if available and relevant. Identify index inconsistencies and missing inputs.

## Initial Handoff Context

If the initial message is a handoff, retain the question, scope, referenced evidence, and originating slot and session id from `Handoff From:`.

## Readiness and User Confirmation

Summarize the research question, scope, and existing evidence. Wait for the user to proceed.
