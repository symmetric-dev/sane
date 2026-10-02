---
name: sane-assistant-execution-assistance
description: Use after Execution Pickup confirmation to coordinate jobs, reviews, fixes, and Execution Plan feedback.
---

# SANE Execution Assistant — Assistance

## Execution Workflow

1. Confirm the Execution Plan's run order and Execution Checkpoints with the user: sequential by default, parallel where the Execution Plan authorizes it.
2. Confirm coordination mode unless already supplied:
   - **User-directed:** return at each review checkpoint for the user's next instruction.
   - **Delegated cycle:** coordinate work within the agreed scope and attempt limit until accepted or a stop condition applies.
3. For each job, run `sane job <id> running` and start one Implementer per attempt with `sane_worker_start` (`worker: "implementer"`) with its Job Spec assignment. Use the configured worker profile, or a native subagent for a suitable assignment; collect its result and Job Report.
4. Finish independent coordination and end your turn while the batch runs. Assess returned outcomes before dispatching dependent work; ask the user about interrupted assignments.
5. Continue through the checkpoint's jobs, then follow Checkpoint Review and Commit before starting the next checkpoint. Track implemented jobs awaiting review separately from accepted jobs in the execution evidence. Mark accepted jobs with `sane job <id> completed`.

## Review and Fixes

1. Present missing prerequisites to the user for direction.
2. For a bounded production fix, start a Fixer with `sane_worker_start` (`worker: "fixer"`) with the affected Job Specs, findings, edit boundary, non-test checks, and report assignment. Route test changes to the Tester at the checkpoint.
3. Have the assigned worker reconcile affected Job Reports to the current outcome and validate them. Keep material evidence and accepted limitations in the existing sections; replace resolved findings rather than appending another attempt narrative.
4. After a checkpoint fix, have the Tester verify affected behavior and update the Test Report; ask the Reviewer to reassess the findings and checkpoint scope.

## Checkpoint Review and Commit

1. Once the checkpoint's jobs return, use `sane_worker_start` for a Tester (`worker: "tester"`), then a read-only Reviewer (`worker: "reviewer"`) to assess the combined implementation and test evidence.
2. For blocking findings, follow Review and Fixes. Resolve the checkpoint before starting its successor.
3. When the review is Complete or Complete with non-blocking observations, commit the reviewed implementation unless the user specifies otherwise. Commit authorization is the default. Inspect the diff and stage the checkpoint's changes, preserving unrelated user work. Write commit messages in the repository's style and describe the implementation change in repository terms. Do not include workstream language, SANE job IDs, checkpoint labels, agent roles, or workstream-document references in commit messages; keep that coordination context in the session with the user. Pushing requires separate user instruction. If there are no changes to commit, communicate that outcome in the session.
4. Communicate the checkpoint's review disposition, accepted limitations, and commit reference in the session with the user. Have the assigned worker reconcile its Job Report when review findings change the implementation outcome or evidence. Keep progress in job status; write the Final Report only when the user requests it.
5. After each accepted checkpoint, send Planning the Job Reports, Test Report, and reviewer findings for a look-ahead at upcoming assignments, even when no gap is known. Commit accepted work first, then follow Planning Review and Corrections before advancing.

## Enriching Upcoming Job Specs

1. Between returned batches, optionally invoke `sane_worker_start` (`worker: "grounder"`) to enrich upcoming unstarted Job Spec Context with verified paths, symbols, interfaces, and applicable Job Report recommendations.
2. After checkpoint review, optionally assign Grounder the completed-checkpoint Job Reports and upcoming-checkpoint Job Specs for light enrichment. Name the writable unstarted Job Specs and supply review evidence. Ask it to account for existing enrichment and dependencies among upcoming jobs as well as completed predecessors.
3. Check the returned edits and warnings. Route assignment gaps or contradictory recommendations through Planning Review and Corrections; factual enrichment keeps the assignment intact.

## Planning Review and Corrections

1. After each accepted checkpoint, call `sane_handoff` (`requestId: "<my-readable-unique-id-01>"`, `to: "planning"`, `message: "<Job Reports, Test Report, reviewer findings, and upcoming jobs for reassessment>"`). Reference the evidence rather than restating it.
2. End your turn while Planning reviews the evidence. On its reply, read amended documents and confirm the next assignment before starting the next checkpoint.

## Requesting Support

You can request support to specialized Support Tracks. When sending handoffs back to Planning, consider recommending Curation support if Operational Gaps are discovered during execution. Then, at the end of the Execution lifecycle, recommend Curation to the user to synthesize execution learnings into reusable Context Artifacts like skills or documentation.

Here is how to request a Support Handoff:

1. Propose the support question and scope to the user and ask whether to perform a Support Handoff.
2. When requested, call `sane_handoff` (`requestId: "<my-readable-unique-id-01>"`, `to: "<support track>"`, `createNew: true`, `message: "<question, scope, relevant evidence>"`). Summarize the dispatched request.
3. Read returned evidence and discuss its implications with the user before applying changes within the authorized scope.

## Stop and Escalation Conditions

Use `sane_worker_cancel` to stop selected workers or `sane_worker_cancel_all` for the worker tree. Stopping the parent leaves workers running and pauses automatic continuation until user resumption. Stay within the agreed coordination scope and attempt limit. Stop and ask the user for direction on work outside that scope or on a reported blocker. Do not repeat an attempt without new evidence or a changed approach.

## Readiness for Delivery

When authorized execution is ready, summarize the outcome and ask whether the user wants the Final Report. On request, follow `sane-assistant-execution-delivery`.

## Worker Assignments

Give each worker the exact scope, paths, evidence, and decision boundaries for its assignment; its agent instructions supply the standing procedure. Workers inherit the implementation checkout; supply the evidence they need in `prompt` or `context`, since the parent transcript is not copied. Use `sane_worker_wait` for a bounded join when useful; use `sane_worker_acknowledge` for results handled through wait/status with their exact revision and notification references to avoid a later duplicate report-back.

- **Implementer:** Supply the job id and ask it to run `sane job <id>` for the Job Spec, context, and Job Report assignment. Keep Verification Specs out of its context.
- **Tester:** Supply the checkpoint Verification Spec, affected Job Specs and Reports, implementation changes, test edit boundary, and `execution/test-reports/<checkpoint-id>.md` with its template.
- **Reviewer:** Supply the checkpoint's job ids, Job Specs and Reports, change boundary including uncommitted work, Verification Spec, Test Report, relevant earlier integration context, and check limits. For re-review, add the findings and fix evidence.
- **Fixer:** Supply the affected Job Specs, findings, required outcome, allowed edits, non-test checks, stop conditions, and exact Job Report assignment.
- **Grounder:** Supply the writable unstarted Job Specs, read-only reports and assessments, and bounded repository questions. Execution enrichment edits Context only.
