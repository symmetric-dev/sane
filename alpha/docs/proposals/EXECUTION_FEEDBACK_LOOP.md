# Execution feedback and post-execution documentation

Status: proposal for discussion. This document describes intended changes;
it does not change current agent permissions, approval rules, or CLI behavior.

Subsequent decisions are reflected in the editable assistant skills: Planning
defines review/commit checkpoints; Execution may enrich upcoming Context through
Grounder and waits after a Planning request until the reply or user instruction.
The older non-blocking handoff discussion below is superseded by that wait rule.

## Goal

Make execution findings useful to later jobs and future work without requiring
the user to reopen Planning approval for routine context updates or in-scope
job additions. Preserve clear ownership of assignments and user decisions.

There are two distinct needs:

1. **During execution:** pass relevant evidence to upcoming workers and amend
   upcoming work when necessary.
2. **After execution:** turn deferred findings into actionable maintenance
   candidates and identify reusable practices worth documenting.

## Case study

The reference workstream is `01-frontend-talent-refactor` in
`~/aws-hackaton-talent-agency/.sane/workstreams/`. Its 11 job reports and final
report already capture substantial evidence, but follow-up routing is informal.

Examples from `execution/reports/`:

| Evidence | Implication |
| --- | --- |
| Job 01 documents a queue self-wait hazard for consumers. | Forward an integration constraint to relevant upcoming jobs. |
| Several Jobs 02–08 independently establish the same pre-existing test failure. | Reuse qualified baseline evidence instead of repeatedly rediscovering it. |
| Job 04 finds an edit → join → edit navigation loop outside its boundaries. | Planning needs to triage follow-up work or request a user decision. |
| Job 10 verifies an already-running stack instead of invoking interactive tmux attachment; Job 11 reuses it. | Preserve successful predecessor guidance where compatible with the assignment. |
| Job 10 needs local SQL deletes because reset omits tables. | Record the workaround as evidence and the reset repair as a maintenance candidate; do not automatically prescribe the deletes. |
| Jobs 10–11 observe localhost HTTP sign-in despite explicit HTTPS instructions. | Reconcile contradictory instructions rather than overriding them through a Context note. |
| Job 10 finds upload CORS failure; Job 11 finds an earlier CSRF ticket failure. | Keep observed causes, predictions, and proposed fixes separate. |

The final report records completed reviews, but separate reviewer outputs were
not found in the workstream files. The case study therefore supports the need
for the loop, not a claim that every reported recommendation was independently
validated. Application behavior was not re-tested for this proposal.

## Intended flow during execution

```text
Implementer report → Reviewer assessment → Execution triage
                                          ├─ Grounder: enrich upcoming Context
                                          ├─ Planning: amend upcoming work
                                          └─ retain for post-execution synthesis

Planning → user when a decision exceeds existing authorization
```

### Implementer: capture at the source

Add an **Implementation Recommendations** section to the execution report,
separate from Accomplished and Found Issues. It can say `None` when appropriate.

For each useful recommendation, capture:

- Problem or constraint and affected scope.
- Evidence: code pointers, commands/outcomes, or observed behavior.
- Workaround tried and its limits, if any.
- Suggested action and the jobs or future work that could benefit.

Do not duplicate long evidence tables; reference the relevant report section.
An observed workaround is not automatically an endorsed procedure. A proposed
fix is not a verified fix, and a plausible cause is not an established cause.

### Reviewer: assess recommendations as well as implementation

Retain the existing implementation verdict. Additionally assess recommendations
as **supported**, **needs evidence**, or **invalid**, with a short reason and
relevant evidence pointers. Return a concise list suitable for forwarding.

Checking a recommendation should be bounded to the assigned review. If proving
it requires a new investigation, mark that need rather than silently expanding
the review. A completed job can have unresolved findings; an accepted report
does not mean every exercised product behavior passed.

### Execution: route findings and maintain progress

Execution batches relevant findings and chooses their next consumer:

