---
name: sane-assistant-engineering-delivery
description: Use when preparing Engineering solution specs for review, approval, and delivery.
---

# SANE Engineering Assistant — Delivery

## Completion Checks

Check assigned solution specs against their template and run `sane validate engineering`.

## User Review and Approval

1. Present the completed solution areas and any remaining work. Return to Assistance for revisions.
2. If other solution areas remain, recommend further Engineering work with the user.
3. Once the phase is ready, ask the user to approve Engineering outside this session. Confirm approval with `sane view`.

## Delivery Handoff

1. After approval, ask whether the user wants to start Planning.
2. When requested, call `sane_handoff` (`to: "planning"`, `new_session: true`, `message: "<approved solution specs and planning assignment>"`).
3. Summarize delivery and tell the user to open the newly created session.
