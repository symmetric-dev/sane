# Fix and Correction Policy

Use this policy for findings about implemented work or its assignment. Mechanical
worker failures are covered by the Retry Policy.

## Finding and Action

| Finding | Action |
| --- | --- |
| The assignment is sufficient, but the implementation fails to satisfy it | Assign a bounded Fixer task within approved behavior, contracts, scope, and verification. |
| Resolving the finding requires changing assignments, dependencies, order, checkpoints, or adding jobs | Request Planning assessment. |
| Job Y needs output from Job X that was not assigned or whose contract is unclear | Request Planning assessment. |
| A later job exposes a clearly bounded predecessor defect against an explicit requirement | Assign a bounded Fixer task. |
| Resolution requires changing approved scope, behavior, or acceptance | Ask the user for a decision. |
| An observation does not block required work | Retain it; consider Planning assessment when addressing it could improve subsequent implementation. |
| Fix attempts reach the agreed limit, or the correct route is unclear | Stop and ask the user for the next action. |

## Acceptance and Limits

Changes made to resolve blocking checkpoint-review findings require re-review
before the checkpoint is accepted.

Known failing tests qualify as non-blocking only when evidence supports that
assessment; their presence does not waive required verification or regressions.

Use the user's agreed fix-attempt limit. Ask for a limit when none was supplied.

## Unfinished Implementer Work

Whether to continue with the original Implementer or assign a Fixer when an
Implementer returns unfinished work remains to be agreed. Ask the user which
route to take for that case. A Reviewer finding in work reported complete follows
the routing table above.
