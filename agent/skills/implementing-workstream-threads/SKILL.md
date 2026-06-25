---
name: implementing-workstream-threads
description: Execute one assigned workstream thread, follow its `WORK.md` contract, run agent-runnable checks, and keep thread state accurate.
---

# Implementing Workstream Threads

## Model

A thread is the minimum implementation contract assigned to one agent.

Work only on the assigned thread. Treat thread `WORK.md` as the primary contract; `PLAN.md` is orchestration context.

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

Before substantive work, link the current session with `link_thread_session` using the assigned `threadId`.

## Execution Rules

1. Keep `--stream "<stream-id>"` explicit on thread-scoped commands.
2. Mark start: `work update --stream "<stream-id>" --thread "ID" --status in_progress`.
3. Change only files allowed by the thread contract.
4. Follow any `Implementation Sketch` unless it conflicts with explicit constraints.
5. Run only agent-runnable verification: tests, typechecks, linters, or specified automated workflows.
6. Mark completion with report: `work update --stream "<stream-id>" --thread "ID" --status completed --report "summary"`.
7. If blocked: `work update --stream "<stream-id>" --thread "ID" --status blocked --report "reason and dependency"`.

## Guardrails

- Do not ask the user questions during implementation.
- Do not invent structure when the thread doc has placeholders or ambiguity; block with the exact ambiguity.
- Do not perform manual user verification, visual review, subjective UX acceptance, or unscripted e2e flow review.
- Keep reports short, factual, and tied to concrete files or checks.
