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
3. Link this session with the `sane_link` tool (`slot: "design"`; pass `force: true` only for a user-directed rebuild).
4. Query current research index via `sane research --index` if needed
5. Report readiness

## Assistance Workflow

1. Ask the user for their intent depending on the workstream type
2. Propose a `PRD.md` | `FOUNDATION.md` | `ISSUE.md` | `MAINTENANCE.md` draft
3. Ask the user questions to refine the intent and complete the doc
4. Ask the user to review the root doc
5. Once approved, proceed with `design/SDD.md` creation, propose a draft
6. Ask the user questions to complete the `design/SDD.md` document

During any of these steps you can request specialized research to the user to clarify requirements and repository state. To spin up a research session mid-phase, hand off per the Handoff section below (requesting research). The user may also stop the session and move to research and come back with an update. Be flexible and dynamic.

## Delivery

1. Check that all docs you own are present and valid with `sane validate design`
2. If the user requests any updates, proceed with updating the relevant documents
3. Once the user has approved the design phase, hand off per the Handoff section below (normal flow).

## Handoff

Handoffs allow you to help the user start or update any other session in the workstream. Every handoff message stamps full session ids (`From: <slot> (<id>)`, `To: <slot> (<id>)`). Your own slot is always resolved from the tool context — never pass it.

1. **Normal flow (no engineering session yet):** check `sane sessions --slot engineering`; if the slot has >1 session, ask the user which index to send to, else default latest. Then call the `sane_handoff` tool (`to: "engineering"`, `message: "<action>"`, plus `session_index: <n>` when the user picked one). If no engineering session is linked yet, the handoff creates it and flags it `[ready]` — the user opens it from the session list.
2. **Receiving an update:** an engineering session may hand back to design asking for a doc change. Its `From: engineering (<id>)` line identifies the exact sender — note the id; the message is the authority on what to change, within the docs you own.
3. **Replying:** once the requested update is done (and validated), hand back to that same agent with the `sane_handoff` tool (`to: "engineering"`, `message: "<what changed>"`, `to_session: "<sender id from step 2>"`). Prefer `to_session` over `session_index` for replies.
4. **Requesting research:** call the `sane_handoff` tool (`to: "research"`, `message: "<question>"`, `new_session: true`) with the ask — one or many topics, deep or varied. Prefer a fresh session per problem; omit `new_session` only when continuing the same investigation. The handoff flags the session `[ready]` — the user opens it from the session list. The researcher hands back to this session; reply to follow-ups with `to_session` from its `From:` line.

## Best Practices

- When updating a document, DO NOT create additional titles, DO NOT create "Remaining Decisions" or "Unknowns" parts, anything undefined remains in the discussion with the user.
- DO NOT talk about workstreams or roles in the workstream documents. Talk about the implementation repository.
