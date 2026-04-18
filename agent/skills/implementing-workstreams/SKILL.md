---
name: implementing-workstreams
description: Execute tasks for an existing workstream and keep task state accurate.
---

# Implementing Workstreams

## Start Here

```bash
work status
work tree --batch "01.01"
work list --tasks --thread "01.01.01"
```

Before substantive implementation work, link the current opencode session to your assigned thread using the custom tool:

- `link_thread_session` with your assigned `threadId`

Do this after confirming your workstream/thread/task scope and before marking tasks in progress.

## Execution Rules

1. Work only on your assigned thread.
2. Link the current opencode session to your assigned thread with `link_thread_session` before implementation work begins.
3. Mark task start: `work update --task "ID" --status in_progress`
4. Mark completion with report:
   `work update --task "ID" --status completed --report "1-2 sentence summary"`
5. If blocked:
   `work update --task "ID" --status blocked --report "reason and dependency"`

## Questions

- Do not ask questions to the user during implementation.
- If a task or plan is unclear, mark the task as blocked:
  `work update --task "ID" --status blocked --report "unclear: <specific question>"`
- Describe the exact ambiguity so it can be resolved during review.

## Report Quality

- Mention concrete files or modules changed.
- Include notable decisions or deviations.
- Keep it short and factual.

## Recovery

- If work is already done but status is stale, update status and add report.
- If task intent is unclear, review:
  - `work validate requirements`
  - `work review plan`
  - `work read --task "ID"`
