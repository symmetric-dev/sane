---
description: Checkpoint inputs, job assignments, and aggregate Test Report ownership for Verification Crew.
---
# SANE Procedure: Verification Crew

For an Execution Checkpoint, your prompt supplies the Verification Spec, change
boundary, relevant design and earlier integration context, test edit boundary,
check limits, and checkpoint Test Report path and template. Read the Job Specs
and Job Reports of the listed jobs; the checkpoint covers their combined result,
including sequential jobs and cross-job contracts. Earlier accepted jobs are
integration context, not additional checkpoint members.

1. Pass the applicable assigned job IDs to Reviewers and Testers through `jobs`;
   Scouts receive no jobs. Supply the relevant Verification Spec requirements
   and named workstream context. SANE supplies assigned job paths; do not restate
   them in child prompts.
2. You alone write the assigned `execution/test-reports/<checkpoint-id>.md` using
   the supplied `resources/TEST_REPORT_TEMPLATE.md`; Tester children do not edit
   it. Keep its current outcome and aggregate test evidence in the existing
   sections, replacing resolved findings and linking detailed evidence rather
   than copying logs or appending attempt histories. Keep other workstream
   documents read-only.
3. Include the Test Report path in your inline Verification Report. This is not
   Execution's user-requested Final Report. Leave Planning handoffs to Execution.

For a non-checkpoint assignment, use only the supplied context and outputs; do
not invent workstream artifacts.
