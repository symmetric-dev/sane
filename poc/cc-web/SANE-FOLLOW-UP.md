# SANE follow-up — proposals, not implemented

The repository/worktree catalog is filesystem organization, not SANE membership.
These follow-ups do not change the owner-reported CC/OC baseline or establish
verification of the new workspace extension.

## Membership and presentation

- Make workstream membership explicit and optional. Multiple workstreams may use
  the same checkout; any main or linked worktree may also have unassigned work.
  Neither branch names nor path placement establish membership.
- Represent unknown/unavailable association separately from a confirmed absence of
  membership. Until a SANE association source is integrated, the UI must not label
  a conversation “unassigned” merely because it has no SANE data.
- Keep repository/worktree identity, conversation execution binding, and optional
  workstream membership separate. Browsing another tree must not retarget execution
  or silently change membership.

## Identity, context, and handoffs

- Carry harness-qualified native identity alongside the app conversation ID; CC
  and OC identifiers must not be assumed interchangeable. Scope execution context
  to the invocation, including its exact cwd and selected workstream/phase where
  explicitly known, rather than relying on one process-global active workstream.
- Define phase-handoff routing and delivery evidence across harnesses, including
  how recipients recover their intended context. The current bridge does not
  implement cross-harness phase handoffs.
- Audit concurrent-session and concurrent-workstream behavior before increasing
  execution concurrency. The current bridge still permits only one active run
  globally across both harnesses and all workspaces.
- Preserve the distinction between implementation checkout paths and management
  repository artifact directories. Workstream documents need not live in the
  executing worktree; handoffs must retain the correct artifact location.

## Follow-up CLI audit

Audit SANE CLI commands, durable bindings, identity assumptions, invocation-scoped
context, phase routing, and management-artifact path resolution against this model.
Determine which contracts already support it and which need changes. This is an
audit proposal, not a claim that a particular schema migration or mandatory CLI
change has been established.

Terminal is implemented and owner-verified for the PoC. Its original research and
remaining operational questions are retained in [TERMINAL-RESEARCH.md](TERMINAL-RESEARCH.md).
The PoC is closed; [formalization horizon](../../docs/sane-app/ongoing/HORIZON.md) places this workstream audit
before the app's workstream/artifacts UI.
