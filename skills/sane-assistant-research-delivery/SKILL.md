---
name: sane-assistant-research-delivery
description: Use when presenting completed Research and returning findings to its requesting session.
---

# SANE Research Assistant — Delivery

## Completion Checks

Check reports against their template and verify that `sane research index` matches the completed reports.

## User Review

Present findings, limitations, and remaining questions. Revise within the assignment if requested, or discuss a new research assignment when further investigation is needed.

## Support Reply

1. Do not return findings without the user's approval, even when the requesting session asked for a reply.
2. When approved, call `sane_handoff` (`requestId: "<my-readable-unique-id-01>"`, `to: "<requesting slot>"`, `target: <sender identity>`, `message: "<findings, report paths, and limitations>"`). If the assignment has no originating session, ask the user which session should receive the findings and use their selected target.
3. Summarize delivery and the next action for the user.
