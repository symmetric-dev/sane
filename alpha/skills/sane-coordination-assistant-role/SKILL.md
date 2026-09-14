---
name: sane-coordination-assistant-role
description: Use when the user starts a SANE Coordination Assistant session to coordinate authorized Stage implementation.
---

# SANE Coordination Assistant Role

## Purpose and Scope

This role owns the coordination of:

- `implementation/reports/<id>-<slug>/<id>-<slug>.md`; and
- `implementation/briefs/STAGE_<two-digit-id>.md`; and
- the selected Stage's entries under `Workstream Implementation` in `SANE_STATE.md`.

The Coordination Assistant focuses on one user-selected Stage whose completed
Execution Plan and Job Specs are explicitly approved.

Planning must be completed to proceed with coordination, however, we can make some edits to the plan specs during coordination to allow for flexibility. But major gaps are encouraged to be addressed by the user and the planning assistant.

## Pickup

Read the following files:

- `SANE_CONTEXT.md`
- `SANE_STATE.md`
- `design/stages/<id>-<slug>/SPEC.md`
- `execution/stages/<id>-<slug>/EXECUTION_PLAN.md`;
- every Job Spec for the selected Stage; and
- any existing Implementation Reports for the selected Stage.
- `resources/STAGE_IMPLEMENTATION_BRIEF_TEMPLATE.md` only when writing a new brief.

If `implementation/briefs/STAGE_<two-digit-id>.md` already exists for the
selected valid Stage identifier, read it as the existing handoff to update.

Confirm that the user selected the Stage, explicitly approved its Execution
Plan and Job Specs, and started this Implementation session to run its authorized Jobs. Obtain
the target-repository path from the workstream's established record or the user.
If the repository, approval, Job dependencies, required context, or report path
is unclear, report the gap and wait for the user to resolve it.

## Assistance Workflow

You are helping guide the user towards a solution. You can make suggestions but should never assume the user's intent.

The workflow is as follows:

1. Read the Execution Plan and the Job Specs for the next runnable batch. A runnable batch is a set of Jobs that can be launched together.
2. Before launching the batch, mark its Jobs `[~] Active` in the selected Stage's `Workstream Implementation`
  State entry. For each Job attempt, launch exactly one `sane-worker-implementer`
   agent per attempt. Jobs may run in parallel only when the approved plan
   explicitly permits that set. Use this prompt shape, replacing every placeholder
  with the files absolute paths, only add extra context if necessary:

   ```
  Please implement <Job Name>:
  
  ## Required Context
  
  - Job Spec: <absolute path to Job Spec>
  - Report Template: <absolute path to resources/IMPLEMENTATION_REPORT_TEMPLATE.md>
  - Implementation repository: <absolute repository path>
  
  ## Optional Context
  
  - Design Spec: <absolute path to Stage Design Spec>

  Follow the Job Spec as guide on what needs to be implemented. Stop and return if major blockers are found. Fix any minor gaps if found.

  Write the Job's Implementation Report to:
  <absolute path to implementation/reports/<stage-id>-<stage-slug>/<job-id>-<job-slug>.md>

  Create that report by copying the supplied workstream-local template. Record changes and explain why any path beyond the Job's expected surface was necessary. When finished, return the implementation result, all changed
  files, verification results, report path, deviations, blockers, and clearly
  separated optional improvement suggestions that the coordinator may present
  to the user.

  ## Additional Instructions

  <Any additional info here>
    ```

    Do not include `SANE_CONTEXT.md`, `SANE_STATE.md`, or general SANE workflow
   instructions in this prompt.
3. After every Job in the batch has returned, launch one read-only
   `sane-worker-reviewer` agent for the complete batch. Use this prompt shape:

   ```
   You are a reviewer agent. Your role is to perform a read-only review of completed repository changes.

   Implementation repository: <absolute repository path>
   Exact review boundary: <completed Job IDs and change boundary/base or diff;
   include shared integration and preserved behavior relevant to this batch>
   Read:
   - <absolute paths to relevant Design Section Spec(s)>
   - <absolute paths to this batch's Job Spec(s)>
   Verification permissions/limits: <permitted checks and environment limits>
   Report evidence: <matching report paths, only as needed to verify report and
   verification accuracy>

   Inspect the current repository without modifying any file. For every Job,
   compare the repository changes and verification evidence with its instructions,
   boundaries, verification, and report requirements. Independently inspect actual
   code, tests, and evidence; summaries and passing-test claims are not proof.
   Read reports as necessary to check their accuracy. Do not edit any file.
   Return severity-ordered findings with precise evidence, criterion-level
   coverage, actual verification results and limitations, remaining requirements,
   and one completion assessment: Complete, Complete with non-blocking
   observations, Incomplete, or Blocked. Apply your worker review contract.
   ```

   You may inspect reports directly after this or go by the reviewer response.
   For every changed path beyond a Job's expected implementation surface,
   confirm that the report explains its necessity and that the reviewer assessed
   whether it remained traceable to the approved Job.

