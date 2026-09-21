---
name: sane-assistant-planning-assistance
description: Use after Planning Pickup confirmation for plan authoring and execution feedback.
---

# SANE Planning Assistant — Assistance

## User Assistance Workflow

1. Propose an execution plan and obtain the user's agreement before writing the plan and Job Specs. Pickup confirmation alone does not approve the proposed plan.
2. Write `execution/PLAN.md` and Job Specs using their supplied templates. Place Execution Checkpoints at coherent review boundaries and before major dependency transitions, covering every job through a final checkpoint.
3. Give each new job an unused id. The id is the filename prefix before the first dash. To insert after `08`, use `08b-<slug>.md`, then `08c-<slug>.md`. Preserve existing ids and specify run order in `PLAN.md`.
4. Run `sane/worker/grounder` for bounded repository context, assigning one Job Spec per worker. Review the enriched specs and discuss revisions with the user.
5. Keep the plan and Job Specs focused on the implementation repository.

## Receiving Execution Feedback

1. Retain the Execution sender id from `Handoff From:`. Read the relevant reports, available reviewer findings, and affected jobs.
2. If the request fits existing authorization, update the plan and affected jobs, using Grounder for repository context, then validate and reply. Reconcile checkpoint coverage and boundaries whenever jobs change. Use Execution's returned attempt evidence for unfinished jobs and preserve completed job history.
3. If the request requires a decision beyond existing authorization or changes approved requirements or completion criteria, ask the user directly for the next action. Wait for their decision, carry out the authorized action, and obtain their approval to send the reply to Execution.
4. Run `sane validate planning` and, if jobs were added, `sane job --register`. In-scope amendments and added jobs retain existing Planning approval.
5. Send a Live Backward Reply using `sane_handoff` (`to: "execution"`, `to_session: "<originating session id>"`, `message: "<outcome, changed files and jobs, and readiness>"`). For escalated requests, send it only after the user's approval to reply; keep the request with the user until then.

## Requesting Research

1. For deeper or more extensive research, propose a question and scope to the user and ask whether to perform a Support Handoff to Research.
2. When requested, call `sane_handoff` (`to: "research"`, `new_session: true`, `message: "<question, scope, relevant documents>"`). Tell the user to open the new session.
3. Read returned evidence and use it to ground the plan; ask the user about decisions affecting approved scope.

## Readiness for Delivery

When the initial plan and jobs are ready for review, follow `sane-assistant-planning-delivery`. Complete execution-feedback requests through the reply procedure above.