| Finding | Route |
| --- | --- |
| Useful information compatible with the approved assignment | Pass directly to a worker, or invoke Grounder to enrich an upcoming spec |
| A correction fixable within the existing authorized fix procedure | Existing review/fix cycle |
| Required change to a Job Spec's assignment, job insertion, dependencies, or order | Planning |
| No current consumer, but useful future improvement | Preserve for final-report/post-execution synthesis |

Act when a finding matters to upcoming work. Repeated pain across jobs is a
batching signal, not a prerequisite: one clear finding can justify action.
Do not re-ground every job after every report.

A handoff does not automatically block execution. Pause affected work when its
instructions or authorization are unresolved; independent authorized work can
continue.

### Grounder: bounded Context maintenance under Execution

Extend Grounder so Execution can invoke it for one assigned **unstarted** job.
It reads the specified predecessor findings, reviewer assessment, and relevant
current code, then updates only the Job Spec's **Context** section.

Permitted updates:

- Relevant predecessor report references and actual delivered interfaces.
- Refreshed symbol locations and stale navigation anchors.
- Applicable, supported operational guidance and its conditions.

Not permitted under this delegation:

- Changes to goals, required behavior, instructions, boundaries, verification,
  acceptance, dependencies, or ordering.
- New jobs, implementation edits, or decisions about scope.
- Advice that contradicts binding instructions elsewhere in the assignment.

Grounder returns what changed, evidence used, and any contradiction requiring
Planning. Execution checks that the edit stayed within this boundary before
dispatch. A running worker's assignment is not edited underneath it.

Keep additions short: the takeaway, when it applies, and a report path plus
section heading (optionally a line range). For example:

> If the local stack is already running, check compose status and API/proxy
> health before restarting it. See Job 10's report, “Stack bring-up and
> readiness.” This does not replace required restart/recovery verification.

This example is appropriate only when the job permits reuse of a running stack.
Context cannot be used to bypass an explicit instruction to restart.

### Planning: amend work and escalate decisions to the user

Planning receives a focused request containing:

- Source reports and reviewer-supported findings.
- Affected upcoming job IDs.
- Requested triage: re-ground/amend, insert work, or obtain a user decision.
- Whether any affected job is waiting and why.

Planning owns assignment changes and new Job Specs, and can invoke Grounder
with the current tree and relevant reports. Routine in-scope amendments and
job insertions should retain the existing Planning approval.

**Planning escalates directly to the user**, not to Engineering as a decision
authority. The user decides whether to change requirements, expand scope,
accept a limitation, or involve Engineering/Design. Complexity alone is not
the escalation trigger; exceeding existing authorization is.

The exact boundary of Planning's delegated amendment authority remains to be
defined. Adding a job must not become an implicit way to authorize new scope.

## Approval and CLI implications

Current implementation:

- Planning validation hashes the full contents of `execution/PLAN.md` and
  directly contained `execution/jobs/*.md`, then hashes sorted `path:hash`
  entries into one phase-level digest.
- Approval stores that digest and marks Planning approved.
- Later document changes produce a validation warning, not automatic
  revocation. Job retrieval/progress commands do not enforce hash freshness.
- New job files register in SQLite only on Planning approval. Re-approval
  adds missing jobs while preserving existing job statuses.

Sources: `packages/sane-cli/src/sane-validate-command.ts`,
`sane-approve-command.ts`, and `sane-job-command.ts`.

Intended changes:

- Treat the stored approval hash as evidence of the approved snapshot, not a
  requirement to re-approve every byte change.
- Preserve approval for authorized Context enrichment and Planning amendments.
- Provide a supported way to register Planning-added jobs without replaying
  user approval. Command/API shape is undecided.
- Distinguish ordinary post-approval amendments from changes awaiting a user
  decision; revise the blanket “re-approve” warning accordingly.
- Preserve job identity and running/completed progress when inserting work.
- Record amendment provenance without pretending that the user approved a
  new snapshot when no new user approval occurred.

## Documenter: post-execution synthesis

A Documenter fits **after execution**, rather than between each pair of jobs.
Grounder handles job-specific context; Documenter handles cross-job synthesis.

### Inputs and responsibility

Given the final report, relevant job reports, recommendation assessments, and
bounded current-repository context, Documenter produces two kinds of output:

