# Root Agent Branching Problem

## Summary

We introduced a **Root Agent** model where the user-facing top-level agent owns planning, review interpretation, fix-cycle decisions, and escalation to the user. Branch sessions are intended to run supervision work on behalf of the Root Agent while preserving enough context to avoid drift.

Live testing exposed a critical problem:

- a forked/branched session currently inherits so much of the Root Agent conversation that it may continue to behave as if **it is the Root Agent**
- instead of acting like a focused supervision branch, it reasons about launching another branch or continuing the higher-level orchestration loop
- the result is identity confusion, incorrect handoff assumptions, and misleading completion reports

This is not just a prompt issue. It is an architectural issue about **where a branch begins in the conversation timeline** and **what role-specific context is inherited**.

---

## Observed Problem

In a live branch test:

- native Opencode fork creation worked
- the branch session was real and correctly descended from the current Root Agent session
- but the branch behaved like a copy of the Root Agent rather than a constrained supervision worker

In practice, the branch:

- saw Root Agent-level reasoning in its inherited transcript
- interpreted itself as the orchestration owner
- became confused about why it was expected to run work directly rather than create or manage another branch
- produced a report from that confused identity model

So the problem is not just “branching works or does not work.” The problem is:

> **A naive fork of the current Root Agent session preserves too much Root Agent identity and orchestration context.**

---

## Why This Happens

Forking a session copies prior context. That is useful for preserving intent, but dangerous when the copied context includes:

- Root Agent role assumptions
- workflow control responsibilities
- prior discussion about supervising, planning, escalation, or branch creation itself
- language that makes sense only for the top-level user-facing agent

This means the branch is not starting from a clean role boundary. It is starting from a transcript that says, in effect:

- “you are the main agent”
- “you own the whole workflow”
- “you may need to launch supervision branches”

When the branch is then told it is a supervision branch, the inherited transcript and the new prompt may conflict.

---

## Core Insight

Branching should probably happen from a **checkpointed Root Agent state**, not necessarily from the live tip of the conversation.

The Root Agent likely needs one or more explicit branch-safe checkpoints such as:

- before workstream execution begins
- before supervision policy discussion diverges
- after a plan/tasks state is finalized
- before a new stage or major revision changes the orchestration context

This would make the branch inherit:

- the right workstream context
- the right task/plan context
- the right user intent

but **not** all of the later Root Agent orchestration reasoning that makes the branch think it is the Root Agent.

---

## Checkpoint-Based Direction

### Proposed Model

The Root Agent owns explicit **branching checkpoints**.

A checkpoint is a branch-safe Root Agent conversation state that can be reused to launch branch runs.

Possible semantics:

- `root checkpoint`: the current approved Root Agent state suitable for branch launches
- `supervision branch`: fork from the checkpoint, not from the latest live transcript
- `review branch`: fork from the same checkpoint plus branch-specific execution state
- `fix branch`: fork from a later checkpoint if the workstream context has materially changed

### Key Benefit

This reduces identity drift by ensuring the branch inherits only the context it actually needs.

### Key Cost

Checkpoints must be managed deliberately.

As soon as the Root Agent context changes materially, an older checkpoint may become unsafe or stale.

Examples of checkpoint-invalidating changes:

- updated plan or task assignments
- revised escalation policy
- stage/revision added to the workstream
- major user preference change
- architectural change that affects the meaning of a fix cycle

---

## Working Hypothesis

The branching model may need to become:

1. Root Agent creates or refreshes a checkpoint
2. Branch runs always fork from that checkpoint
3. Branch reports back to Root Agent
4. If Root Agent context has materially changed, Root Agent must create a new checkpoint before future branches

This would mean the system is not simply “branch from current session.”

It becomes:

> **branch from the latest valid Root Agent checkpoint**

---

## Implications for Workstream Flow

If checkpointing is required, then branch orchestration needs additional state such as:

- `rootSessionId`
- `checkpointSessionId`
- `checkpointCreatedAt`
- `checkpointScope` or `checkpointReason`
- `branchSessionId`
- `branchType` (`supervision`, `review`, `fix`)
- whether the checkpoint is still valid for the current workstream state

Potential workstream lifecycle:

1. Root Agent plans the workstream
2. Root Agent approves the point at which branching is safe
3. System records a checkpoint session ID
4. Supervision/review/fix branches fork from that checkpoint
5. Root Agent decides whether checkpoint remains reusable
6. If context changes too much, Root Agent refreshes checkpoint

---

## Open Questions

1. Can Opencode fork from an older session/checkpoint directly and reliably?
2. Do we need explicit checkpoint persistence in repo state, or can native Opencode session lineage be enough?
3. What exactly counts as a “material context change” requiring a new checkpoint?
4. Should branches inherit only transcript context, or should some branch context be injected from workstream state instead of copied from chat?
5. Can branch role be made strong enough via prompt/tooling alone, or is checkpointing necessary?
6. Should supervision, review, and fix all fork from the same checkpoint, or should they form a branch tree?

---

## Likely Next Design Steps

1. Decide whether to formalize a **checkpoint** concept in workstream state
2. Define what makes a checkpoint valid or stale
3. Determine whether branches should fork from:
   - current Root Agent tip, or
   - last valid checkpoint
4. Add explicit branch role constraints so a branch does not reinterpret itself as the Root Agent
5. Test a minimal checkpoint-based live branch flow before deepening implementation

---

## Current Conclusion

The live test suggests that **native branching alone is not enough**.

Without a role-safe branching point, the branch can inherit too much Root Agent identity and become confused about its job.

The most promising direction is:

- keep the Root Agent as the true top-level owner
- use branch sessions for supervision/review/fix work
- introduce a deliberate **checkpoint-based branching model** so branches inherit the right context, not all context

This should be treated as a new design problem, not just a bug in the current branch-launch implementation.
