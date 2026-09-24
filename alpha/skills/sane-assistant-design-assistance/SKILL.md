---
name: sane-assistant-design-assistance
description: Use after Design Pickup confirmation for user collaboration and mid-session requests.
---

# SANE Design Assistant — Assistance

## User Assistance Workflow

1. Ask yourself, “What are we changing, and why?” Understand the workstream as a whole before drafting its root document.
2. Investigate the questions needed to answer that. Use `sane/worker/scout` for bounded repository questions, `sane/worker/researcher` for light research, or request a deeper Research handoff. Tell the user what you are investigating and share your preliminary understanding.
3. Propose the overall intent, desired outcome, scope, and evidence of success to the user before writing the root document. Use concrete examples where they clarify the proposal.
4. Discuss constraints, risks, priorities, and open decisions with the user. Investigate and refine the proposal as needed, then write the agreed direction in the applicable root document using its template. Keep it human-readable and technical detail limited to real constraints. Report it for the user's review and approval.
5. After root-document approval, ask yourself, “What architectural direction supports this outcome, and why?” Propose the SDD's overall direction and solution areas to the user; discuss boundaries and trade-offs, investigate remaining questions, then write the agreed direction in `design/SDD.md` using its template. Include only the architecture and rationale needed to guide Engineering.
6. Report the SDD for review. Keep questions and collaboration history in the conversation; documents describe the current direction, not session identities, approval exchanges, or superseded decisions. Prefer the simplest solution that satisfies the requirements.

## Receiving a Live Backward Handoff

1. Read the work request and referenced evidence from Engineering. Retain the originating session id from `Handoff From:` for the reply, not in the documents. A confirmation requires no reply.
2. Apply the requested update when the handoff carries the user's agreed decision. If the update requires an additional decision or its authorization is unclear, ask the user before applying it.
3. Run `sane validate design` and send a Live Backward Reply with `sane_handoff` (`to: "engineering"`, `to_session: "<originating session id>"`, `message: "<changes, evidence, and unresolved decisions>"`). If blocked, return the blocker and required user decision.

## Requesting Research

1. For deeper or more extensive research, propose the question and scope to the user and ask whether to perform a Support Handoff to Research.
2. When requested, call `sane_handoff` (`to: "research"`, `new_session: true`, `message: "<question, scope, relevant documents>"`). Tell the user to open the new session.
3. When findings return, read the referenced report and discuss their implications with the user before updating the documents. Do not send a confirmation handoff.

## Readiness for Delivery

When the documents are ready for review, follow `sane-assistant-design-delivery`.
