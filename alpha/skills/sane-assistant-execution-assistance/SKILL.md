---
name: sane-assistant-execution-assistance
description: Use after Execution Pickup confirmation to coordinate jobs, reviews, fixes, and plan feedback.
---

# SANE Execution Assistant — Assistance

## Execution Workflow

1. Confirm the plan's run order and Execution Checkpoints with the user: sequential by default, parallel where the plan authorizes it.
2. Confirm coordination mode unless already supplied:
   - **User-directed:** return at each review checkpoint for the user's next instruction.
   - **Delegated cycle:** coordinate work within the agreed scope and attempt limit until accepted or a stop condition applies.
3. For each job, run `sane job <id> running` and launch one `sane/worker/implementer` per attempt. Give the job id and ask it to run `sane job <id> --json` for its spec, report destination/template, and context. Ask it to implement the spec and return changes, verification, report path, deviations, blockers, and optional recommendations with evidence.
4. Wait for all batch jobs workers to return before assessing implementation outcomes, requesting plan changes, or dispatching subsequent work. For launch failures, interruptions, or missing responses, read `resources/RETRY_POLICY.md` relative to this skill and follow its recovery rules.
5. Continue through the checkpoint's jobs, then follow Checkpoint Review and Commit before starting the next checkpoint. Track implemented jobs awaiting review separately from accepted jobs in the execution evidence. Mark accepted jobs with `sane job <id> completed`.

## Worker Recovery

1. Check available session/tool status, responses, reports, and repository changes to establish whether the affected worker ran or is still running. Apply the Retry Policy to choose the next action.
2. For a finished worker with a missing response or report, recover the available result or ask that worker to provide the missing return. Supply the report destination and requirements when needed.
3. Before launching a replacement, confirm the previous worker has stopped. Preserve partial work and prior evidence; supply the original assignment, known changes, remaining work, and reporting requirements as an explicit continuation instruction.
4. In a parallel batch, recover only affected invocations and retain other workers' results. Wait until every invocation has returned or its failure has been resolved before proceeding to subsequent work. Record mechanical retries against the affected assignment.

## Review and Fixes

1. When an Implementer, Reviewer, or Grounder reports a gap, read `resources/FIX_AND_CORRECTION_POLICY.md` relative to this skill and follow its routing procedure.
2. For a bounded fix, launch `sane/worker/fixer` with the affected jobs, precise findings, allowed change boundary, relevant evidence, required verification, and stop conditions. Supply the exact report path and requirements if the report needs updating. Use the user's agreed correction scope and attempt limit.
3. Preserve prior reports and record the finding, chosen action, attempt outcomes, verification, and user decisions in the execution evidence. Link the details from the checkpoint record in `execution/FINAL_REPORT.md`.
4. After a fix for checkpoint-review findings returns, launch a read-only Reviewer with the original findings, changed implementation, and affected integration scope. Preserve review coverage of all checkpoint jobs and resolve remaining blocking findings before acceptance. Other fixes receive review at their planned checkpoint.

## Checkpoint Review and Commit

1. Launch one read-only `sane/worker/reviewer` for the checkpoint's jobs implemented since the previous checkpoint. Supply exact job ids, relevant earlier integration context, and the implementation change boundary. Ask it to obtain each context bundle with `sane job <id> --json`, compare the combined current implementation and reports with the assignments, and return findings and a completion assessment. Ask which recommendations are supported and which need evidence.
2. For blocking findings, follow Review and Fixes. Resolve the checkpoint before starting its successor.
3. When the review is Complete or Complete with non-blocking observations, commit the reviewed implementation unless the user specifies otherwise. Commit authorization is the default. Inspect the diff and stage the checkpoint's changes, preserving unrelated user work. Write commit messages in the repository's style and describe the implementation change in repository terms. Do not include workstream language, SANE job IDs, checkpoint labels, agent roles, or workstream-document references in commit messages; keep that coordination context in execution reports. Pushing requires separate user instruction. If there are no changes to commit, record that outcome.
4. Record the checkpoint's job coverage, review evidence, accepted observations, and commit hash in `execution/FINAL_REPORT.md` using its template. Keep the record current as execution proceeds.
5. Consider whether accepted test failures, recurring workarounds, or coordination difficulties warrant Planning assessment. Commit accepted work first, then follow Planning Corrections and wait for the reply or user instruction before advancing.

