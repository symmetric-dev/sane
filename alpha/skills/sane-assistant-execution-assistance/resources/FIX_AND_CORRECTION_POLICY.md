# Fix and Correction Policy

Initial draft for user review. Apply the user's existing authorization; confirm
unclear routing with the user. This policy classifies findings from returned
Implementers, Reviewers, or Grounders.

## Assess the Finding

1. Read the affected Job Specs, actual implementation, reports, and available
   verification or review evidence.
2. Identify what was required, what was delivered, and what prevents the assigned
   work from proceeding or being accepted.
3. Choose the route below. Address blocking findings when workers return rather
   than waiting for the scheduled checkpoint.

## Bounded Implementation Fix

Use `sane/worker/fixer` when the assignment is sufficient and the implementation
fails to satisfy it. The fix must preserve approved behavior, contracts, scope,
and required verification.

1. Give the Fixer the affected jobs, precise findings, allowed change boundary,
   relevant evidence, required verification, and stop conditions. If a report
   needs updating, supply its exact path and reporting requirements.
2. Use the user's agreed fix-attempt limit; ask for one when none was supplied.
3. Keep the corrected implementation within checkpoint review coverage. If the
   finding came from a checkpoint review, obtain another review of the corrected
   result and affected integration before accepting it.

Examples: an implementation omitted a required validation branch, miswired an
agreed interface, or introduced a regression covered by the existing assignment.

## Planning Correction

Use the Assistance skill's Planning Corrections procedure when resolution needs
changed assignments, dependencies, sequencing, checkpoint boundaries, or new jobs.

When Job Y reports missing output from Job X, compare X's required outputs with
Y's required inputs and the actual delivered code. Treat a missing or inconsistent
producer/consumer assignment as a Planning signal. If X's assignment explicitly
required the output and the defect is bounded, use the implementation-fix route.
Ask Planning to assess ambiguous or cross-job gaps rather than repeatedly patching
the predecessor to discover the intended assignment.

Include the affected jobs, report/evidence references, expected versus actual
outputs, fixes already attempted, and impact on upcoming work. Planning may add
intermediate jobs such as `07a` and `07b`, reconcile checkpoints, or ask the user
to resolve a planning or scope failure.

After sending the request, wait for Planning's reply or user instruction. An
escalated Planning request remains with the user until they authorize the reply.

## Non-blocking Findings

Retain supported observations that do not prevent completion of required work.
Record known failing checks with baseline evidence and applicability; compare
subsequent behavior for regressions and preserve required verification.

Accepted work can be committed with these observations. After committing,
consider Planning assessment when related failing tests, recurring workarounds,
or repeated coordination effort suggest a useful in-scope improvement. Optional
Context enrichment can pass on compatible facts and guidance; changes to the
assignment belong with Planning.

## User Decision

Ask the user when resolution changes approved scope, behavior, or acceptance,
when authority or the correct route is unclear, or when an agreed attempt limit
is reached. Describe the evidence, available next actions, and affected work.
Follow the user's decision before dispatching further work on the issue.

## Evidence to Retain

Record the finding, chosen route, affected jobs, attempt outcomes, verification,
and any user decision in the relevant execution evidence. Preserve earlier
reports and completed-job history. Link detailed evidence from the checkpoint
record rather than repeating it.

## Questions for Review

- Is the bounded-fix versus Planning-correction boundary specific enough?
- Should recurring non-blocking obstacles have an explicit Planning-assessment
  trigger, or remain Execution's judgment?
- Is a focused checkpoint re-review after a fix sufficient, or are there cases
  that require repeating the complete original review scope?
