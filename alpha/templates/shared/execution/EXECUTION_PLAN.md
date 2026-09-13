# Stage Execution Plan

<!-- Retain this H1 and only the two H2s below, exactly once and in this order.
This plan is a compact Job index and explanation of the split for user review
before detailed Job authoring. Keep implementation requirements in the approved
Design and Job documents. Omit approval/status commentary, authorization
disclaimers, report instructions, reference inventories, and workflow narration. -->

## Jobs

<!-- Add each direct child Job using this form:

01. Unique Job Name: One short sentence describing the main deliverable.

Number entries consecutively from 01, writing each number explicitly in the
Markdown source. The number is the stable local Job ID, not part of its name or
its execution priority. Once Job documents exist, do not renumber without
updating matching documents and references. Do not add Job Group tags.
Aim for about 20 words per description; do not enumerate requirements. -->

## Split Notes

<!-- Use short bullets explaining non-obvious boundaries, dependencies, permitted
parallelism, and shared ownership decisions that justify the split. Refer to Job
IDs instead of repeating names or descriptions. State sequencing once, explicitly;
list order alone does not authorize an execution order. For example:

- Sequence: 01 → (02 and 03) → 04. Only Jobs 02 and 03 may run in parallel.

Permit parallel work only when repository changes, inputs, and expected results
are safely isolated. Do not repeat Design constraints, file allowlists, acceptance
criteria, or standard workflow rules. Aim for 3–7 notes, using fewer for a simple
split; brevity must not obscure necessary execution relationships. -->
