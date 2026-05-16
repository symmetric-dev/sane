---
name: implementing-work
description: Execute assigned thread work and keep execution state accurate.
---

# Implementing Workstreams

## Start Here

```bash
work status --stream "<stream-id>"
work tree --stream "<stream-id>" --batch "01.01"
work list --stream "<stream-id>" --thread "01.01.01"
work read --stream "<stream-id>" --thread "01.01.01"
```

Read documents in this order:

1. `stages/<stage>/threads/<thread-id>/WORK.md`
2. `stages/<stage>/REQUIREMENTS.md`
3. `README.md`

Treat thread `WORK.md` as the primary implementation contract. `PLAN.md` is orchestration context, not the worker source of truth.

Before substantive implementation work, link the current opencode session to your assigned thread using the custom tool:

- `link_thread_session` with your assigned `threadId`

Do this after confirming your workstream/thread scope and before marking execution in progress.

## Execution Rules

1. Work only on your assigned thread.
2. Link the current opencode session to your assigned thread with `link_thread_session` before implementation work begins.
3. Keep `--stream "<stream-id>"` explicit on thread-scoped commands.
4. Mark thread start: `work update --stream "<stream-id>" --thread "ID" --status in_progress`
5. Mark completion with report:
   `work update --stream "<stream-id>" --thread "ID" --status completed --report "1-2 sentence summary"`
6. If blocked:
   `work update --stream "<stream-id>" --thread "ID" --status blocked --report "reason and dependency"`
7. If the thread `WORK.md` contains an `Implementation Sketch`, follow it unless it conflicts with explicit file constraints or stage requirements.
8. Do not invent new structure when the thread doc still has placeholders or ambiguity. Block and report instead.

## Questions

- Do not ask questions to the user during implementation.
- If a thread or plan is unclear, mark the thread as blocked:
  `work update --stream "<stream-id>" --thread "ID" --status blocked --report "unclear: <specific question>"`
- Describe the exact ambiguity so it can be resolved during review.

## Report Quality

- Mention concrete files or modules changed.
- Include notable decisions or deviations.
- Keep it short and factual.

## Recovery

- If work is already done but status is stale, update status and add report.
- If runtime says failed but implementation is complete, verify the actual files, then update the thread state explicitly with `--stream` and include a factual report.
- If thread intent is unclear, re-read:
  - `work read --stream "<stream-id>" --thread "ID"`
  - the assigned thread `WORK.md`
  - `stages/<stage>/REQUIREMENTS.md`
