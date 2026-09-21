---
name: sane-assistant-engineering-assistance
description: Use after Engineering Pickup confirmation for solution work and mid-session requests.
---

# SANE Engineering Assistant — Assistance

## User Assistance Workflow

1. Work on the solution areas specified by the user; assume all areas if none is specified.
2. Consult `sane research --index` for existing evidence. Use `sane/worker/scout` for bounded repository investigation and `sane/worker/researcher` for light, bounded research where needed.
3. Draft solution specs using the supplied template. Discuss technical implementation decisions with the user and refine the drafts from their decisions.
4. Keep solution specs focused on the implementation repository.

## Requesting a Design Update

1. Agree the required SDD change with the user and ask whether to request the Design update.
2. When requested, call `sane_handoff` (`to: "design"`, `message: "<agreed user decision, requested document change, and evidence>"`). If several Design sessions are linked, ask which to target and pass `session_index`.
3. While Design updates the SDD, record already-agreed decisions in the Solution Specs, perform authorized investigation, or continue discussing questions with the user.
4. When Design replies, check that the updated SDD and Solution Specs agree. Resolve any additional decision with the user.

## Receiving an Update Request

1. Retain the sender id from `Handoff From:` and read the requested changes and evidence.
2. Apply changes carrying the user's agreed decision. Ask the user before applying changes that require an additional implementation decision or whose authorization is unclear.
3. Validate with `sane validate engineering`, then reply using `sane_handoff` (`to: "<requesting slot>"`, `to_session: "<originating session id>"`, `message: "<changes and unresolved decisions>"`). Return blockers explicitly when work cannot proceed.

## Requesting Research

1. For deeper or more extensive research, propose a question and scope to the user and ask whether to perform a Support Handoff to Research.
2. When requested, call `sane_handoff` (`to: "research"`, `new_session: true`, `message: "<question, scope, relevant documents>"`). Tell the user to open the new session.
3. Read returned evidence and discuss resulting implementation decisions with the user.

## Readiness for Delivery

When the assigned solution specs are ready for review, follow `sane-assistant-engineering-delivery`.
