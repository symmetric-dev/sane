# Root Agent Branching Architecture

This document records the major branching architecture challenges we encountered while evolving AgEnv from a prompt-driven supervision experiment into a more durable Root-Agent-owned branch execution model.

It is intended as a durable architectural reference for future work, not just a test log.

For operator-facing runbooks and validation steps, use:

- [`docs/SUPERVISOR.md`](./SUPERVISOR.md) for supervision operations and troubleshooting
- [`docs/supervision-manual-verification-checklist.md`](./supervision-manual-verification-checklist.md) for concise manual verification drills

## Why this work mattered

AgEnv's supervision model is built around a **Root Agent**:

- the user-facing top-level agent owns planning, review interpretation, fix-cycle decisions, and escalation
- child/branch agents should execute bounded supervision work on behalf of the Root Agent
- CLI commands such as `work supervise` should remain execution primitives, not the true orchestration owner

The challenge was making branch agents reliable enough to act like alternate Root-Agent timelines without inheriting too much meta-context or depending on fragile interactive session behavior.

## Main challenges we hit

### 1. Naive session forks inherited too much Root-Agent identity

Early native forks copied too much recent Root-Agent conversation state.

That caused child sessions to:

- behave as if they were still the Root Agent
- reason about launching more branches
- critique the branch prompt instead of doing the work
- produce misleading completion reports

### 2. Conversational checkpoints were too noisy

An early idea used a checkpoint prompt such as `CHECKPOINT READY` inside a child session.

That turned out to be the wrong abstraction because it:

- polluted transcript context with checkpoint semantics
- introduced more meta-text into the branch timeline
- still did not give us a true branch-safe timeline boundary

### 3. Tool/runtime loading was easy to get wrong

We repeatedly hit stale-tool situations where:

- an older globally installed tool was still loaded
- or a repo-local `.opencode/tools/workstream.ts` shadowed the fresh tool install
- or Opencode server/client state still had an old tool registry cached

This produced false negatives during live tests and made some branch failures look architectural when they were really install/runtime mismatches.

### 4. Prompt shape leaked too much branch plumbing

Early prompt generations included details like:

- explicit branch identity framing
- branch scope labels
- root/branch/checkpoint session IDs
- full `work supervise` plumbing flags inside the user-facing prompt

That made the prompt too meta and increased the chance that the child agent reasoned about the transport rather than simply performing supervision.

### 5. The initial branch execution transport was too interactive

The original message-boundary branch launch path behaved like:

1. fork a child session
2. post the prompt into the child session
3. rely on the child session's interactive message loop to continue and yield

Compared with normal working agents, this was more fragile:

- more dependent on Opencode session-loop behavior
- more vulnerable to stale queued/running UI state
- harder to reason about when the child was actually done

### 6. Opencode UI/session state could look stuck even when work progressed

In live testing, branch sessions sometimes looked continuously running until:

- the user entered the child session manually, or
- sent another user message

Research suggested this is plausibly an Opencode limitation around stale UI/session state, orphaned tool/message state, or queued-message loop-boundary behavior, rather than a simple AgEnv logic bug.

## Architectural fixes we made

### 1. Replaced conversational checkpoints with metadata-only checkpoint pointers

Instead of inserting checkpoint prompts into the transcript, the system now records checkpoint metadata such as:

- root session id
- checkpoint message id/index
- breakpoint selection strategy
- checkpoint creation timestamp

This keeps checkpoints out of the child transcript and makes the selected branch boundary an engineered state owned by tooling.

### 2. Moved from live-tip forking to message-boundary branching

We added explicit breakpoint selection so branches can start from a specific transcript boundary rather than always from the current session tip.

Supported behavior now includes:

- explicit tagged breakpoints (for example `SESSION_BREAKPOINT`)
- default fallback to the previous user message before launch
- explicit `breakpointMode` selection:
  - `prefer_tagged`
  - `previous_user`

This lets us create cleaner alternate timelines and reduces identity drift.

### 3. Simplified prompt semantics and added a dedicated supervision skill

We introduced `agent/skills/supervising-workstreams/SKILL.md` and removed much of the meta prompt clutter.

The branch prompt now focuses on:

- the user-like supervision request
- the target scope (batch or stage)
- running `work supervise`
- review/fix-cycle expectations
- returning a structured final report

It no longer needs to expose most branch/root/checkpoint plumbing to the child agent.

### 4. Added auto-resolved branch supervision context

Stage 16 moved branch/session/checkpoint metadata into runtime/persisted state so `work supervise` can resolve the active branch context automatically.

That means:

- branch agents can use plain `work supervise` (or minimally scoped `work supervise --batch ...`)
- explicit lineage/checkpoint CLI flags are retained mainly as low-level override/debug paths
- the prompt no longer needs to carry all branch metadata inline

### 5. Added scope-aware branch tracking

Branch state now supports at least two explicit scope levels:

- `batch`
- `stage`

This lets branch lifecycle tracking remain session-level while the execution primitive stays batch-bounded.

Stage-scoped branches:

- still run `work supervise` one batch at a time
- derive the next incomplete/resumable batch from persisted stage state
- yield when the stage is complete or policy says to stop

### 6. Hardened branch monitoring and report extraction

We improved parent-side finalization so the Root Agent can rely on persisted evidence instead of trusting UI state.

Important elements include:

- durable `branch_sessions[]` state in canonical supervision runtime storage
- transcript export from the child native session
- extracting the last completed assistant message as the branch report
- keeping branch finalization parent-owned

