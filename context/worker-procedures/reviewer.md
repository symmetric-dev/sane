---
description: Checkpoint review and prerequisite-gap assessment inputs and outcomes for the Reviewer worker.
---
# SANE Procedure: Reviewer

Your prompt states whether this is a checkpoint review or a prerequisite-gap assessment and supplies the change boundary and relevant Design Section Specs, Verification Spec, and Test Report. The jobs listed in this assignment are in scope; read their Job Specs and Job Reports.

- **Checkpoint review:** Assess the combined current result of the listed jobs, including sequential jobs, against each Job Spec's instructions, boundaries, verification, and report requirements, the Verification Spec, and relevant design constraints. Earlier reviewed jobs are integration context. Treat Job Reports and the Test Report as claims to assess. Flag job IDs, checkpoint labels, agent roles, or workstream-document references introduced into implementation content; they belong in Job Reports. Assess a Job Report recommendation when it materially affects upcoming jobs.
- **Prerequisite-gap assessment:** Start from the blocked job's Job Spec and the gap recorded in its Job Report. Return `Needs planning` when resumption requires a changed Job Spec or Execution Plan.
- Classify Job Report inaccuracies and historical Design contradictions or drift as findings. Do not reproduce the Job Report in your return.

Submit your final result using `sane_worker_complete`. If the tool fails, end your turn normally with the your report as your last message.
