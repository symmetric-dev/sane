---
name: implementing-workstreams
description: Execute assigned thread work and keep execution state accurate.
---

# Implementing Workstreams

## Start Here

```bash
work status
work tree --batch "01.01"
work list --stream "<stream-id>" --thread "01.01.01"
```

Before substantive implementation work, link the current opencode session to your assigned thread using the custom tool:

- `link_thread_session` with your assigned `threadId`

Do this after confirming your workstream/thread scope and before marking execution in progress.

## Execution Rules

1. Work only on your assigned thread.
2. Link the current opencode session to your assigned thread with `link_thread_session` before implementation work begins.
3. Mark thread start: `work update --stream "<stream-id>" --thread "ID" --status in_progress`
4. Mark completion with report:
   `work update --stream "<stream-id>" --thread "ID" --status completed --report "1-2 sentence summary"`
5. If blocked:
   `work update --stream "<stream-id>" --thread "ID" --status blocked --report "reason and dependency"`

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
- If thread intent is unclear, review:
  - `work validate requirements`
  - `work review plan`
  - `work read --stream "<stream-id>" --thread "ID"`