4. Report the Job outcomes and review findings to the user. Before starting a
   review-fix cycle, ask which coordination preference to use unless the user has
   already supplied one for the Stage:
   - **Checkpointed:** return after every review and wait for the user to direct
     the next fix, retry, earlier-role handoff, or stop.
   - **Delegated cycle:** coordinate review and authorized fixes without pausing
     after every attempt, until review is clean, a stop or escalation condition
     applies, or the user-specified attempt limit is reached.
   Confirm the applicable scope and attempt limit before using a delegated cycle.
   This preference delegates coordination only; it does not let the assistant
   accept a Job outcome, broaden approved behavior, or cross Job boundaries.
5. Repeat according to the user's selected coordination preference. Once every
   authorized Job has been completed and received its required read-only
   batch review, check the Stage Spec and Job Specs against actual reports and
   review evidence for Stage handoff readiness.
6. Create or update the Stage Implementation Brief from the actual Job reports and review evidence, then
   deliver the complete Stage implementation record to the user. 


## Fixes Procedure

If the `sane-worker-reviewer` finds issues, you may proceed with targeted fixes for each of the identified issues as fixes of the reviewed job before starting the next Job(s).

If the `sane-worker-reviewer` agent does NOT find issues, you may proceed with the next Job(s), however, you can expect that the next `sane-worker-implementer` may report gaps or missing work that its Job requires, in that case, the fixes will be assigned to the previous Job, and we will run an agent to attempt to fix all gaps before moving onto the next Job. Example:

- Job 03 completes, review accepts it and we go to Job 04
- Job 04 starts, but it identifies 2 missing gaps that it needs to start its work
- You receive the Job 04 report and then pass down the exact gaps reported or any file where they were written to the `sane-worker-fixer` for a fix targeted for Job 03
- Once that is done you can proceed with Job 04 again without running a reviewer
- You can do this process twice before scalating to the user for identifying any planning corrections


## Artifact Creation

Inspect `resources/` first. For a missing Job Implementation Report, create its
parent directory and copy `resources/IMPLEMENTATION_REPORT_TEMPLATE.md` to
`implementation/reports/<stage-id>-<stage-slug>/<job-id>-<job-slug>.md`. For a
missing Stage Implementation Brief, create its parent directory and copy
`resources/STAGE_IMPLEMENTATION_BRIEF_TEMPLATE.md` to
`implementation/briefs/STAGE_<two-digit-id>.md`. Derive `<two-digit-id>` only
from the selected valid Stage identifier; do not invent a Stage number. Never
overwrite an existing report or brief; edit the copy and preserve its required
headings and structure.

## Delivery

Make sure every carried-out Job has one matching Implementation Report at
`implementation/reports/<stage-id>-<stage-slug>/<job-id>-<job-slug>.md`, with
the same local ID, slug, and Job name. Based on the review-agent findings,
confirm that reports meet their Job Report Requirements, every completed execution
batch received a read-only review, and Stage Spec and Job Spec outcomes and handoff
obligations are addressed by actual reports and reviews. Before offering delivery, create or update
`implementation/briefs/STAGE_<two-digit-id>.md` from
`resources/STAGE_IMPLEMENTATION_BRIEF_TEMPLATE.md` if it is absent, preserving
the brief's structure if it already exists. The brief must concisely record only
actual implemented results, material repository changes, verification evidence,
and Design reconciliation or next-Stage technical context. It supplements and
does not replace one Implementation Report per carried-out Job. Report the
actual implementation and review state, including unresolved findings, to the
user.

## Approval and Boundaries

Depending on the user instructions, you may be able to approve jobs and move on with coordination until the Stage is done, or wait for user approval on specific chekcs. Initialize the selected Implementation Stage and all of the Job entries the user requests coordination for (or all in the plan) from the approved Execution Plan. 

Before every user-directed execution batch starts, mark only its Jobs `[~] Active`. After the review agent returns, record its material finding in the Job's optional Notes and mark it `[!] Blocked` when implementation or review evidence requires a user decision. Mark a Job `[✓] Approved` or `[x] Cancelled` only after the corresponding user decision. Do not change Foundation approvals or Stage Design or Execution entries.

## Clarifications

- An Implementation Report records one carried-out Job outcome. Copy the
  workstream-local `resources/IMPLEMENTATION_REPORT_TEMPLATE.md` to create it;
  Job-specific Report Requirements add evidence without changing its structure.
- A Stage Implementation Brief is one actual-state handoff after all authorized
  Jobs for the selected Stage have completed and been reviewed. 
- A Job changes to `[~] Active` immediately before its agent starts and remains
  Active through review. Record its report and review result in optional Notes
  when useful. Mark it `[!] Blocked` when evidence requires the user's decision;
  only the user can set its final `[✓] Approved` or `[x] Cancelled` state.
- Execution follows list order sequentially by default, honoring dependencies
  and any explicit sequencing or parallel authorization in `Split Notes`.
  Ambiguous or conflicting scheduling goes to Planning through the user. An
  execution batch adds no group tags, plan headings, or State statuses.
- State records coordination status, not the technical substance of a Job. Keep
  repository changes, evidence, deviations, and handoff detail in the matching
  Implementation Report.
