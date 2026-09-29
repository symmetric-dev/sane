# SANE App

SANE App is the browser interface for native Claude Code/OpenCode conversations,
repository/worktree navigation, files, Git, terminals, and workstream management.
Its implementation lives in [`packages/sane-app`](../../packages/sane-app/), with
shared domain operations in [`packages/sane-core`](../../packages/sane-core/).

## Current state

- Each repository's primary checkout owns its authoritative `.sane` workstream
  store. One App installation operates on many unrelated repositories; App
  configuration and chat/run history live in package-local ignored state.
- No old workstreams are carried forward and no migration is provided. Fresh
  initialization only; existing stores are never implicitly reset.
- Native handoffs are currently unavailable. Workstreams UX redesign is deferred.

## Read next

- [Ongoing work and next actions](ongoing/README.md) — current priorities.
- [Operator guide](../../packages/sane-app/HUMAN-OPERATOR-GUIDE.md#root-launch-and-current-storage-model)
  — root launch, current storage model, restart and origin configuration.
