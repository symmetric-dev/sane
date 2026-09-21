---
name: sane-assistant-execution-assistance
description: Use after Execution Pickup confirmation to coordinate jobs, reviews, fixes, and plan feedback.
---

# SANE Execution Assistant — Assistance

## Execution Workflow

1. Confirm the plan's run order and Execution Checkpoints with the user: sequential by default, parallel where the plan authorizes it. Ask Planning to reconcile missing or inconsistent checkpoint coverage before dispatch.
2. Confirm coordination mode unless already supplied:
   - **User-directed:** return at each review checkpoint for the user's next instruction.
   - **Delegated cycle:** coordinate work within the agreed scope and attempt limit until accepted or a stop condition applies.
3. For each job, run `sane job <id> running` and launch one `sane/worker/implementer` per attempt. Give the job id and ask it to run `sane job <id> --json` for its spec, report destination/template, and context. Ask it to implement the spec and return changes, verification, report path, deviations, blockers, and optional recommendations with evidence. Existing reports require reconciliation before another attempt; preserve prior evidence.
4. Treat each dispatched batch as blocking: wait for all its workers to return before assessing implementation outcomes, requesting plan changes, or dispatching subsequent work. For launch failures, interruptions, or missing responses, read `resources/RETRY_POLICY.md` relative to this skill and follow its recovery rules. Address returned blockers and gaps immediately using Review and Fixes, even before a checkpoint is reached.
5. Continue through the checkpoint's jobs, then follow Checkpoint Review and Commit before starting the next checkpoint. Track implemented jobs awaiting review separately from accepted jobs in the execution evidence. Mark accepted jobs with `sane job <id> completed`.

## Worker Recovery

1. Check available session/tool status, responses, reports, and repository changes to establish whether the affected worker ran or is still running. Apply the Retry Policy to choose the next action.
2. For a finished worker with a missing response or report, recover the available result or ask that worker to provide the missing return. Supply the report destination and requirements when needed.
3. Before launching a replacement, confirm the previous worker has stopped. Preserve partial work and prior evidence; supply the original assignment, known changes, remaining work, and reporting requirements as an explicit continuation instruction.
4. In a parallel batch, recover only affected invocations and retain other workers' results. Keep the batch blocked until its invocations are resolved. Record mechanical retries against the affected assignment.

## Review and Fixes

1. When an Implementer, Reviewer, or Grounder reports a gap, read `resources/FIX_AND_CORRECTION_POLICY.md` relative to this skill and follow its routing procedure.
2. Use the user's agreed correction scope and attempt limit. Ask when the next corrective action or its limit is unclear.
3. Preserve attempt reports and verification evidence when retrying. Obtain checkpoint review of the resulting implementation before committing and advancing.

## Checkpoint Review and Commit

1. Launch one read-only `sane/worker/reviewer` for the checkpoint's jobs implemented since the previous checkpoint. Supply exact job ids, relevant earlier integration context, and the implementation change boundary. Ask it to obtain each context bundle with `sane job <id> --json`, compare the combined current implementation and reports with the assignments, and return findings and a completion assessment. Ask which recommendations are supported and which need evidence.
2. For blocking findings, follow Review and Fixes. Resolve the checkpoint before starting its successor.
3. When the review is Complete or Complete with non-blocking observations, commit the reviewed implementation unless the user specifies otherwise. Commit authorization is the default. Inspect the diff and stage the checkpoint's changes, preserving unrelated user work. Pushing requires separate user instruction. If there are no changes to commit, record that outcome.
4. Record the checkpoint's job coverage, review evidence, accepted observations, and commit hash in `execution/FINAL_REPORT.md` using its template. Keep the record current as execution proceeds.
5. Consider whether accepted test failures, recurring workarounds, or coordination difficulties warrant Planning assessment. Commit accepted work first, then follow Planning Corrections and wait for the reply or user instruction before advancing.

## Enriching Upcoming Jobs

1. Between returned batches, optionally invoke `sane/worker/grounder` to enrich upcoming unstarted Job Spec Context with verified paths, symbols, interfaces, and applicable report guidance.
2. After checkpoint review, optionally assign Grounder the completed-checkpoint reports and upcoming-checkpoint specs for light enrichment. Name the writable unstarted specs and supply review evidence. Ask it to account for existing enrichment and dependencies among upcoming jobs as well as completed predecessors.
3. Check the returned edits and warnings. Route assignment gaps or contradictory recommendations through Planning Corrections; factual enrichment keeps the assignment intact.

## Planning Corrections

1. Identify findings that require changed assignments, dependencies, order, or new jobs. Read the supporting report and reviewer evidence.
2. Ask the user whether to send the request to Planning, unless the user's delegated coordination instructions already authorize it.
3. Check `sane sessions --slot planning` for the existing Planning session. If none is linked, treat the missing session as a blocker and ask the user to help recover its id from the current conversation or session records and restore the link before sending the request. If several sessions are linked, ask which to target.
4. Call `sane_handoff` (`to: "planning"`, `to_session: "<selected existing Planning session id>"`, `message: "<affected jobs, evidence, requested amendment, and waiting work>"`). If the target cannot be resolved, report the failure and resolve it with the user.
5. After sending the request, stop execution coordination and wait for Planning's reply or user instruction. When the reply arrives, read the amended artifacts and checkpoint boundaries and confirm readiness before resuming execution.

## Requesting Research

1. For deeper or more extensive research, propose the question and scope to the user and ask whether to perform a Support Handoff to Research.
2. When requested, call `sane_handoff` (`to: "research"`, `new_session: true`, `message: "<question, scope, relevant evidence>"`). Tell the user to open the new session.
3. Read returned findings and reconcile their implications with the affected assignment or the user.

## Stop and Escalation Conditions

Ask the user when work exceeds authorized scope, needs a changed acceptance decision, reaches the agreed attempt limit, or has an unresolved blocker. Pause affected work and report the required decision.

## Readiness for Delivery

When authorized execution is ready for acceptance, follow `sane-assistant-execution-delivery`.
