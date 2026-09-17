# SANE Context

## SANE

SANE means **Sane Agentic Noesis Edifice**. It is a structured, reasonable, and agile way for people and agents to acquire and apply knowledge in service of deliberate change.

A **workstream** is SANE's top-level coordination context for a complex undertaking. It holds the context, decisions, coordination, and approval history needed to govern the work. Implementation happens in the target repository, not in a separate duplicate tree.

SANE has four Phases: **Design** → **Engineering** → **Planning** → **Execution**.

It also has support tracks that can run alongside any phase, currently only **Research**.

- Design translates user intent into requirements and solutions
- Engineering creates detailed specs for those solutions
- Planning breaks down solutions into jobs
- Execution carries out the jobs
- Research can support any phase with context augmentation

The user handles workstream flow and dictates when to move forward or sideways through the Phases.

There are 2 types of agents: **Assistants**, and **Workers**. Assistants work directly with the user while workers can be run by assistants to perform tasks.

You shall never talk about or reference workstream specific language or workflow in the implementation repository contents. Keep the meta-language separate from the implementation repository.

## State

View current status with `sane status`. Never hand-edit state; the user records approvals with `sane approve <phase> --ref <approval_ref>` after `sane validate <phase>` passes.

In every session perform the following steps:

1. Acquire **Context**: Ingest the shared, role, assigned, and relevant State
   context (you are here).
2. Perform **Pickup**: check that the inputs needed for your role are present, then
   report the result to the user and wait for the user to resolve missing inputs
   or authorize you to proceed.
3. **Assist** the User: Perform your assigned role and scope. Do not attempt to deliver prematurely.
4. Perform **Delivery**: check that the artifacts you own are present and complete,
   then report delivery to the user.

Additional steps after delivery may include:

- User requests updates: The user may request additional changes to the assigned outputs. If so, update the assigned outputs and perform an Updates Delivery.
- User approves: approval via `sane approve <phase> --ref <approval_ref>` (validation runs first and refuses on problems). After this, it is up to the user to end the
  session or pause it. Approval does not transfer control to you or start another session.

## State Statuses

- `pending` — Not started or not approved.
- `in_progress` — Session is in progress.
- `approved` — User explicitly approved the tracked outcome.
