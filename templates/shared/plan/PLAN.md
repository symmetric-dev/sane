# Plan

<!-- Retain this H1 and the H2s below, exactly once and in this order.
This plan is a compact Job index and explanation of the split for user review
before detailed Job Spec authoring. Planning owns `execution/PLAN.md` and
`execution/jobs/*`. Keep implementation requirements in the approved SDD, Solution
Specs, and Job Specs. Omit approval/status commentary, authorization
disclaimers, report instructions, reference inventories, and workflow narration. -->

## Jobs

<!-- Add each Job using this form:

01. Unique Job Name: One short sentence describing the main deliverable.

Use stable Job IDs starting at 01, writing each ID explicitly in the Markdown
source. Preserve existing IDs when inserting jobs: for example, 07a and 07b
between 07 and 08. For inserted IDs, use an explicit list entry such as
`- 07a. Unique Job Name: Short deliverable.` Execution defaults to listed order.
Job Specs live at `execution/jobs/<job-id>-<job-slug>.md`.
Aim for about 20 words per description; do not enumerate requirements. -->

## Split Notes

<!-- Use short bullets explaining non-obvious boundaries, dependencies, permitted
parallelism, and shared ownership decisions that justify the split. Refer to Job
IDs instead of repeating names or descriptions. Default execution is sequential
list order; state sequencing exceptions and parallel authorization explicitly.
For example:

- Sequence: 01 → (02 and 03) → 04. Only Jobs 02 and 03 may run in parallel.

Permit parallel work only when repository changes, inputs, and expected results
are safely isolated. Do not repeat SDD constraints, file allowlists, acceptance
criteria, or standard workflow rules. Aim for 3–7 notes, using fewer for a simple
split; brevity must not obscure necessary execution relationships. -->

## Execution Checkpoints

<!-- Define checkpoints at coherent review boundaries, especially before major
dependency transitions. Every job belongs to exactly one checkpoint's Jobs
column, in execution order; include a final checkpoint covering the remaining
jobs. A parallel batch must fit wholly inside one checkpoint. Author a matching
`execution/verification/<checkpoint-id>.md` from the Verification Spec template
for each checkpoint, replacing spaces in the checkpoint label with hyphens in
the lowercase filename (for example, `Checkpoint 1 follow-up` becomes
`checkpoint-1-follow-up.md`). Additional
review context may include earlier jobs without
assigning them to another checkpoint.

| Checkpoint | After job(s) | Jobs | Review purpose / earlier context |
| --- | --- | --- | --- |
| Checkpoint 1 | 03 | 01, 02, 03 | Backend ready for integration |
| Checkpoint 2 | 04 | 04 | Integration with backend from Checkpoint 1 |
| Checkpoint 3 | 07 | 05, 06, 07 | Completed frontend flow |

Checkpoints organize detailed review and commits; record intended boundaries
here, not progress or commit hashes. Reconcile coverage, dependencies, and
checkpoint boundaries whenever jobs change. -->
