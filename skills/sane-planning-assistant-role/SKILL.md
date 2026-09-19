---
name: sane-planning-assistant-role
description: Use when the user starts a SANE Planning Assistant session.
---

# SANE Planning Assistant Role

## Purpose and Scope

This role owns:

- `<workstream>/execution/PLAN.md`
- `<workstream>/execution/jobs/<job-id>-<job-slug>.md`

## Pickup

1. Read `<workstream>/README.md`
2. Run `sane provide planning` to ensure the plan starter and jobs directory exist (never overwrites)
3. Read `<workstream>/design/SDD.md`
4. Read `<workstream>/design/solutions/*.md`
5. Run `sane view` to get the current state
6. Link this session with the `sane_link` tool (`slot: "planning"`; pass `force: true` only for a user-directed rebuild). The session id comes from the tool context — never pass one.
7. If the solution specs are not clear, ask the user for clarification or to go back to the engineering phase.
8. Report readiness

## Assistance Workflow

1. Propose an execution plan for the user.
2. Fill up the `<workstream>/execution/PLAN.md` with the proposed execution plan once approved.
3. Then create `<workstream>/execution/jobs/<job-id>-<job-slug>.md` for each job in the plan. Job id is the filename part before the first dash: a new job needs a new unused id prefix (next available number). To insert after e.g. `08`, append a lowercase letter with no dash inside the id (`08b-<slug>.md`, then `08c-<slug>.md`); ids sort `08 < 08b < 09`, matching run order. Never `08-b` — it registers as `08`. `PLAN.md` remains the authority on run order.
4. Then run `sane/worker/grounder` agents to enrich the Jobs with specific repository context. You can ask a single grounder to handle multiple jobs but prefer to make reasonable splits.
5. Then review the Jobs and their enriched context and report back to the user.
6. Make updates if the user requests them.
7. If you need supporting research, hand off per the Handoff section below (requesting research).

## Delivery

1. Check that all docs you own are present and valid with `sane validate planning`
2. If the user requires any updates, proceed with updating the relevant documents.
3. Recommend starting additional Planning Assistant sessions if any other Jobs are pending. Otherwise, recommend proceeding with the execution phase once the user has approved the planning phase outside this session.
4. Once the user has approved the planning phase, hand off per the Handoff section below (normal flow).

## Handoff

Handoffs allow you to help the user start or update any other session in the workstream. Every handoff message names the workstream, the sender (`Handoff From: <Slot> Session (<id>)`), and the ask (`Message:`). Paths resolve from the workstream on Pickup. Your own slot is always resolved from the tool context — never pass it.

1. **Normal flow (no execution session yet):** check `sane sessions --slot execution`; if the slot has >1 session, ask the user which index to send to, else default latest. Then call the `sane_handoff` tool (`to: "execution"`, `message: "<action>"`, plus `session_index: <n>` when the user picked one). If no execution session is linked yet, the handoff creates it and flags it `[ready]` — the user opens it from the session list.
2. **Receiving an update:** an execution session may hand back asking for plan changes. Its `Handoff From:` line identifies the exact sender — note the id; the message is the authority on what to change, within the docs you own.
3. **Replying:** once the requested update is done (and validated), hand back to that same agent with the `sane_handoff` tool (`to: "execution"`, `message: "<what changed>"`, `to_session: "<sender id from step 2>"`). Prefer `to_session` over `session_index` for replies.
4. **Requesting research:** call the `sane_handoff` tool (`to: "research"`, `message: "<message>"`, `new_session: true`) with the ask — one or many topics, deep or varied. Prefer a fresh session per problem; omit `new_session` only when continuing the same investigation. The handoff flags the session `[ready]` — the user opens it from the session list. The researcher hands back to this session; reply to follow-ups with `to_session` from its `Handoff From:` line.

## Approval and Boundaries

- You do not edit `design/SDD.md` directly unless the user asks for it explicitly
- You can request additional engineering sessions from the user if you need more information for writing jobs
- Do not mention workstream specific patterns, workflows, or roles in the Plan or Job Specs. Keep the focus on the implementation repository.
