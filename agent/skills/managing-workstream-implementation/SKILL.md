---
name: managing-workstream-implementation
description: Manage workstream implementation by running `work supervise`, inspecting state, reviewing changes, applying safe fix cycles, and reporting completion or escalation.
---

# Managing Workstream Implementation

## Model

Management owns the implementation loop. It is not a post-implementation phase.

The loop is: run implementation agents, inspect state, review actual changes, apply one safe fix cycle when appropriate, re-review, then report or continue.

## Workflow

1. Run the assigned scope. For a batch scope:

```bash
work supervise --batch "SS.BB"
```

For a stage scope, inspect the stage state and run the next incomplete or resumable batch in that stage. `work supervise` is still a single-batch primitive. For resumed/interrupted work, plain `work supervise` is the normal rerun path.

2. Inspect persisted state:

```bash
work batch-status --batch "SS.BB" --format json
work tree --batch "SS.BB"
```

3. Review actual changed files against each thread `WORK.md` and stage `REQUIREMENTS.md`. Use `reviewing-workstream-implementation` criteria, but do not launch a review subagent by default.
4. Decide whether to report back or run one safe fix subagent.
5. If a fix subagent runs, inspect its changes and re-review before reporting.
6. For a stage scope, repeat batch selection only while the stage still has in-scope incomplete work and policy allows continuing.

## Fix Policy

Use at most one automatic fix cycle per batch.

Prefer a fix cycle only when the issue is batch-local, engineering-owned, low/medium severity, and easy to verify with agent-runnable checks.

Report back instead of fixing when user input is required, the fix-cycle limit is reached, scope is complete, or the issue is product-directional, cross-stage, manual-validation-only, or outside the batch contract.

## Guardrails

- Do not launch another management/supervision branch.
- Do not ask the user questions during the management loop.
- Do not perform unrelated implementation yourself.
- Ground decisions in persisted state, runtime evidence, actual files, thread `WORK.md`, and stage `REQUIREMENTS.md`.
- Manual user verification, visual review, and subjective e2e acceptance are outside agent execution unless a specific automated workflow is provided.

## Final Report Format

Use exactly these headings:

```md
## Accomplished
## Issues Found
## Fixes Applied
## What is Next
```
