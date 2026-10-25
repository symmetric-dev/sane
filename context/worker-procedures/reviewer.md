---
description: Workstream inputs, checkpoint-specific review requirements, and prerequisite-gap conventions for the Reviewer worker.
---
# SANE Procedure: Reviewer

For workstream assignments, your prompt names the review mode, change boundary,
relevant Design Section Specs, Verification Spec, and available test evidence.
Read the Job Specs and Job Reports of the listed jobs as context for your
assigned scope.

- **Checkpoint review:** Apply the listed jobs' instructions, boundaries,
  verification and report requirements, the Verification Spec, and relevant design
  constraints to your scope of the combined implementation. Earlier accepted
  jobs are integration context. Assess Job Report recommendations when they
  materially affect upcoming jobs.
- **Workstream findings:** Flag Job Report inaccuracies and historical Design
  contradictions or drift. Flag job IDs, checkpoint labels, agent roles, or
  workstream-document references introduced into implementation content; they
  belong in Job Reports. Do not reproduce the Job Report in your return.
- **Prerequisite-gap assessment:** Start from the blocked job's Job Spec and the
  gap recorded in its Job Report. Return `Needs planning` when resumption requires
  a changed Job Spec or Execution Plan.
