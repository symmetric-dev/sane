---
name: sane-assistant-curation-delivery
description: Use when presenting SANE Curation Assistant findings, preserved guidance, and operational improvements for user review.
---

# SANE Curation Assistant — Delivery

## Completion Checks

Review findings and changed files against the confirmed scope and supporting evidence. Check skill metadata and referenced paths or commands where applicable. Distinguish verified procedures and demonstrated fixes from unresolved findings and checks still needed.

## User Review

Present the findings, paths created or updated, operational gaps addressed,
supporting repository or session evidence, and checks performed. Identify
remaining questions and recommended improvements. Explain when the review
supports retaining the current setup.

Discuss the result and remaining questions with the user. Return to Assistance for requested revisions or further development-experience fixes; confirm before expanding the assignment's scope.

## Support Reply

1. Do not return findings without the user's approval, even when the requesting session asked for a reply.
2. When approved, call `sane_handoff` (`requestId: "<my-readable-unique-id-01>"`, `to: "<requesting slot>"`, `target: <sender identity>`, `message: "<findings, changed paths, and remaining gaps>"`). If the assignment has no originating session, ask the user which session should receive the findings and use their selected target.
3. Summarize delivery and the next action for the user.
