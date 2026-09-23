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
3. For each job, run `sane job <id> running` and launch one `sane/worker/implementer` per attempt. Give the job id and ask it to run `sane job <id>` for its Job Spec, Job Report destination/template, and context paths. Ask it to implement the Job Spec, validate its Job Report, and return the result, Job Report path, and any finding needing attention.
4. Wait for all workers in the batch to return before assessing implementation outcomes, requesting Execution Plan changes, or dispatching subsequent work. For launch failures, interruptions, or missing responses, read `resources/RETRY_POLICY.md` relative to this skill and follow its recovery rules.
5. Continue through the checkpoint's jobs, then follow Checkpoint Review and Commit before starting the next checkpoint. Track implemented jobs awaiting review separately from accepted jobs in the execution evidence. Mark accepted jobs with `sane job <id> completed`.

## Worker Recovery

1. Check available session/tool status, responses, Job Reports, and repository changes to establish whether the affected worker ran or is still running. Apply the Retry Policy to choose the next action.
2. For a finished worker with a missing response or Job Report, recover the available result or ask that worker to provide the missing return. Supply the Job Report destination and requirements when needed.
3. Before launching a replacement, confirm the previous worker has stopped. Preserve partial work and prior evidence; supply the original assignment, known changes, remaining work, and Job Report requirements as an explicit continuation instruction.
4. In a parallel batch, recover only affected invocations and retain other workers' results. Wait until every invocation has returned or its failure has been resolved before proceeding to subsequent work. Record mechanical retries against the affected assignment.

## Review and Fixes

1. When a worker reports a missing prerequisite that prevents a Job from proceeding, launch a read-only Reviewer for prerequisite-gap assessment before commissioning a correction. Supply the affected Job Spec, finding, evidence, and relevant predecessor contracts. Ask for connected gaps that must be resolved to resume that Job, not a general audit. Use `resources/FIX_AND_CORRECTION_POLICY.md` to route the assessment; ordinary bounded implementation defects can follow that policy directly.
2. For a bounded fix, launch `sane/worker/fixer` with the affected Job Specs, precise findings, allowed change boundary, relevant evidence, required verification, and stop conditions. Supply the exact Job Report path and requirements if the Job Report needs updating. Use the user's agreed correction scope and attempt limit.
3. Have the assigned worker reconcile affected Job Reports to the current outcome and validate them. Keep material evidence and accepted limitations in the existing sections; replace resolved findings rather than appending another attempt narrative.
4. After a fix for checkpoint-review findings returns, launch a read-only Reviewer with the original findings, changed implementation, and affected integration scope. Preserve review coverage of all checkpoint jobs and resolve remaining blocking findings before acceptance. Other fixes receive review at their planned checkpoint.

## Checkpoint Review and Commit

1. Launch one read-only `sane/worker/reviewer` for the checkpoint's jobs implemented since the previous checkpoint. Supply exact job ids, relevant earlier integration context, and the implementation change boundary. Ask it to obtain context paths with `sane job <id>`, compare the implementation and Job Reports with the Job Specs, and return material findings and an assessment. Additional verification should address a change, weak evidence, or a concrete concern.
2. For blocking findings, follow Review and Fixes. Resolve the checkpoint before starting its successor.
3. When the review is Complete or Complete with non-blocking observations, commit the reviewed implementation unless the user specifies otherwise. Commit authorization is the default. Inspect the diff and stage the checkpoint's changes, preserving unrelated user work. Write commit messages in the repository's style and describe the implementation change in repository terms. Do not include workstream language, SANE job IDs, checkpoint labels, agent roles, or workstream-document references in commit messages; keep that coordination context in the session with the user. Pushing requires separate user instruction. If there are no changes to commit, communicate that outcome in the session.
4. Communicate the checkpoint's review disposition, accepted limitations, and commit reference in the session with the user. Have the assigned worker reconcile its Job Report when review findings change the implementation outcome or evidence. Keep progress in job status; write the Final Report only when the user requests it.
5. Request Planning assessment when a finding materially changes upcoming assignments. Commit accepted work first, then follow Planning Corrections and wait for the reply or user instruction before advancing.

## Enriching Upcoming Job Specs

1. Between returned batches, optionally invoke `sane/worker/grounder` to enrich upcoming unstarted Job Spec Context with verified paths, symbols, interfaces, and applicable Job Report recommendations.
2. After checkpoint review, optionally assign Grounder the completed-checkpoint Job Reports and upcoming-checkpoint Job Specs for light enrichment. Name the writable unstarted Job Specs and supply review evidence. Ask it to account for existing enrichment and dependencies among upcoming jobs as well as completed predecessors.
3. Check the returned edits and warnings. Route assignment gaps or contradictory recommendations through Planning Corrections; factual enrichment keeps the assignment intact.

## Planning Corrections

1. For a finding routed to Planning, identify the affected jobs, evidence reference, and assignment change needed. Use the grouped prerequisite assessment when available; reference the evidence rather than restating it in the handoff.
2. Ask the user whether to send the request to Planning, unless the user's delegated coordination instructions already authorize it.
3. Check `sane sessions --slot planning` for the existing Planning session. If none is linked, treat the missing session as a blocker and ask the user to help recover its id from the current conversation or session records and restore the link before sending the request. If several sessions are linked, ask which to target.
4. Call `sane_handoff` (`to: "planning"`, `to_session: "<selected existing Planning session id>"`, `message: "<affected jobs, evidence, requested amendment, and waiting work>"`). If the target cannot be resolved, report the failure and resolve it with the user.
5. After sending the request, stop execution coordination and wait for Planning's reply or user instruction. When the reply arrives, read the amended artifacts and checkpoint boundaries and confirm readiness before resuming execution.

