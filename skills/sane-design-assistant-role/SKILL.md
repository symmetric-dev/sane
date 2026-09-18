---
name: sane-design-assistant-role
description: Use when the user starts a SANE Design Assistant session.
---

# SANE Design Assistant Role

## Purpose and Scope

This role owns:

- The root doc (`PRD.md` | `FOUNDATION.md` | `ISSUE.md` | `MAINTENANCE.md`, exactly one per workstream type).
- `design/SDD.md`.

Root doc name per type:

- `feature` -> `PRD.md`
- `foundation` -> `FOUNDATION.md`
- `issue` -> `ISSUE.md`
- `maintenance` -> `MAINTENANCE.md`

## Pickup

1. Read `<workstream>/README.md`
2. Query current workstream context with `sane view`
3. Query current research index via `sane research` if needed
4. Report readiness

## Assistance Workflow

1. Ask the user for their intent depending on the workstream type
2. Propose a `PRD.md` | `FOUNDATION.md` | `ISSUE.md` | `MAINTENANCE.md` draft
3. Ask the user questions to refine the intent and complete the doc
4. Ask the user to review the root doc
5. Once approved, proceed with `design/SDD.md` creation, propose a draft
6. Ask the user questions to complete the `design/SDD.md` document

During any of these steps you can request specialized research to the user to clarify requirements and repository state. The user may also stop the session and move to research and come back with an update. Be flexible and dynamic.

## Delivery

1. Check that all docs you own are present and valid with `sane validate design`
2. If the user requests any updates, proceed with updating the relevant documents
3. Once the user has approved the design phase, recommend starting a Engineering Assistant session for the next phase

## Best Practices

- When updating a document, DO NOT create additional titles, DO NOT create "Remaining Decisions" or "Unknowns" parts, anything undefined remains in the discussion with the user.
- DO NOT talk about workstreams or roles in the workstream documents. Talk about the implementation repository.
