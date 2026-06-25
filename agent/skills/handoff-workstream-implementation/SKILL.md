---
name: handoff-workstream-implementation
description: Create a concise prompt for handing a planned workstream stage or batch to a management agent that will use `managing-workstream-implementation`.
---

# Handoff Workstream Implementation

## Model

This skill bridges plan creation to implementation management. It writes the prompt for the next agent; it does not run `work supervise`.

Use when the user wants to hand off a planned stage or batch to another agent.

## Workflow

1. Identify the stream id and requested stage or batch.
2. Inspect relevant files:
   - root `README.md`
   - stage `REQUIREMENTS.md`
   - stage `PLAN.md`
   - generated thread `WORK.md` files, if approval already created them
   - important `docs/` or `resources/` references
3. Write a ready-to-send handoff prompt using the template below.

## Handoff Prompt Template

```md
Please use the `managing-workstream-implementation` skill to manage implementation for <stream-id>, <stage-or-batch-scope>.

Scope:
- Stream: `<stream-id>`
- Stage/batch: `<stage-or-batch>`
- Goal: <one-sentence implementation goal>

Important files:
- `<path>` — <why it matters>
- `<path>` — <why it matters>

Notes:
- <locked decisions, risks, sequencing notes, or known constraints>
- <agent-runnable verification expected, if any>
- Manual user verification, visual review, and subjective e2e acceptance are outside agent execution unless a specific automated workflow is provided.

Please run the management loop for this scope, review actual changes against thread `WORK.md` and stage `REQUIREMENTS.md`, apply at most one safe fix cycle if appropriate, and report back with the required management report format.
```
