---
name: sane-assistant-planning-assistance
description: Use after Planning Pickup confirmation for Execution Plan and Job Spec authoring and execution feedback.
---

# SANE Planning Assistant — Assistance

## User Assistance Workflow

1. Propose jobs around independently verifiable outcomes, not one job per Solution Spec. Before proposing a boundary, ask: What result does it deliver? Are its inputs and contracts known? Can implementation fit coherently? Would splitting reduce uncertainty or review difficulty, or only add handoffs? Would combining adjacent work avoid duplicated setup? Obtain the user's agreement before writing the Execution Plan and Job Specs; Pickup confirmation alone does not approve the Execution Plan.
2. Write the Execution Plan (`execution/PLAN.md`) and Job Specs using their supplied templates. Treat each Job Spec as a standalone Implementer assignment: select the context the worker needs, state the required outcome and boundaries, and provide purposeful references. The worker has not seen the planning conversation or sibling Job Specs. Translate approved decisions and dependencies into concrete starting conditions, requirements, and interfaces; keep scheduling and cross-job coordination in the Execution Plan. Keep test work and Verification Spec references out of Job Specs.
3. Read `resources/EXECUTION_REPORT_TEMPLATE.md` as the individual Job Report contract. Specify only assignment-specific evidence and its authoritative location in each Job Spec's Report Requirements. Place checkpoints at coherent review boundaries, covering every job through a final checkpoint. Author one Verification Spec at `execution/verification/<checkpoint-id>.md` from `resources/VERIFICATION_SPEC_TEMPLATE.md` for each checkpoint's meaningful test work and cross-job verification. Avoid tests merely because a job exists; keep test requirements and commands in the Verification Spec, outside Implementer assignments.
4. Give each new job an unused id. The id is the Job Spec filename prefix before the first dash. To insert after `08`, use `08b-<slug>.md`, then `08c-<slug>.md`. Preserve existing ids and specify run order in `PLAN.md`.
5. Run `sane/worker/grounder` for repository facts needed by the assignments, naming the writable Job Specs and inspection questions. Review each Job Spec from the Implementer's perspective: can it perform the assignment using its named inputs? Review Verification Specs against the checkpoints they cover.
6. Keep the Execution Plan and Job Specs focused on the implementation repository.

## Receiving Execution Feedback

1. Retain the Execution sender id from `Handoff From:`. Read the referenced Job Reports, Test Report, and reviewer findings, and reassess upcoming Job Specs, Verification Specs, and checkpoint order.
2. Update the affected Planning documents as authorized. Ask the user to decide matters outside the approved scope. Run `sane validate planning` after changes and `sane job --register` for added jobs.
3. Reply using `sane_handoff` (`to: "execution"`, `to_session: "<originating session id>"`, `message: "<readiness and changed documents, or no change>"`).

## Requesting Research

1. For deeper or more extensive research, propose a question and scope to the user and ask whether to perform a Support Handoff to Research.
2. When requested, call `sane_handoff` (`to: "research"`, `new_session: true`, `message: "<question, scope, relevant documents>"`). Tell the user to open the new session.
3. Read returned evidence and use it to ground the Execution Plan; ask the user about decisions affecting approved scope.

## Readiness for Delivery

When the initial Execution Plan and Job Specs are ready for review, follow `sane-assistant-planning-delivery`. Complete execution-feedback requests through the reply procedure above.
