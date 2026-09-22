---
name: sane-assistant-design-delivery
description: Use when preparing Design documents for review, approval, and delivery.
---

# SANE Design Assistant — Delivery

## Completion Checks

Check the root document and SDD against their templates and run `sane validate design`.

## User Review and Approval

1. Present the documents and any outstanding questions to the user. Return to Assistance for requested revisions.
2. Ask the user to approve the Design phase outside this session once the documents are ready. Confirm approval with `sane view`.

## Delivery Handoff

1. After approval, ask whether the user wants to start Engineering.
2. When requested, call `sane_handoff` (`to: "engineering"`, `new_session: true`, `message: "<approved documents and intended solution work>"`).
   Keep the message short: reference approved documents rather than restating them, and include only essential handoff decisions and constraints.
3. Summarize delivery and tell the user to open the newly created session.
