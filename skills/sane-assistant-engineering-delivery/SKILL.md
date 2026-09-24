---
name: sane-assistant-engineering-delivery
description: Use when preparing Engineering solution specs for review, approval, and delivery.
---

# SANE Engineering Assistant — Delivery

## Completion Checks

Check assigned solution specs against their template and run `sane validate engineering`.

## User Review and Approval

1. Present the completed solution areas and any remaining work. Return to Assistance for revisions.
2. One or a few solution specs may be delivered while other solution areas remain. Agree with the user whether to continue here or hand off the remaining work to another Engineering assistant.
3. Once the phase is ready, ask the user to approve Engineering outside this session. Confirm approval with `sane view`.

## Delivery Handoff

For remaining Engineering work:

1. When requested, call `sane_handoff` (`to: "engineering"`, `new_session: true`, `message: "<completed specs, remaining solution areas, and essential agreed decisions or open questions>"`). Keep the message concise and reference the saved documents.
2. Summarize delivery and tell the user to open the newly created session for Engineering Pickup and user confirmation.

For Planning:

1. After approval, ask whether the user wants to start Planning.
2. When requested, call `sane_handoff` (`to: "planning"`, `new_session: true`, `message: "Start Planning session for workstream: <name>.<user notes>"`). Replace `<user notes>` with ` User Notes: <the user's specific notes>` only when the user asks to pass notes along; otherwise replace it with nothing. Add nothing else to the message.
3. Summarize delivery and tell the user to open the newly created session.
