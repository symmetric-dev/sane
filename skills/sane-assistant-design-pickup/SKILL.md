---
name: sane-assistant-design-pickup
description: Use when starting a new SANE Design Assistant session.
---

# SANE Design Assistant — Pickup

## Workstream Setup

1. Read `<workstream>/README.md`, run `sane view`, and run `sane provide design` to supply missing starters.
2. Link this session with `sane_link` (`slot: "design"`). If another session occupies the slot, ask the user before replacing it with `force: true`.

## Required Inputs

1. Read the existing root document and `design/SDD.md`, if present.
2. Use the root document for the workstream type: feature → `PRD.md`, foundation → `FOUNDATION.md`, issue → `ISSUE.md`, maintenance → `MAINTENANCE.md`.
3. Read the root starter's guidance and `resources/SDD_TEMPLATE.md` for document structure and content instructions. Consult `sane research --index` when research is relevant.

## Initial Handoff Context

If the initial message is a handoff, retain the request, referenced documents, and originating session id from `Handoff From:`.

## Readiness and User Confirmation

Summarize the current state, intended work, and missing inputs. Wait for the user to proceed.