### 7. Added runtime diagnostics and install metadata

To reduce stale-tool confusion, we added:

- `workstream_tool_runtime_info`
- tool version metadata
- install-time version/path reporting in `sane install tools --opencode`

This made it much easier to distinguish:

- stale loaded tool code
- stale server/client state
- fresh installed files on disk

### 8. Switched branch execution to a headless child-session model

The latest architectural change was to align branch execution more closely with working-agent behavior.

Instead of depending primarily on the interactive child-session message loop, the new model is:

1. choose the checkpoint/breakpoint boundary
2. fork the child session from that boundary
3. execute the child **headlessly**
4. preserve durable child session identity and transcript export
5. finalize parent-side from persisted evidence

This is the key fix for making branches behave more like bounded workers while still preserving transcript continuity and branch lineage.

### 9. Added observable supervision tmux sessions and recovery tooling

Recent work completed the missing operational pieces around branch supervision runs:

- top-level supervision branches now launch in their own `001-supervision-*` tmux session
- implementation work launched by `work supervise` / `work continue` remains in separate `001-implementation-*` tmux sessions
- branch launch now validates tmux startup early enough to fail fast when the session never really starts
- duplicate launch protection is scope-aware and now distinguishes truly live sessions from reconciled terminal ones
- parent/runtime state records process-end evidence such as:
  - `processEndedAt`
  - `processExitCode`
  - `finalizationSource`
  - `finalizationReason`
- a dedicated recovery/debugging tool now exists:
  - `reconcile_workstream_supervision`

This means the system can now recover a supervision run that already ended even when the original parent launch call did not stay alive long enough to reconcile terminal state itself.

### 10. Added durable diagnostics and realistic tmux/tool E2E coverage

To make branch failures easier to debug and less dependent on guesswork, the system now also has:

- file-based debug logging for major workstream tool/runtime phases
  - default log: `/tmp/agenv-workstream-tool.log`
- deterministic tmux integration coverage for the branch-launch path
- an opt-in real Opencode E2E test that proves:
  - an Opencode session can call a tool
  - that tool can launch tmux
  - the tmux session can run a real `opencode run ...`
  - the resulting session can be found, exported, and parsed

## What we verified

Across the revisions we verified that:

- message-boundary selection works
- `previous_user` mode can force the immediately previous user turn as the branch boundary
- batch-scope and stage-scope branch semantics both work
- stage-scoped branches can progress across sequential batches inside one stage
- root-agent-level `work supervise` works independently of branch orchestration
- the latest branch path can produce a proper structured final report with:
  - `## Accomplished`
  - `## Issues Found`
  - `## Fixes Applied`
  - `## What is Next`
- supervision branch tmux sessions are observable separately from implementation tmux sessions
- stale ended-but-nonterminal branch sessions can be reconciled safely after the fact using `reconcile_workstream_supervision`
- process-end evidence can be persisted even when explicit finalization is missing
- a reconciled terminal `stopped` session no longer blocks a fresh launch for the same scope
- operator verification should prefer the `work batch-status` CLI plus canonical supervision runtime state over assuming a specific persisted batch-status file path or treating a single pointer field as sufficient truth

## Remaining caveats

Even with the new model, some risks remain external to AgEnv:

- Opencode UI/session state may still appear stuck even when the backend has progressed
- manual session entry may refresh stale UI state
- follow-up user messages may recover from orphaned message/tool states in some Opencode failure modes

And some remaining product/runtime caveats are now clearer:

- prompt compliance is still separate from runtime correctness
  - a branch session can launch, run, and exit cleanly while still doing the wrong thing semantically
- parent-side reconciliation after process end is good, but fully automatic launch-time recovery is still a future improvement
- the recovery tool is intentionally conservative and may prefer `stopped` / `failed` over an optimistic success classification when evidence is ambiguous

Because of that, AgEnv should continue to treat persisted state and transcript export as the source of truth, not the TUI spinner state.

## Recommended design principles going forward

1. **Keep the Root Agent as the policy owner.**
2. **Keep branch prompts user-like and low-meta.**
3. **Keep branch metadata in tooling/runtime, not in the prompt.**
4. **Treat transcript boundaries as engineered state.**
5. **Prefer worker-like branch execution over interactive child-session loops.**
6. **Use persisted branch/session artifacts as truth over UI state.**
7. **Preserve transcript exportability so parent-side finalization remains inspectable and debuggable.**
8. **Separate process-end detection from semantic supervision success.**
9. **Keep a manual recovery path (`reconcile_workstream_supervision`) even if automatic reconciliation is added later.**

## Future considerations

1. Add automatic launch-time recovery so `workstream_launch_supervision_branch` can reconcile stale ended sessions before deciding whether to relaunch.
2. Continue tightening branch prompts and/or prompt scaffolding so child sessions execute supervision immediately instead of commenting on instructions.
3. Consider exposing a more explicit status split between:
   - process ended
   - terminal supervision state persisted
   - semantic supervision outcome accepted
4. Keep expanding realistic E2E coverage whenever new branch/session transport logic is introduced.
5. Treat debugging ergonomics as a first-class feature:
   - stable logs
   - stable tmux naming
   - clear recovery commands
   - clear state-file error messages

## Related references

- `ROOT_AGENT_BRANCHING.md`
- `docs/SUPERVISOR.md`
- `docs/supervision-manual-verification-checklist.md`
- `agent/skills/supervising-workstreams/SKILL.md`
- `work/000-super-agent-v1/PLAN.md`
