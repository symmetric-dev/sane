---
name: sane-assistant-planning-assistance
description: Use after Planning Pickup confirmation for Execution Plan and Job Spec authoring and execution feedback.
---

# SANE Planning Assistant — Assistance

## User Assistance Workflow

1. Propose jobs around independently verifiable outcomes, not one job per Solution Spec. Before proposing a boundary, ask: What result does it deliver? Are its inputs and contracts known? Can implementation and meaningful verification fit coherently? Would splitting reduce uncertainty or review difficulty, or only add handoffs? Would combining adjacent work avoid duplicated setup and evidence? Obtain the user's agreement before writing the Execution Plan and Job Specs; Pickup confirmation alone does not approve the Execution Plan.
2. Write the Execution Plan (`execution/PLAN.md`) and Job Specs using their supplied templates. Treat each Job Spec as a standalone worker prompt: select the context the worker needs, state the required outcome and boundaries, and provide purposeful references. The worker has not seen the planning conversation or sibling Job Specs. Translate approved decisions and dependencies into concrete starting conditions, requirements, and interfaces; keep scheduling and cross-job coordination in the Execution Plan.
3. Read `resources/EXECUTION_REPORT_TEMPLATE.md` as the individual Job Report contract. Specify only assignment-specific evidence and its authoritative location in each Job Spec's Report Requirements. Include meaningful behavior and regression checks with implementation; use separate verification jobs for cross-job integration, operational acceptance, or deployment evidence when that boundary is useful. Do not require tests merely because a job exists. Place checkpoints at coherent review boundaries, covering every job through a final checkpoint.
4. Give each new job an unused id. The id is the Job Spec filename prefix before the first dash. To insert after `08`, use `08b-<slug>.md`, then `08c-<slug>.md`. Preserve existing ids and specify run order in `PLAN.md`.
5. Run `sane/worker/grounder` for repository facts needed by the assignments, naming the writable Job Specs and inspection questions. Review each authored or enriched Job Spec from the receiving worker's perspective: can it perform and verify the assignment using the Job Spec and its named inputs? Check actionable context, known versus expected inputs, and required decisions; leave uncertain prerequisites visible rather than demanding an exhaustive repository survey.
6. Keep the Execution Plan and Job Specs focused on the implementation repository.

## Receiving Execution Feedback

1. For a work request, retain the Execution sender id from `Handoff From:`. Read the affected Job Specs and referenced findings, including any grouped prerequisite assessment. A confirmation requires no reply.
2. If the request fits existing authorization, update the Execution Plan and affected Job Specs, using Grounder where repository facts are missing. Resolve connected prerequisite gaps together so resuming the job does not require repeated isolated amendments. Reconcile checkpoints when jobs change; retain completed job identities and outcomes rather than adding attempt histories to the Execution Plan.
3. If the request requires a decision beyond existing authorization or changes approved requirements or completion criteria, ask the user directly for the next action. Wait for their decision, carry out the authorized action, and obtain their approval to send the reply to Execution.
4. Run `sane validate planning` and, if jobs were added, `sane job --register`. In-scope amendments and added jobs retain existing Planning approval.
5. Send a Live Backward Reply using `sane_handoff` (`to: "execution"`, `to_session: "<originating session id>"`, `message: "<outcome, changed files and jobs, and readiness>"`). For escalated requests, send it only after the user's approval to reply; keep the request with the user until then.

## Requesting Research

1. For deeper or more extensive research, propose a question and scope to the user and ask whether to perform a Support Handoff to Research.
2. When requested, call `sane_handoff` (`to: "research"`, `new_session: true`, `message: "<question, scope, relevant documents>"`). Tell the user to open the new session.
3. Read returned evidence and use it to ground the Execution Plan; ask the user about decisions affecting approved scope.

## Readiness for Delivery

When the initial Execution Plan and Job Specs are ready for review, follow `sane-assistant-planning-delivery`. Complete execution-feedback requests through the reply procedure above.
