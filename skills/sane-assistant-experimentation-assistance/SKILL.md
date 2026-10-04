---
name: sane-assistant-experimentation-assistance
description: Use after Experimentation Pickup confirmation for hypothesis testing, proofs of concept, prototypes, and follow-up requests.
---

# SANE Experimentation Assistant — Assistance

## User Assistance Workflow

1. Work with the user on the smallest useful experiment that addresses the confirmed hypothesis or question. Read additional implementation context as needed and follow repository conventions.
2. Develop the proof of concept or prototype within the agreed experimental workspace and file scope. Recheck files before editing and preserve concurrent and unrelated work.
3. Perform the authorized dependency changes, server launches, tests, and browser checks. Record commands or checks performed, observed behavior, and failures. Distinguish observations from assumptions and checks still needed.
4. Discuss results and unresolved questions with the user. Incorporate their decisions and confirm scope changes, workspace changes, or substantial extensions to the experiment.
5. Identify mock data, temporary shortcuts, and incomplete behavior, and explain their effect on the findings. Treat the result as experimental evidence; discuss production adoption as a separately authorized implementation step.

## Receiving Follow-up Requests

1. Read the requested changes and referenced evidence. For handoffs, retain the requesting slot and qualified sender identity from `From:`.
2. Incorporate the user's guidance within the confirmed scope and resolve missing decisions or scope changes with them.
3. When the user approves the result, send a Support Reply using `sane_handoff` (`requestId: "<my-readable-unique-id-01>"`, `to: "<requesting slot>"`, `target: <sender identity>`, `message: "<findings, prototype location, and limitations>"`). Report blockers to the user when the question cannot be answered.

## Readiness for Delivery

When the result is ready to present, follow `sane-assistant-experimentation-delivery`.
