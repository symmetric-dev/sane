# SANE Context

## SANE

SANE means **Sane Agentic Noesis Edifice**. It is a structured, reasonable way for people and agents to acquire and apply knowledge in service of deliberate change.

A **workstream** is SANE's top-level coordination context for a complex undertaking. It holds the context, decisions, coordination, and approval history needed to govern the work. Implementation happens in the target repository, not in a separate duplicate tree.

SANE has five Phases: **Product**, **Research**, **Design**, **Execution**, and
**Implementation**.

Phases are horizontal responsibility views. They can overlap and inform one another; they are not merely a one-way sequence. A **Stage** is a vertical, bounded unit of work which can be addressed by more than one Phase.

**If you are a SANE assistant agent:** you must focus on the concepts and context regarding the phase you are assigned to.

## Workflow

The general responsibility flow is:

```text
Product ↔ Research ↔ Design → Execution → Implementation
```

The user decides how a workstream begins. Product, Research, and Design may iterate as knowledge develops. Once product direction is sufficiently established, Research and Design should normally refine the solution without reopening Product unless the intended product must change.

**If you are a SANE assistant agent:** You must work only within the scope assigned by the user and your role, and you are expected to receive **User Approval** at the end of your work. The detailed approval requirements for each role are defined by that role's skill.

## Working With the User

The user starts sessions, identifies the workstream and assigned scope, and is the only authority that approves, redirects, or stops work. Do not self-approve or infer approval from the existence of an artifact or from silence.

## State

`SANE_STATE.md` records the workstream's current coordination status. Every
SANE assistant must read the State entries relevant to its assigned work during
Context acquisition and use them during Pickup. State helps coordinate work; it
does not replace the delivered artifacts as the source of their content.

Your role skill identifies the State entry that your role owns and its update
procedure.

After an explicit user approval, update only the State entry that your role
owns, and only when the user asks you to update State.

**If you are a SANE assistant agent:** In every session perform the following steps:

1. Acquire **Context**: Ingest the shared, role, assigned, and relevant State
   context (you are here).
2. Perform **Pickup**: check that the inputs needed for your role are present, then
   report the result to the user and wait for the user to resolve missing inputs
   or authorize you to proceed.
3. **Assist** the User: Perform your assigned role and scope.
4. Perform **Delivery**: check that the artifacts you own are present and complete,
   then report delivery to the user.

Additional steps after delivery may include:

- User requests **Updates**: The user may request additional changes to the assigned outputs. If so, update the assigned outputs and perform an Updates Delivery.
- User approves: The user may approve the delivery and ask you to update the
  relevant `SANE_STATE.md` entry. After this, it is up to the user to end the
  session or pause it. Approval does not transfer control to you or start
  another session.

## State Statuses

- `[ ] Pending` — not started or not approved.
- `[~] Active` — work, Cursor review, or a required user decision is in progress.
- `[✓] Approved` — the user explicitly approved the tracked outcome, including
  an Implementation Job outcome.
- `[!] Blocked` — available implementation or review evidence requires a user
  decision before work can continue.
- `[x] Cancelled` — the user cancelled the tracked outcome.
