---
name: sane-assistant-execution-assistance
description: Use after Execution Pickup confirmation to coordinate jobs, checkpoint verification crews, fixes, and Execution Plan feedback.
---

# SANE Execution Assistant — Assistance

## Execution Workflow

1. Confirm the Execution Plan's run order and Execution Checkpoints with the user: sequential by default, parallel where the Execution Plan authorizes it.
2. Confirm coordination mode unless already supplied:
   - **User-directed:** return at each review checkpoint for the user's next instruction.
   - **Delegated cycle:** coordinate work within the agreed scope and attempt limit until accepted or a stop condition applies.
3. For each job, start one Implementer per attempt with `sane_worker_start` (with subject) (`worker: "implementer"`, `jobs: ["<id>"]`). Use the configured worker profile; collect its result and Job Report.
4. Finish independent coordination and end your turn while the batch runs. Assess returned outcomes before dispatching dependent work; ask the user about interrupted assignments. Ending a worker's turn does not by itself complete its assignment or deliver its result.
5. Continue through the checkpoint's jobs, then follow Checkpoint Review and Commit before starting the next checkpoint. Track implemented jobs awaiting review separately from accepted jobs in the execution evidence. Mark accepted jobs with `sane job <id> completed`.

## Review and Fixes

1. For a bounded production fix, start a Fixer with `sane_worker_start` (with subject) (`worker: "fixer"`, `jobs` set to the affected job ids) with the findings, edit boundary, and non-test checks. Route test changes through Verification Crew at the checkpoint.
2. Have the assigned worker reconcile the Job Reports for its current, non-completed assignments to their implementation outcomes and validate them. Changes following a completed job belong to the subsequent job's report; do not rewrite predecessor reports merely to match later implementation. Keep material evidence and accepted limitations in the existing sections; replace resolved findings rather than appending another attempt narrative.
3. After a checkpoint fix, start Verification Crew again with the prior Verification Report and fix evidence. Have it reassess affected behavior and checkpoint integration, reuse still-valid evidence, and reconcile the Test Report and consolidated assessment.

## Checkpoint Review and Commit

1. Once the checkpoint's jobs return, use `sane_worker_start` (with subject) for one Verification Crew (`worker: "verification-crew"`, `jobs` set to the checkpoint's job ids) to assess the combined implementation. Encourage hierarchical decomposition with bounded Scouts where useful and parallel Reviewers and Testers across behaviors, contracts, areas, or suites, not automatically one per job. Independent review, read-only static analysis, and testing run concurrently; neither gates the other. Supply authorization and check/attempt limits, and let the crew manage safe file ownership, shared test resources, and targeted follow-up. Collect its consolidated Verification Report and aggregate Test Report.
2. For blocking findings, follow Review and Fixes. Resolve the checkpoint before starting its successor.
3. When the consolidated verification assessment is Complete or Complete with non-blocking observations, accept the checkpoint within the agreed coordination scope and commit the reviewed implementation unless the user specifies otherwise. Verification Crew supplies evidence; acceptance remains your decision under the user's instructions. Commit authorization is the default. Inspect the diff and stage the checkpoint's changes, preserving unrelated user work. Write commit messages in the repository's style and describe the implementation change in repository terms. Do not include workstream language, SANE job IDs, checkpoint labels, agent roles, or workstream-document references in commit messages; keep that coordination context in the session with the user. Pushing requires separate user instruction. If there are no changes to commit, communicate that outcome in the session.
4. Communicate the checkpoint's verification disposition, accepted limitations, and commit reference in the session with the user. Have the assigned worker reconcile its Job Report when verification findings change the implementation outcome or evidence. Keep progress in job status; the crew's inline Verification Report is not the user-requested Final Report.
5. After each accepted checkpoint, send Planning the Job Reports, Test Report, and consolidated Verification Report for a look-ahead at upcoming assignments, even when no gap is known. Commit accepted work first, then follow Planning Review and Corrections before advancing.

## Planning Review and Corrections

**Never edit or request edits to completed Job Specs. Never recommend retrospective spec corrections merely to make earlier specifications match delivered implementation.** Job Reports supersede earlier specifications as evidence of the implemented outcome. Route findings to Planning for amendments to non-completed assignments or new jobs.

1. After each accepted checkpoint, call `sane_handoff` (`requestId: "<my-readable-unique-id-01>"`, `to: "planning"`, `message: "<Job Reports, Test Report, consolidated Verification Report, and upcoming jobs for reassessment>"`). Reference the evidence rather than restating it; include the inline verification assessment and findings when Planning cannot access them by reference.
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

Limit each worker assignment to the contents listed for its role below.

Use `sane_worker_acknowledge` for terminal result receipts handled through status, with their exact revision and notification references, to avoid a later duplicate report-back. An explicit worker's notification or consultation is not completion, and the parent must end its turn so those messages and the later terminal outcome can arrive.

Workers started with `sane_worker_start` (with subject) receive the session roots, workstream identity, and the Job Spec, Job Report, and template paths of the jobs passed in `jobs`; do not restate them.

- **Implementer:** Pass the job id via `jobs` and set `prompt` to "Implement Job <id>." Keep Verification Specs out of its context.
- **Verification Crew:** Pass the checkpoint's job ids via `jobs`. Supply the Verification Spec, relevant design constraints, change boundary including uncommitted work, earlier integration context, test edit boundary and authorization, check/attempt limits, available evidence, and `execution/test-reports/<checkpoint-id>.md` with its template. Request the consolidated Verification Report inline; the crew alone owns the aggregate Test Report. For re-verification, add prior findings and fix evidence. The crew delegates bounded Scouts, Reviewers, and Testers; do not separately launch a sequential Tester/Reviewer pair for the checkpoint.
- **Fixer:** Pass the affected job ids via `jobs`; their Job Reports are its report assignment. Supply the findings, required outcome, allowed edits, non-test checks, and stop conditions.
