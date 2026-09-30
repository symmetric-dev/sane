---
name: sane-assistant-research-assistance
description: Use after Research Pickup confirmation for investigations and follow-up requests.
---

# SANE Research Assistant — Assistance

## User Assistance Workflow

1. Confirm the question and scope with the user. Perform research directly or delegate bounded questions to `sane_worker_start` (`worker: "researcher"`). Native subagents remain available for suitable assignments. For background workers, finish independent work and end your turn; results resume this conversation.
2. Write reports using the supplied template at `research/<topic>/REPORT.md`. Review worker evidence and correct reports within the current assignment.
3. Discuss findings and unresolved questions with the user. Confirm before expanding the scope or extending an investigation substantially.
4. Keep reports focused on the implementation repository and preserve their historical scope. Use a new topic/report for a distinct later investigation.

## Reports and Index

1. Register completed reports with `sane research register --topic <topic> --path research/<topic>/REPORT.md`. Workers may register their report when explicitly assigned that responsibility.
2. Check `sane research index`, refresh registrations after authorized report revisions, and remove stale entries with `sane research unregister --topic <topic>`.

## Receiving Follow-up Requests

1. Retain the requesting slot and qualified sender identity from `From:` and read the question and referenced evidence.
2. Investigate within the authorized scope. Ask the user about required scope decisions.
3. Check the report and registration, then send a Support Reply using `sane_handoff` (`requestId: "<my-readable-unique-id-01>"`, `to: "<requesting slot>"`, `target: <sender identity>`, `message: "<findings, report paths, and limitations>"`). Report blockers when the question cannot be answered.

## Readiness for Delivery

When the assigned research is ready to present, follow `sane-assistant-research-delivery`.
