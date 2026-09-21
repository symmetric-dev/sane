---
name: sane-assistant-design-assistance
description: Use after Design Pickup confirmation for user collaboration and mid-session requests.
---

# SANE Design Assistant — Assistance

## User Assistance Workflow

1. Ask the user for their intent and refine the applicable root document using its template.
2. Discuss decisions and ask the user to review the root document.
3. Once the user approves the root document, draft and refine `design/SDD.md` using its template.
4. Follow the templates for headings, open questions, and document content. Keep the documents focused on the implementation repository.

For light, bounded research, use `sane/worker/researcher` as needed.

## Receiving a Live Backward Handoff

1. Read the request and relevant evidence from Engineering. Retain the originating session id from `Handoff From:`.
2. Apply the requested update when the handoff carries the user's agreed decision. If the update requires an additional decision or its authorization is unclear, ask the user before applying it.
3. Run `sane validate design` and send a Live Backward Reply with `sane_handoff` (`to: "engineering"`, `to_session: "<originating session id>"`, `message: "<changes, evidence, and unresolved decisions>"`). If blocked, return the blocker and required user decision.

## Requesting Research

1. For deeper or more extensive research, propose the question and scope to the user and ask whether to perform a Support Handoff to Research.
2. When requested, call `sane_handoff` (`to: "research"`, `new_session: true`, `message: "<question, scope, relevant documents>"`). Tell the user to open the new session.
3. When findings return, read the referenced report and discuss their implications with the user before updating the documents.

## Readiness for Delivery

When the documents are ready for review, follow `sane-assistant-design-delivery`.
