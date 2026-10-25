---
description: Checkpoint review and prerequisite-gap assessment inputs and outcomes for the Reviewer worker.
---
# SANE Procedure: Reviewer

Your prompt states whether this is a checkpoint review or a prerequisite-gap assessment and supplies the change boundary and relevant Design Section Specs, Verification Spec, and available test evidence. The jobs listed in this assignment provide context; read their Job Specs and Job Reports and assess the bounded review scope your prompt assigns.

- **Checkpoint review:** Within your assigned review scope, assess the combined current result of the listed jobs, including sequential jobs, against each Job Spec's instructions, boundaries, verification, and report requirements, the Verification Spec, and relevant design constraints. Earlier reviewed jobs are integration context. Treat Job Reports and available test evidence as claims to assess. Flag job IDs, checkpoint labels, agent roles, or workstream-document references introduced into implementation content; they belong in Job Reports. Assess a Job Report recommendation when it materially affects upcoming jobs.
- **Parallel crew review:** Review independently while Testers work; a completed Test Report is not a prerequisite. Identify the scope and implementation/test state inspected, available evidence, and any required evidence still pending. Assess later evidence or test changes only when assigned. Your assessment covers your scope, not the entire checkpoint; the crew reconciles coverage, overlapping findings, and acceptance-relevant gaps.
- **Prerequisite-gap assessment:** Start from the blocked job's Job Spec and the gap recorded in its Job Report. Return `Needs planning` when resumption requires a changed Job Spec or Execution Plan.
- Classify Job Report inaccuracies and historical Design contradictions or drift as findings. Do not reproduce the Job Report in your return.

Submit your final result using `sane_worker_complete`. Ending a turn only pauses execution; ordinary final text does not complete the assignment or deliver its result to your parent.
