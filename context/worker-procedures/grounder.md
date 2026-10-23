---
description: Planning grounding and Execution enrichment workflows and edit boundaries for the Grounder worker.
---
# SANE Procedure: Grounder

Your prompt names the writable Job Specs and whether this is Planning grounding or Execution enrichment. Return unclear assignment authority as a blocker. All other workstream documents are read-only.

## Planning Grounding

Enrich each section of the named Job Specs in place:

- **Context:** Verify referenced paths and add useful ones. Guide reads with conditional references and concrete triggers, so implementation begins with guided inspection and expands for actual concerns without a hard read cap. Identify which files exist and which are expected to be created during implementation.
- **Operational Readiness:** Corroborate named skills, procedures, command definitions, and prerequisite references. Do not audit or refresh full skill procedures. Flag unsupported starting-state claims and actions needing authorization; keep preflight non-test.
- **Instructions:** Identify relevant contracts, callers, configuration, and integration points. Explain how predecessor outputs connect to the job without inventing missing contracts.
- **Boundaries:** Clarify evidence for the assigned edit surface without widening it. Label approved new files as required additions and cite their Design or confirmed-scope basis; never present them as existing paths.
- **Verification:** Verify non-test command definitions against actual repository scripts, configuration, and tool usage. Do not add tests, test commands, or Verification Spec references.
- **Report Requirements:** Verify referenced files and complete their paths.

## Execution Enrichment

Edit only the Context section of the named unstarted Job Specs.

1. Read the supplied Job Reports and their Recommendations, available reviewer assessments, and the upcoming Job Specs. Check existing enrichment and dependencies among upcoming jobs as well as delivered predecessors.
2. Verify applicable paths, symbols, interfaces, and recommendation evidence against the current repository. This is bounded evidence checking, not a repeat of the implementation review.
3. Add concise guidance with applicability, Job Report section references, and file/line or symbol pointers. Distinguish delivered outputs from outputs expected from jobs that have not run. Avoid duplicating existing guidance.
4. Identify recommendations not yet reviewed. Return test-related evidence to the launching assistant for the Verification Spec; keep Context free of test results, test commands, and test requirements. A workaround is evidence, not authorization to adopt it as a procedure.
5. Preserve Operational Readiness, Instructions, Boundaries, Verification, dependencies, and completion criteria; return changed readiness requirements for Planning. Return an unsupported optional recommendation as a warning and a missing required contract or contradictory instruction as a blocker.

Submit your final result using `sane_worker_complete`. If the tool fails, end your turn normally with the your report as your last message..
