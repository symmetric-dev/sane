# Retry Policy

Initial draft for user review. Numeric defaults below are proposals, not adopted
limits. Until agreed, use the user's specified limits or ask before retrying.

## Terms

- **Implementation attempt:** one Implementer invocation for one Job Spec.
- **Implementation retry:** another attempt at that job after an unsuccessful
  return. Supply the previous attempt's changes, report, and remaining work.
- **Fix attempt:** one bounded Fixer invocation for an identified defect or
  related defect set under the Fix and Correction Policy.
- **Batch:** one or more Implementers dispatched together. Wait for every worker
  to return before coordinating the next action.
- **Checkpoint:** the plan's review boundary, which may span several batches.
  A reviewer invocation is not an implementation or fix attempt.

## Before Retrying

1. Read the returned evidence and apply the Fix and Correction Policy.
2. Identify what changed or what the next attempt will do differently. Resolve
   a missing dependency or assignment decision before repeating the work.
3. Check the applicable attempt limit and the user's coordination instructions.
4. Preserve partial implementation and prior evidence. Give the next worker an
   explicit continuation boundary and report destination rather than treating
   the repository as untouched.

## Single-job Batch

1. Wait for the Implementer to return and assess its report.
2. If the job is implemented with the required evidence, retain it as awaiting
   checkpoint review and proceed according to the plan.
3. If unfinished, choose a retry, bounded fix, Planning correction, or user
   decision. Run only the authorized next action and count its attempt.
4. At the checkpoint, review the combined implementation. Follow the checkpoint
   fix sequence below when review finds blocking defects.

## Multi-job Batch

1. Wait for every Implementer to return, then assess each job separately.
2. Preserve successful job outputs and record their pending-review status.
   Retry only affected unfinished jobs; another job's failure does not by itself
   require repeating successful implementation work.
3. Check whether the failure or proposed fix changes a shared interface or affects
   another job's result. Include affected outputs in verification and checkpoint
   review; request Planning assessment if the planned independence was incorrect.
4. Coordinate retries sequentially by default. Use parallel retries only where
   the plan's existing parallel authorization and actual isolation still apply.
5. Resolve the batch's blockers before moving to its following jobs, or follow a
   Planning amendment returned through the handoff procedure.

## Checkpoint Fix Sequence

1. Use the review findings to assign bounded Fixer work or request Planning/user
   input under the Fix and Correction Policy.
2. After fixes return, inspect their evidence and run a checkpoint re-review of
   the corrected result and affected integration. Preserve coverage of every job
   in the checkpoint and identify any earlier findings still unresolved.
3. Commit after an accepted review according to the Assistance skill. If review
   still finds blocking defects, check limits before another fix attempt.

## Proposed Default Limits

For discussion, count limits by affected job or checkpoint rather than by the
number of concurrently dispatched workers:

| Activity | Proposed default | Counting boundary |
| --- | --- | --- |
| Implementation | Initial attempt plus one retry | Per job for its current assignment |
| Bounded fixes before checkpoint review | Up to two Fixer attempts | Per job across unresolved implementation findings |
| Checkpoint correction | Up to two fix-and-re-review cycles | Per checkpoint across blocking review findings |

These are ceilings, not instructions to exhaust attempts. The user-directed
mode still requires the relevant user instruction; numeric limits alone do not
authorize autonomous coordination.

## Limit Reached or Assignment Changed

When a limit is reached, ask the user for the next action and summarize attempts,
remaining findings, and whether Planning assessment is needed. Preserve the
counts in execution evidence.

Renaming a finding, changing workers, or repeating a handoff does not reset the
count. When Planning returns a materially revised assignment, confirm how its
attempt allowance should be treated rather than resetting it silently. A new
job has its own history; retain the predecessor evidence that motivated it.

## Questions for Review

- Should the proposed numeric defaults be adopted or changed?
- Should pre-review fixes and checkpoint correction cycles share one overall
  budget instead of separate limits?
- What qualifies as a materially revised assignment for a new allowance?
- How should tool failures or interrupted workers count when no implementation
  work occurred? Until decided, ask the user rather than automatically retrying.
