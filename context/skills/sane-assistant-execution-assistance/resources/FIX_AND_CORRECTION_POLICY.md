# Fix and Correction Policy

Use this policy for findings about implemented work or its assignment. Mechanical
worker failures are covered by the Retry Policy.

## Finding and Action

| Finding | Action |
| --- | --- |
| The assignment is sufficient, but the implementation fails to satisfy it | Assign a bounded Fixer task within approved behavior, contracts, scope, and verification. |
| Resolving the finding requires changing assignments, dependencies, order, checkpoints, or adding jobs | Request Planning assessment. |
| A Job cannot proceed because predecessor output is missing or inconsistent | Obtain prerequisite-gap assessment, then route grouped defects to Fixer and missing or conflicting assignments to Planning. |
| Resolution requires changing approved scope, behavior, or acceptance | Ask the user for a decision. |
| An observation does not block required work | Retain it; consider Planning assessment when addressing it could improve subsequent implementation. |
| Fix attempts reach the agreed limit, have no new basis, or the correct route is unclear | Stop and ask the user for the next action. |

## Acceptance and Limits

Changes made to resolve blocking checkpoint-review findings require re-review
before the checkpoint is accepted.

Known failing tests qualify as non-blocking only when evidence supports that
assessment; their presence does not waive required verification or regressions.

Use the user's agreed fix-attempt limit. Ask for a limit when none was supplied.

## Unfinished Implementer Work

Continue an unfinished assignment with Implementer when its contract and
prerequisites are sufficient and the remaining work has a clear next step.
Use Fixer for an identified bounded defect, and prerequisite-gap assessment
for missing inputs. A useful discovery return is not implementation acceptance;
resolve its effect on the Job before marking that Job completed.
