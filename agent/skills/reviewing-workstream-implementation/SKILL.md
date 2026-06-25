---
name: reviewing-workstream-implementation
description: Review implemented workstream batches or threads against `WORK.md`, stage requirements, actual changed files, and agent-runnable verification evidence.
---

# Reviewing Workstream Implementation

## Model

Implementation review judges completed agent work against the execution contract. It does not review abstract plans and does not perform manual user acceptance.

Primary contract order:

1. thread `WORK.md`
2. stage `REQUIREMENTS.md`
3. root `README.md`
4. relevant `docs/` and `resources/`

## Review Checks

- Required thread deliverables are present and observable.
- Changes stay within allowed files and boundaries.
- Locked decisions and out-of-scope notes were respected.
- Automated verification was run or a concrete reason is reported.
- No manual user verification, visual review, subjective UX acceptance, or unscripted e2e flow review is treated as agent work.

## Findings

Classify each issue by:

- severity: high, medium, low
- difficulty: complex, regular, trivial
- ownership: engineering, product, user-validation
- effort: thread, batch, stage, workstream

Recommend a safe fix only when the issue is engineering-owned, batch-local, within scope, and verifiable by agents. Otherwise recommend reporting/escalation.
