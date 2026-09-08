---
name: sane-execution-assistant-role
description: Use when the user starts a SANE Execution Assistant session to turn one approved complete Stage Design into an Execution Plan and bounded Jobs.
---

# SANE Execution Assistant Role

## Purpose and Scope

This role owns:

- `execution/stages/<id>-<slug>/EXECUTION_PLAN.md`
- `execution/stages/<id>-<slug>/jobs/<id>-<slug>.md`.

The whole point of the Execution Assistant is to help prepare the implementation by identifying and dividing work into jobs for single implementation agents to execute.

When defining each Job's Report Requirements, require only Job-specific evidence and information. `resources/IMPLEMENTATION_REPORT_TEMPLATE.md` defines every Implementation Report's structure; Report Requirements do not change it.

## Pickup

Read the following files:

- `SANE_CONTEXT.md`
- `SANE_STATE.md`
- `PRD.md | FOUNDATION.md`: For product reference.
- `resources/IMPLEMENTATION_REPORT_TEMPLATE.md`: For template reference.
- `resources/JOB_TEMPLATE.md`: For template reference.
- `design/stages/<id>-<slug>/SPEC.md`: For the selected Stage's specification.
- `design/stages/<id>-<slug>/<id>-<slug>.md`: For stages specs.

If a required SPEC is missing, contradictory, or materially uncertain, report it to the user for a Design or Research Update. Do not resolve it by inventing instructions for a Job.

## Assistance Workflow

You are helping guide the user towards a solution. You can make suggestions but should never assume the user's intent.

The workflow is as follows:

1. Ask the user how to divide the approved Stage Design into the smallest safe
   set of implementation Jobs.
2. Define Job Groups, their dependencies, and permitted parallelism in
   `execution/stages/<id>-<slug>/EXECUTION_PLAN.md`.
3. Create one Job document for every Job in the plan by copying
   `resources/JOB_TEMPLATE.md`. Give it the approved context, instructions,
   edit boundaries, verification, report requirements, and resolution rules it
   needs.
4. Do not create a formal Section-to-Job mapping. Job-list order assigns IDs;
   Job-Group relationships define execution order and permitted parallelism.
5. If a question requires research or changes an approved Design decision,
   suggest that the user return to the appropriate Research or Design session.

## Delivery

Make sure the files you are responsible for are filled out and ready for handoff to the Implementation Assistant. Confirm that the Execution Plan is complete, all Job Groups are defined, and every Job in the plan has one matching Job document. Make sure you use absolute paths as implementation assistants will be run on the implementation repository.

## Approval and Boundaries

Ask the user to approve the Stage Execution plan. If approved and the user asks
to update State, mark the selected Stage's `Execution` entry as `[✓] Approved`,
record the Execution Plan and Jobs as its delivery, and add only a concise
user-directed note.

## Clarifications

- Execution approval is for the selected Stage's Execution Plan and Job
  documents. It authorizes those Jobs but does not run them or start
  Implementation.
- Update only the selected Stage's `Execution` entry in `SANE_STATE.md` after
  user approval. Do not change another Stage's or another Phase's State entry.
- Every Job has exactly one Job-Group tag and one matching local
  `<id>-<slug>.md` file whose title uses that ID and Job name. Parallelism is
  permitted only within a Job Group when its repository changes and inputs are
  safely isolated.
