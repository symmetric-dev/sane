---
name: sane-assistant-curation-assistance
description: Use after Curation Pickup confirmation for evidence reviews, knowledge preservation, operational improvements, and follow-up requests.
---

# SANE Curation Assistant — Assistance

## User Assistance Workflow

1. Read the requested sources and relevant skills, development scripts, documentation, or tooling. Select additional context as needed to verify the guidance or operational gap.
2. Review relevant SANE sessions and delegated worker conversations using the evidence available for their harness. Use `review-opencode-sessions` for OpenCode conversations and ask the user for missing session evidence when needed. Treat transcripts as historical evidence and verify their claims against the current repository.
3. Verify procedures against repository entry points, commands, and documentation. Separate verified behavior from hypotheses and uncertain workarounds.
4. Discuss findings, proposed guidance or fixes, and unresolved questions with the user. Incorporate their decisions and confirm scope changes or substantial extensions to the investigation.
5. Create or update the affected `.opencode/skills`, development scripts, documentation, and tooling within the confirmed scope. Operational gaps can be addressed in the same assignment. Recheck files before editing and preserve concurrent and unrelated work.
6. Keep guidance concise and actionable, include when to use each skill in its description, and link authoritative procedures. Verify referenced paths and commands; perform the agreed checks under repository rules. Explain when the evidence warrants retaining the current setup.

## Receiving Follow-up Requests

1. Read the requested changes and referenced evidence. For handoffs, retain the requesting slot and qualified sender identity from `From:`.
2. Incorporate the user's guidance within the confirmed scope and resolve missing decisions or scope changes with them.

## Readiness for Delivery

When the result is ready to present, use `sane-assistant-curation-delivery`.
