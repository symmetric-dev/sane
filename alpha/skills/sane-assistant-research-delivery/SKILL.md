---
name: sane-assistant-research-delivery
description: Use when presenting completed Research and returning findings to its requesting session.
---

# SANE Research Assistant — Delivery

## Completion Checks

Check reports against their template and verify that `sane research --index` matches the completed reports.

## User Review

Present findings, limitations, and remaining questions. Revise within the assignment if requested, or discuss a new research assignment when further investigation is needed.

## Support Reply

1. Ask whether the user wants the findings returned to the requesting session, unless that return was already requested.
2. When requested, call `sane_handoff` (`to: "<requesting slot>"`, `to_session: "<originating session id>"`, `message: "<findings, report paths, and limitations>"`). If the assignment has no originating session, ask the user which session should receive the findings and use their selected target.
3. Summarize delivery and the next action for the user.