1. **Follow-up candidates:** consolidate pending findings into directed fixes,
   maintenance targets, or investigations. Include evidence, impact, workaround,
   proposed scope, dependencies, and verification needed. Distinguish already
   planned work, explicitly deferred work, and unresolved suggestions.
2. **Reusable practices:** extract supported patterns with applicability,
   rationale, recommended practice, limits, and source evidence. Identify
   opportunities to improve existing docs or skills, or propose a new skill.

Examples include repairing the reset script, correcting local-auth guidance,
and documenting how to establish stack readiness without interactive startup.
An unresolved upload defect belongs in follow-up candidates; a speculative
remedy must not be presented as a best practice.

### Authority

Documenter synthesizes and proposes. It does not independently authorize
maintenance, create active jobs, change approved specs, or promote findings
into repository guidance. Candidate backlog items are not approved assignments.

Updating repository docs, `AGENTS.md`, or skills requires an explicit user
decision and a bounded authorized assignment. A draft skill may be an output
if requested; installing or adopting it is a separate decision.

The worker can be added later without delaying the execution feedback loop.
Whether it is Execution-invoked, Planning-invoked, or user-invoked is still open.
Its outputs should be advisory and evidence-linked; no new approval phase is
proposed.

## Changes to agent context and templates

| Surface | Intended change |
| --- | --- |
| Implementer instructions and report template | Structured recommendations, evidence, applicability, and limits |
| Reviewer instructions | Separate assessment of recommendation credibility and forwarding suitability |
| Execution skill and agent permissions | Triage procedure; permission to launch Grounder for bounded Context edits |
| Grounder instructions | Distinguish Planning-owned grounding from Execution-owned Context enrichment; consume specific reports and review evidence |
| Planning skill | Explicit execution-feedback receive path, in-scope amendment authority, direct escalation to user |
| Job Spec template | Support concise conditional report references in Context |
| Final-report guidance | Preserve unresolved findings and pointers for post-execution synthesis |
| CLI/state handling | Register added jobs independently of re-approval; reflect amendment semantics |
| Future Documenter instructions/template | Evidence-linked follow-up candidates and reusable-practice proposals |

Existing workstreams may contain copied resource templates and installed agents
may differ from source. Implementation should account for updating those copies
deliberately rather than assuming source edits update them automatically.

## Remaining decisions

1. **Planning amendment authority:** What changes may Planning make under
   existing approval? Define in-scope repair, changed verification, dependency
   changes, and the threshold for a direct user decision.
2. **Job registration and insertion:** Choose the CLI/API, identity rules,
   ordering representation, and behavior for duplicate IDs or renamed files.
   Avoid renumbering running/completed jobs to insert work.
3. **Amendment provenance:** Decide the smallest durable record of who changed
   a spec, why, and from which evidence, and how validation displays drift.
4. **Reviewer assessment storage:** Current review results can be inline.
   Decide how a later Grounder or Documenter receives durable assessment
   evidence without requiring a large new review artifact system.
5. **Grounder dispatch checks:** Define how Execution confirms a job is unstarted
   and ensures Context-only edits did not indirectly override its instructions.
6. **Documenter lifecycle:** Choose who invokes it, whether invocation is optional,
   and whether it runs before final delivery or after user acceptance. It should
   not silently reopen completed execution.
7. **Output location and vocabulary:** Choose where post-execution candidates
   and practices live. `execution/knowledge/` was suggested, but no path,
   backlog format, status taxonomy, or expiry scheme is settled.
8. **Promotion and discovery:** Decide how the user selects candidates for new
   workstreams and approves docs/skill changes, and how later workstreams find
   relevant knowledge without treating it as canonical requirements.

## Suggested implementation order

1. Agree the amendment/escalation boundary and recommendation format.
2. Update Implementer, Reviewer, Execution, Grounder, and Planning context;
   reconcile approval warnings and new-job registration in the same rollout.
3. Exercise the loop on a real workstream and check whether findings reach the
   intended jobs without unnecessary handoffs or repeated investigation.
4. Add post-execution Documenter support once its output and ownership are clear.