## Enriching Upcoming Jobs

1. Between returned batches, optionally invoke `sane/worker/grounder` to enrich upcoming unstarted Job Spec Context with verified paths, symbols, interfaces, and applicable report guidance.
2. After checkpoint review, optionally assign Grounder the completed-checkpoint reports and upcoming-checkpoint specs for light enrichment. Name the writable unstarted specs and supply review evidence. Ask it to account for existing enrichment and dependencies among upcoming jobs as well as completed predecessors.
3. Check the returned edits and warnings. Route assignment gaps or contradictory recommendations through Planning Corrections; factual enrichment keeps the assignment intact.

## Planning Corrections

1. For a finding routed to Planning, gather the affected jobs, report and review references, expected versus actual outputs, fixes already attempted, and impact on upcoming work.
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

## Worker Prompt Templates

You MUST use these templates with the named worker agent. Replace placeholders with the
assigned scope and evidence. Workers inherit the session working directory;
use `sane job <id> --json` to resolve job context. Keep prompts focused on the
assignment rather than general workflow instructions.

### Implementer — `sane/worker/implementer`

```text
Implement job <id> (<name>).

Run `sane job <id> --json` in the session working directory for the Job Spec,
report destination/template, and supporting context. Implement the assignment
and perform its required verification. Return any gap that prevents proceeding
within the assignment with concrete evidence.

Write the report at the bundle's report_path using report_template and the
Job's Report Requirements. Preserve existing report evidence when continuing
an earlier attempt. Include applicable Implementation Recommendations with
evidence and limits.

Return the implementation result, changed files, verification results, report
path, deviations, and unresolved findings.
```

### Reviewer — `sane/worker/reviewer`

```text
Perform a read-only review of the combined implementation for jobs <ids>.

Run `sane job <id> --json` for each assigned job. Review boundary:
<base revision, relevant changes including uncommitted work, and exclusions>.
Earlier integration context: <relevant previously reviewed jobs or interfaces>.
Verification permissions and limits: <applicable checks and restrictions>.

Compare current code, tests, and report evidence against each assignment.
Independently verify claims and inspect the integration between these jobs.
Assess Implementation Recommendations as supported, needs evidence, or invalid,
with applicability and evidence pointers.

Return severity-ordered findings, criterion-level evidence, verification
results, coverage limitations, recommendations suitable for forwarding, and
one assessment: Complete, Complete with non-blocking observations, Incomplete,
or Blocked.
```

For re-review, add the original findings, fix evidence, and affected integration
scope; retain the original job coverage.

### Fixer — `sane/worker/fixer`

```text
Apply a bounded fix for jobs <ids>.

Run `sane job <id> --json` for the affected jobs.
Findings and evidence: <specific defects and evidence pointers>.
Required outcomes: <what the fix must satisfy>.
Edit boundary: <allowed paths, relevant constraints, and excluded changes>.
Verification: <required checks and execution limits>.
Report assignment: <exact report path and required update, or return evidence inline>.
Stop conditions: <missing requirements or changes requiring a new decision>.

Verify the complete assigned boundary and preserve prior report evidence.
Return changed files, outcomes, verification results, any updated report paths,
and remaining findings or decisions needed.
```

### Grounder — `sane/worker/grounder`

```text
Enrich upcoming Job Spec Context for Execution.

Writable unstarted specs: <exact spec paths and job ids>.
Read-only inputs: <relevant completed-job reports, reviewer assessments, and
upcoming dependency specs>.
Repository inspection scope: <paths, interfaces, or questions to verify>.

Check the supplied recommendations against current implementation evidence.
Account for existing enrichment and dependencies among upcoming jobs. Edit
only Context in the writable specs, adding concise applicable guidance and
report-section, file, or symbol references. Preserve the assignments and
distinguish delivered outputs from expected future outputs.

Return changed specs, evidence used, and any unsupported recommendations,
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
Report/return requirements: <destination, prior evidence to preserve, and missing output>.

Inspect the existing work before continuing and preserve completed results.
Return the outcome and remaining issues for this continuation.
```
