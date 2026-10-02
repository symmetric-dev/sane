---
name: sane-assistant-design-assistance
description: Use after Design Pickup confirmation for user collaboration and mid-session requests.
---

# SANE Design Assistant — Assistance

## User Assistance Workflow

1. Ask yourself, “What are we changing, and why?” Understand the workstream as a whole before drafting its root document.
2. Investigate the questions needed to answer that. Use `sane_worker_start` (`worker: "scout"`) for bounded repository questions, `sane_worker_start` (`worker: "researcher"`) for light research, or follow Requesting Support for broader investigation. Tell the user what you are investigating and share your preliminary understanding. Native subagents remain available for suitable assignments. For background workers, finish independent work and end your turn; results resume this conversation.
3. Propose the overall intent, desired outcome, scope, and evidence of success to the user before writing the root document. Use concrete examples where they clarify the proposal.
4. Discuss constraints, risks, priorities, and open decisions with the user. Investigate and refine the proposal as needed, then write the agreed direction in the applicable root document using its template. Keep it human-readable and technical detail limited to real constraints. Report it for the user's review and approval.
5. After root-document approval, ask yourself, “What architectural direction supports this outcome, and why?” Propose the SDD's overall direction and solution areas to the user; discuss boundaries and trade-offs, investigate remaining questions, then write the agreed direction in `design/SDD.md` using its template. Include only the architecture and rationale needed to guide Engineering.
6. Report the SDD for review. Keep questions and collaboration history in the conversation; documents describe the current direction, not session identities, approval exchanges, or superseded decisions. Prefer the simplest solution that satisfies the requirements.

## Receiving a Live Backward Handoff

1. Read the work request and referenced evidence from Engineering. Retain the qualified sender identity from `From:` for the reply, not in the documents. A confirmation requires no reply.
2. Apply the requested update when the handoff carries the user's agreed decision. If the update requires an additional decision or its authorization is unclear, ask the user before applying it.
3. Run `sane validate design` and send a Live Backward Reply with `sane_handoff` (`requestId: "<my-readable-unique-id-01>"`, `to: "engineering"`, `target: <sender identity>`, `message: "<changes, evidence, and unresolved decisions>"`). If blocked, return the blocker and required user decision.

## Requesting Support

You can request support to specialized Support Tracks. Use Research if you need to gain deep insight on a specific feature, resource, or dependency. Consider Experimentation when you have identified that we need specific proof or prototyping for the user to make a product or design decision.

Here is how to request a Support Handoff:

1. Propose the support question and scope to the user and ask whether to perform a Support Handoff.
2. When requested, call `sane_handoff` (`requestId: "<my-readable-unique-id-01>"`, `to: "<support track>"`, `createNew: true`, `message: "<question, scope, relevant evidence>"`). Summarize the dispatched request.
3. Read returned evidence and discuss its implications with the user before applying changes within the authorized scope.

## Readiness for Delivery

When the documents are ready for review, follow `sane-assistant-design-delivery`.
