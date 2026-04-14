---
name: supervising-workstreams
description: Run `work supervise`, drive review/fix cycles, and yield back with a Root-Agent-facing supervision report.
---

# Supervising Workstreams

Use this skill when you are supervising an existing workstream on behalf of the Root Agent.

## Goal

Run `work supervise` to execute the next batch, then enter the fix cycle:

1. launch a review subagent to assess quality and alignment to the plan
2. read the reviewer output and persisted workstream state
3. decide whether to run a fix subagent or yield back to the user/Root Agent
4. if you run a fix subagent, re-enter the fix cycle and review again
5. stop only when the current scope is complete or escalation policy says to yield

Once branch context is active, do **not** add root/branch/checkpoint lineage flags to `work supervise`; tooling resolves that context automatically.

## Command usage

- For a bounded batch run:

```bash
work supervise --batch "SS.BB"
```

- For a resumed/interrupted batch, plain `work supervise` is the normal rerun path.
- For stage scope, keep `work supervise` batch-bounded: inspect persisted stage state, choose the next incomplete or resumable batch inside that stage, and pass `--batch` only when you need to select a new bounded batch.

## Fix cycle

After each `work supervise` pass:

1. Inspect persisted state:

```bash
work batch-status --batch "SS.BB" --format json
work tree --batch "SS.BB"
```

2. Launch a review subagent.
3. Judge the review against the escalation policy.
4. Either:
   - launch a fix subagent and then re-review, or
   - yield back with a final report.

## Escalation policy (v1, conservative)

Treat persisted `work/supervisor.json` policy and canonical workstream state as the source of truth. In the default v1 behavior:

- at most **one automatic fix cycle per batch** is allowed
- a branch should **yield** instead of continuing when review results require user input
- stage completion is a valid yield/stop reason for stage-scoped supervision

Use the reviewer issue categories to decide whether to yield or fix:

- **severity**
- **difficulty**
- **ownership**
- **effort**

Yield back instead of fixing when the persisted evidence indicates any of the following:

- user contact/escalation is required
- the automatic fix-cycle limit has been reached
- the current supervision scope is complete
- the issue is outside safe engineering-owned batch-local follow-up

If none of those conditions hold and a fix cycle is still allowed, run a fix subagent and re-enter review.

## Guardrails

- Do **not** launch another supervision branch.
- Do **not** ask the user questions during the supervision loop.
- Do **not** invent policy; rely on persisted state and the prompt's dynamic instructions.
- Keep the loop grounded in actual batch/stage state, not high-level orchestration discussion.

## Final report format

When you yield back, the **final assistant message** must use exactly these headings:

```md
## Accomplished
## Issues Found
## Fixes Applied
## Next For The User
```

Rules:

- In `## Next For The User`, explain whether the current scope is done, why you are yielding now, and what the user should do next.
- If a section has nothing to report, write `None.`
- Stop after that final report and wait for input.
