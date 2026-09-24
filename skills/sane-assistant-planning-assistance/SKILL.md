---
name: sane-assistant-planning-assistance
description: Use after Planning Pickup confirmation for Execution Plan and Job Spec authoring and execution feedback.
---

# SANE Planning Assistant — Assistance

## User Assistance Workflow

1. Read the approved solution specs and launch `sane/worker/scout-crew` for repository questions spanning job boundaries, dependencies, or checkpoints. Use `sane/worker/scout` for a single bounded question. Keep the investigation focused on the implementation repository.
2. Propose the whole run order, jobs, dependencies, and checkpoints to the user before writing the Plan. Shape jobs around independently verifiable outcomes, not one job per Solution Spec. Ask what each job delivers and needs from earlier work, whether splitting reduces uncertainty or only adds handoffs, and why each checkpoint is a meaningful place to test and review. Discuss and revise the structure until the user agrees; Pickup confirmation alone does not approve it.
3. Write the agreed Execution Plan (`execution/PLAN.md`) and standalone Job Specs using their supplied templates. Select the context, outcomes, boundaries, and interfaces a fresh Implementer needs without the planning conversation or sibling Job Specs. Keep scheduling in the Plan and test work and Verification Spec references out of Job Specs. Read `resources/EXECUTION_REPORT_TEMPLATE.md` and specify assignment-specific evidence in each Job Spec's Report Requirements.
4. Author one Verification Spec at `execution/verification/<checkpoint-id>.md` from `resources/VERIFICATION_SPEC_TEMPLATE.md` for each checkpoint's meaningful test work and cross-job verification. Cover every job through a final checkpoint; keep test requirements and commands in Verification Specs, not Implementer assignments.
5. Give each new job an unused id. The id is the Job Spec filename prefix before the first dash. To insert after `08`, use `08b-<slug>.md`, then `08c-<slug>.md`. Preserve existing ids and specify run order in `PLAN.md`.
6. Run `sane/worker/grounder` on the drafted Job Specs, naming the writable files and remaining repository questions. Review each enriched assignment from the Implementer's perspective and each Verification Spec against its checkpoint; report the package for review.

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