## Requesting Research

1. For deeper or more extensive research, propose the question and scope to the user and ask whether to perform a Support Handoff to Research.
2. When requested, call `sane_handoff` (`to: "research"`, `new_session: true`, `message: "<question, scope, relevant evidence>"`). Tell the user to open the new session.
3. Read returned findings and reconcile their implications with the affected assignment or the user.

## Stop and Escalation Conditions

Use bounded fixes and prerequisite assessment within the agreed coordination scope. Ask the user when resolution changes scope or acceptance, needs unavailable authorization, or reaches the agreed attempt limit. Another attempt needs a changed implementation, new evidence, or a different approach; otherwise return the discovery and required decision rather than repeating work.

## Readiness for Delivery

When authorized execution is ready, summarize the outcome and ask whether the user wants the Final Report. On request, follow `sane-assistant-execution-delivery`.

## Worker Prompt Templates

You MUST use these templates with the named worker agent. Replace placeholders with the
assigned scope and evidence. Workers inherit the session working directory;
use `sane job <id>` to resolve job context paths. Keep prompts focused on the
assignment rather than general workflow instructions.

### Implementer — `sane/worker/implementer`

```text
Implement job <id> (<name>).

Run `sane job <id>` in the session working directory for the Job Spec,
Job Report destination/template, and supporting context. Implement the assignment
and perform its required verification. Return any gap that prevents proceeding
within the assignment with concrete evidence.

Write the assigned Job Report using its template and the Job Spec's Report Requirements.
Reconcile existing sections to current outcomes and link detailed evidence.
Validate with `sane validate execution report --id <id>`.

Return Result, Report path, and Attention only when a finding needs action.
```

### Reviewer — `sane/worker/reviewer`

```text
Perform a read-only review of the combined implementation for jobs <ids>.

Run `sane job <id>` for each assigned job. Review boundary:
<base revision, relevant changes including uncommitted work, and exclusions>.
Earlier integration context: <relevant previously reviewed jobs or interfaces>.
Verification permissions and limits: <applicable checks and restrictions>.

Compare current code, tests, and Job Report evidence against each Job Spec.
Inspect the integration between these jobs. Reuse applicable verification;
additional checks should resolve a concrete concern.

Return Assessment: Complete, Complete with non-blocking observations,
Incomplete, or Blocked; material findings with evidence references; and any
acceptance-relevant limitation. Do not repeat the Job Reports.
```

For re-review, add the original findings, fix evidence, and affected integration
scope; retain the original job coverage.

For prerequisite-gap assessment, use:

```text
Assess prerequisites preventing job <id> from proceeding.
Reported gap and evidence: <finding and reference>.
Relevant predecessor contracts: <Job Spec paths or interface references>.
Inspect related prerequisites needed to resume this Job and group connected
gaps into one correction boundary. Return Readiness, findings with evidence,
and resumption conditions, distinguishing implementation defects from missing
assignments. Remain read-only and leave unrelated predecessor behavior aside.
```

### Fixer — `sane/worker/fixer`

```text
Apply a bounded fix for jobs <ids>.

Run `sane job <id>` for the affected jobs.
Findings and evidence: <specific defects and evidence pointers>.
Required outcomes: <what the fix must satisfy>.
Edit boundary: <allowed paths, relevant constraints, and excluded changes>.
Verification: <required checks and execution limits>.
Job Report assignment: <exact Job Report path and required update, or return evidence inline>.
Stop conditions: <missing requirements or changes requiring a new decision>.

Verify the correction and affected integration. Reconcile assigned Job Reports
within their existing sections and validate each with
`sane validate execution report --id <id>`.
Return Result, Report path if assigned, and Attention when needed. For an
inline-only assignment, include changed paths and essential verification.
```

### Grounder — `sane/worker/grounder`

```text
Enrich upcoming Job Spec Context for Execution.

Writable unstarted Job Specs: <exact Job Spec paths and job ids>.
Read-only inputs: <relevant completed Job Reports, reviewer assessments, and
upcoming dependency Job Specs>.
Repository inspection scope: <paths, interfaces, or questions to verify>.

Check the supplied recommendations against current implementation evidence.
Account for existing enrichment and dependencies among upcoming jobs. Edit
only Context in the writable Job Specs, adding concise applicable guidance and
Job Report section, file, or symbol references. Preserve the assignments and
distinguish delivered outputs from expected future outputs.

Return changed Job Specs, evidence used, and any unsupported recommendations,
missing required contracts, or contradictory instructions for resolution.
```

### Continuing an Interrupted Worker

After confirming the previous invocation has stopped, add this context when
resuming or replacing it with the same worker role:

```text
Continue the original assignment: <assignment>.
Previous attempt: <session id and known outcome>.
Existing changes and evidence: <paths and results>.
Remaining work: <bounded continuation>.
Report/return requirements: <destination and missing output>.

Inspect the existing work before continuing and preserve completed results.
Return the outcome and remaining issues for this continuation.
```
