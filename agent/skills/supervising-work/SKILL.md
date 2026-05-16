---
name: supervising-work
description: Run `work supervise`, drive review/fix cycles, and report back to user.
---

# Supervising Workstreams

Use this skill when you are supervising workstream work.

## Goal

Run `work supervise` to execute the next batch, then enter the fix cycle:

1. launch a review subagent to assess quality and alignment to the plan
2. read the reviewer output and persisted workstream state
3. decide whether to run a fix subagent or report back to the user
4. if you run a fix subagent, re-enter the fix cycle and review again
5. stop only when the current scope is complete or escalation policy says to yield / report back

## Command usage

- For running a batch

```bash
work supervise --batch "SS.BB"
```

- For a resumed/interrupted batch, plain `work supervise` is the normal rerun path.

## Fix cycle

After each `work supervise` pass:

1. Inspect persisted state:

```bash
work batch-status --batch "SS.BB" --format json
work tree --batch "SS.BB"
```

2. Review the actual changed files against the batch's thread `WORK.md` contract(s), not just status output.
3. Launch a review subagent.
4. Judge the review against the escalation policy.
5. Either:
   - launch a fix subagent and then re-review, or
   - stop the loop and report back with a final report.

Notes:
- A fix subagent is optional when the batch is simple and review passes cleanly.
- Use at most one automatic fix cycle per batch.
- Inspect both canonical thread state and runtime/batch state; if they disagree, ground decisions in persisted evidence and actual changed files.
- Treat thread `WORK.md` plus stage `REQUIREMENTS.md` as the execution contract.

## Escalation policy

Treat canonical workstream state, actual review findings, and these supervision rules as the source of truth. In the default v1 behavior:

- at most **one automatic fix cycle per batch** is allowed
- **Report back** instead of continuing when review results require user input
- stage completion is a valid stop reason for stage-scoped supervision

Use the reviewer issue categories to decide whether to report back to user or fix:

- **severity**
- **difficulty**
- **ownership**
- **effort**

Report back instead of fixing when the persisted evidence indicates any of the following:

- user contact/escalation is required
- the automatic fix-cycle limit has been reached
- the current supervision scope is complete
- the issue is outside safe engineering-owned batch-local follow-up

If none of those conditions hold and a fix cycle is still allowed, run a fix subagent and re-enter review.

Prefer a small safe fix cycle when the issue is:

- clearly batch-local
- low or medium severity
- easy to verify afterward
- not product-directional

## Guardrails

- Do **not** launch another supervision branch.
- Do **not** ask the user questions during the supervision loop.
- Do **not** invent policy; rely on persisted state and the prompt's dynamic instructions.
- Keep the loop grounded in actual batch/stage state, not high-level orchestration discussion.

## Final report format

When you report back, the **final assistant message** must use exactly these headings:

```md
## Accomplished
## Issues Found
## Fixes Applied
## What is Next
```
