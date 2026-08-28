# Workstream V2 Delivery Approach

## Command coexistence

V2 will be exposed through a separate `work-v2` executable while it is being
developed and validated.

- `work` continues to run V1 unchanged.
- `work-v2` uses only V2 layout, state, commands, and terminology.
- V1 and V2 must not share workstream state for a source repository.
- After V2 is accepted, it may be promoted to the `work` executable in a
  breaking release and V1 may be retired.

Using a separate executable makes command usage, scripts, help text, and state
ownership unambiguous during the transition.

## Implementation boundary

V2 will be implemented in the existing `@agenv/workstreams` package, using new
V2 modules rather than incrementally reshaping the V1 Batch/Thread domain.

Reusable execution mechanics—provider adapters, process lifecycle, retries,
cancellation, heartbeat, observability, and tmux/OpenCode launching—may be
adapted behind V2 Job Group and Job interfaces. V2 planning, management,
approval, prompt, and state models are new implementations.

The exact unresolved contracts are intentionally deferred to workstream
research. This document records only the delivery boundary, not a detailed
implementation plan.
