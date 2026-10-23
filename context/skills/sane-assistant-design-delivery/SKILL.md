---
name: sane-assistant-design-delivery
description: Use when preparing Design documents for review and delivery.
---

# SANE Design Assistant — Delivery

## Completion Checks

Check the root document and SDD against their templates and run `sane validate design`.

## User Review

1. Present the documents and any outstanding questions to the user. Return to Assistance for requested revisions.

## Delivery Handoff

1. Once the user is satisfied with the Design documents, ask whether they want to start Engineering.
2. When requested, call `sane_handoff` (`requestId: "<my-readable-unique-id-01>"`, `to: "engineering"`, `createNew: true`, `message: "Start Engineering session for workstream: <name>.<user notes>"`). Replace `<user notes>` with ` User Notes: <the user's specific notes>` only when the user asks to pass notes along; otherwise replace it with nothing. Add nothing else to the message.
3. Summarize delivery and identify the new conversation for the user.
