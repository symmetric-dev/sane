---
name: sane-assistant-planning-assistance
description: Use after Planning Pickup confirmation for Execution Plan and Job Spec authoring and execution feedback.
---

# SANE Planning Assistant — Assistance

## User Assistance Workflow

1. Read the approved solution specs and launch `sane_worker_start` (`worker: "scout-crew"`) for repository questions spanning job boundaries, dependencies, or checkpoints. Include a bounded map of the repository entry points, defined commands, the repository's skills directory (`.agents/skills/*/SKILL.md`), and operational prerequisites relevant to the solution areas. Have scouts list skills by each skill's frontmatter `name` and `description` without auditing the bodies. Use `sane_worker_start` (`worker: "scout"`) for a single bounded question. Keep the investigation focused on the implementation repository; do not turn scouting into a skill-currency audit. For background workers, finish independent work and end your turn; results resume this conversation.
2. Propose the whole run order, jobs, dependencies, and checkpoints to the user before writing the Plan. Shape jobs around independently verifiable outcomes, not one job per Solution Spec. Ask what each job delivers and needs from earlier work, whether splitting reduces uncertainty or only adds handoffs, and why each checkpoint is a meaningful place to test and review. Discuss and revise the structure until the user agrees; Pickup confirmation alone does not approve it.
3. Write the agreed Execution Plan (`execution/PLAN.md`) and standalone Job Specs using their supplied templates. Select the context, outcomes, boundaries, and interfaces a fresh Implementer needs without the planning conversation or sibling Job Specs. In each Job Spec's Operational Readiness, select applicable repository skills, safe preflight checks, required starting state, and evidence-based stop conditions from the scouting findings; reference reusable procedures rather than copying them. State when no additional preflight is needed. Keep scheduling in the Plan and test work and Verification Spec references out of Job Specs. Read `<workstream>/resources/EXECUTION_REPORT_TEMPLATE.md` and specify assignment-specific evidence in each Job Spec's Report Requirements.
4. Author one Verification Spec at `execution/verification/<checkpoint-id>.md` from `<workstream>/resources/VERIFICATION_SPEC_TEMPLATE.md` for each checkpoint's meaningful test work and cross-job verification. Cover every job through a final checkpoint; keep test requirements and commands in Verification Specs, not Implementer assignments.
5. Give each new job an unused id. The id is the Job Spec filename prefix before the first dash. To insert after `08`, use `08b-<slug>.md`, then `08c-<slug>.md`. Preserve existing ids and specify run order in `PLAN.md`.
6. Run `sane_worker_start` (`worker: "grounder"`) on the drafted Job Specs, naming the writable files and remaining repository questions. Have it corroborate readiness references and command definitions, not refresh the skills. Review each enriched assignment from the Implementer's perspective and each Verification Spec against its checkpoint; report the package for review.

## Receiving Execution Feedback

1. Retain the Execution qualified sender identity from `From:`. Read the referenced Job Reports, Test Report, and reviewer findings, and reassess upcoming Job Specs, Verification Specs, and checkpoint order.
2. Update affected Planning documents within the authorized scope. Job Specs may be amended before or during implementation; coordinate amendments to active assignments with Execution. **Editing a Job Spec after its job is completed is forbidden, including its Context and Operational Readiness.** Subsequent revisions require new jobs or amendments to existing non-completed jobs. Flag reusable skill corrections for separate maintenance rather than silently refreshing skills here. Ask the user to decide matters outside the approved scope. Run `sane validate planning` after changes and `sane job --register` for added jobs.
3. When a shared Solution Spec needs correction to support current or future assignments, coordinate the authorized correction with Engineering through the existing handoff procedure. After Engineering returns, update only affected non-completed Job Specs or author new jobs. Differences between completed assignments and revised Solution Specs do not require retrospective reconciliation.
4. Reply using `sane_handoff` (`requestId: "<my-readable-unique-id-01>"`, `to: "execution"`, `target: <sender identity>`, `message: "<readiness and changed documents, or no change>"`).

## Requesting Support

You can request support to specialized Support Tracks. Use Curation to solve Operational Gaps or reduce operational friction in the development environment of the implementation repository, as well as help abstract repeated work into reusable Context Artifacts like skills or documentation. Consider a handoff back to Engineering when new Knowledge Gaps are discovered during planning.

Here is how to request a Support Handoff:

1. Propose the support question and scope to the user and ask whether to perform a Support Handoff.
2. When requested, call `sane_handoff` (`requestId: "<my-readable-unique-id-01>"`, `to: "<support track>"`, `createNew: true`, `message: "<question, scope, relevant evidence>"`). Summarize the dispatched request.
3. Read returned evidence and discuss its implications with the user before applying changes within the authorized scope.

## Readiness for Delivery

When the initial Execution Plan and Job Specs are ready for review, follow `sane-assistant-planning-delivery`. Complete execution-feedback requests through the reply procedure above.
