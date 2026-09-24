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
3. For each job, run `sane job <id> running` and launch one `sane/worker/implementer` per attempt. Give it the job id and Job Spec context, not the Verification Spec. Have it implement, perform non-test checks, validate its Job Report, and return the result.
4. Wait for the batch to return before assessing outcomes or dispatching subsequent work. Stop and ask the user about interrupted assignments.
5. Continue through the checkpoint's jobs, then follow Checkpoint Review and Commit before starting the next checkpoint. Track implemented jobs awaiting review separately from accepted jobs in the execution evidence. Mark accepted jobs with `sane job <id> completed`.

## Review and Fixes

1. Present missing prerequisites to the user for direction.
2. For a bounded production fix, launch `sane/worker/fixer` with the affected Job Specs, findings, edit boundary, non-test checks, and report assignment. Route test changes to the Tester at the checkpoint.
3. Have the assigned worker reconcile affected Job Reports to the current outcome and validate them. Keep material evidence and accepted limitations in the existing sections; replace resolved findings rather than appending another attempt narrative.
4. After a checkpoint fix, have the Tester verify affected behavior and update the Test Report; ask the Reviewer to reassess the findings and checkpoint scope.

## Checkpoint Review and Commit

1. Once the checkpoint's jobs return, launch `sane/worker/tester` with its Verification Spec, Test Report template and destination, and the implemented changes. Have it write and run focused tests and record the outcome. Then launch a read-only `sane/worker/reviewer` with the Job Specs, Verification Spec, Job Reports, and Test Report to assess the checkpoint.
2. For blocking findings, follow Review and Fixes. Resolve the checkpoint before starting its successor.
3. When the review is Complete or Complete with non-blocking observations, commit the reviewed implementation unless the user specifies otherwise. Commit authorization is the default. Inspect the diff and stage the checkpoint's changes, preserving unrelated user work. Write commit messages in the repository's style and describe the implementation change in repository terms. Do not include workstream language, SANE job IDs, checkpoint labels, agent roles, or workstream-document references in commit messages; keep that coordination context in the session with the user. Pushing requires separate user instruction. If there are no changes to commit, communicate that outcome in the session.
4. Communicate the checkpoint's review disposition, accepted limitations, and commit reference in the session with the user. Have the assigned worker reconcile its Job Report when review findings change the implementation outcome or evidence. Keep progress in job status; write the Final Report only when the user requests it.
5. After each accepted checkpoint, send Planning the Job Reports, Test Report, and reviewer findings for a look-ahead at upcoming assignments, even when no gap is known. Commit accepted work first, then follow Planning Review and Corrections before advancing.

## Enriching Upcoming Job Specs

1. Between returned batches, optionally invoke `sane/worker/grounder` to enrich upcoming unstarted Job Spec Context with verified paths, symbols, interfaces, and applicable Job Report recommendations.
2. After checkpoint review, optionally assign Grounder the completed-checkpoint Job Reports and upcoming-checkpoint Job Specs for light enrichment. Name the writable unstarted Job Specs and supply review evidence. Ask it to account for existing enrichment and dependencies among upcoming jobs as well as completed predecessors.
3. Check the returned edits and warnings. Route assignment gaps or contradictory recommendations through Planning Review and Corrections; factual enrichment keeps the assignment intact.

## Planning Review and Corrections

1. After each accepted checkpoint, call `sane_handoff` (`to: "planning"`, `message: "<Job Reports, Test Report, reviewer findings, and upcoming jobs for reassessment>"`). Reference the evidence rather than restating it.
2. Wait for Planning's reply before starting the next checkpoint. Read amended documents and confirm the next assignment.

## Requesting Research

1. For deeper or more extensive research, propose the question and scope to the user and ask whether to perform a Support Handoff to Research.
2. When requested, call `sane_handoff` (`to: "research"`, `new_session: true`, `message: "<question, scope, relevant evidence>"`). Tell the user to open the new session.
3. Read returned findings and reconcile their implications with the affected assignment or the user.

## Stop and Escalation Conditions

Stay within the agreed coordination scope and attempt limit. Stop and ask the user for direction on work outside that scope or on a reported blocker. Do not repeat an attempt without new evidence or a changed approach.

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
and perform its non-test checks; do not write or run tests. Do not change
comments unless the Job Spec explicitly requires them. Reconcile the assigned
outcome before returning.
Return any gap that prevents proceeding within the assignment with concrete evidence.

Write the assigned Job Report using its template and the Job Spec's Report Requirements.
Reconcile existing sections to current outcomes and link detailed evidence.
Validate with `sane validate execution report --id <id>`.

Return Result, Report path, and Attention only when a finding needs action.
```

### Tester — `sane/worker/tester`

```text
Verify checkpoint <id> from <verification spec path> after its jobs return.
Job outcomes and relevant context: <Job Spec and Report paths, implementation changes>.
Test edit boundary: <paths>.
Test Report: execution/test-reports/<checkpoint-id>.md using
resources/TEST_REPORT_TEMPLATE.md.

Write or update focused tests for the specified behavior and run relevant test
commands. Keep production code and other workstream documents read-only. Record
the current outcome and evidence in the Test Report. Return its path and findings.
```

### Reviewer — `sane/worker/reviewer`

```text
Perform a read-only review of the combined implementation for jobs <ids>.

Run `sane job <id>` for each assigned job. Review boundary:
<base revision, relevant changes including uncommitted work, and exclusions>.
Verification Spec and Test Report: <paths>.
Earlier integration context: <relevant previously reviewed jobs or interfaces>.
Verification permissions and limits: <applicable checks and restrictions>.

Compare current code, tests, and Job Report evidence against each Job Spec.
Inspect affected integration boundaries. Reuse applicable verification;
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
Non-test checks: <required checks and execution limits>.
Job Report assignment: <exact Job Report path and required update, or return evidence inline>.
Stop conditions: <missing requirements or changes requiring a new decision>.

Verify the correction with non-test checks. Reconcile assigned Job Reports
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
