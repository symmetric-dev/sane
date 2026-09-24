---
name: sane-assistant-engineering-assistance
description: Use after Engineering Pickup confirmation for solution work and mid-session requests.
---

# SANE Engineering Assistant — Assistance

## User Assistance Workflow

1. Take the first or next solution area. Ask yourself, “But how are we going to implement this?” Work through one spec at a time.
2. Investigate the questions needed to answer it. Consult `sane research --index`, launch `sane/worker/scout-crew` for multi-scope repository questions, use `sane/worker/scout` for a single bounded question, `sane/worker/researcher` for light research, or request a deeper Research handoff. Tell the user what you are investigating and share your preliminary implementation ideas.
3. Propose the concrete, repository-grounded approach to the user before writing the complete spec. Use representative code or pseudocode for most technical decisions, with models, data flows, or diagrams where they clarify the behavior and integration. Prefer the simplest design that satisfies the requirements.
4. Discuss technical decisions, preferences, scope, verification, risks, and time constraints with the user. Investigate remaining questions and refine the proposal around new findings until the user is satisfied with the approach.
5. Write the agreed approach into the solution spec using the supplied template and report it to the user. Include useful examples alongside the contracts; keep questions and collaboration history in the conversation, not the spec.
6. Continue to the next solution area at the user's request, or follow the appropriate delivery or handoff workflow.

## Requesting a Design Update

1. Agree the required SDD change with the user and ask whether to request the Design update.
2. When requested, call `sane_handoff` (`to: "design"`, `message: "<agreed user decision, requested document change, and evidence>"`). If several Design sessions are linked, ask which to target and pass `session_index`.
3. While Design updates the SDD, record already-agreed decisions in the Solution Specs, perform authorized investigation, or continue discussing questions with the user.
4. After Design replies, resolve any additional decision directly with the user; only send a following handoff back to Design when there is new information, don't send empty confirmation or pending information.

## Receiving an Update Request

1. Confirm the message requests new work; replies and acknowledgments do not require a return handoff. For a new request, retain the sender id from `Handoff From:` and read the requested changes and evidence.
2. Apply changes carrying the user's agreed decision. Ask the user before applying changes that require an additional implementation decision or whose authorization is unclear.
3. Validate with `sane validate engineering`, then reply using `sane_handoff` (`to: "<requesting slot>"`, `to_session: "<originating session id>"`, `message: "<changes and unresolved decisions>"`). Return blockers explicitly when work cannot proceed.

## Requesting Research

1. For deeper or more extensive research, propose a question and scope to the user and ask whether to perform a Support Handoff to Research.
2. When requested, call `sane_handoff` (`to: "research"`, `new_session: true`, `message: "<question, scope, relevant documents>"`). Tell the user to open the new session.
3. Read returned evidence and discuss resulting implementation decisions directly with the user; only send back more handoffs if more information is required, do not send unnecessary confirmation handoffs.

## Readiness for Delivery

When the assigned solution specs are ready for review, follow `sane-assistant-engineering-delivery`.
