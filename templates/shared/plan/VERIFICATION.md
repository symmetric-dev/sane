# Verification Spec: {{checkpoint id}}

<!-- Author one spec at execution/verification/<checkpoint-id>.md for each
Execution Plan checkpoint; lowercase its label and replace spaces with hyphens
in the filename. Replace guidance and slots before Planning delivery.
Retain these three H2 sections once each and in order.
This document belongs to Planning and Execution, not to Job Specs or Implementer
assignments. Refer to approved requirements and delivered behavior without
duplicating Job Specs. Define required evidence, not worker assignments or the
crew's scheduling. Do not add new acceptance requirements or record results. -->

## Scope

<!-- Name the checkpoint's jobs, their integration boundary, and any relevant
earlier delivered behavior. Identify exclusions and link the approved requirements
being verified. Keep the scope bounded to this checkpoint. -->

{{Jobs and behavior to verify.}}

## Review Focus

<!-- Identify checkpoint-specific correctness concerns, changed contracts,
constraints, and relevant static checks. Reference existing procedures and
still-applicable implementation evidence rather than copying general Reviewer
instructions or requiring redundant checks. Include commands, working directories,
expected evidence, and prerequisites only where needed for this checkpoint.
State when no additional review focus beyond the scoped requirements is needed. -->

{{Review concerns and static evidence needed for the combined result.}}

## Test Work

<!-- Describe meaningful test additions or updates and focused commands where
known, with working directories and expected evidence. Distinguish existing tests
from required additions. Include important success, failure, and regression
behavior, and identify when evidence must exercise a real entrypoint or integration
boundary. State relevant prerequisites, authorization needs, and known limitations;
an unavailable required check remains an evidence gap. Reference reusable
procedures rather than copying them. Do not prescribe tests for every code path
or automatically one test assignment per job. State when no test work is needed
and why. -->

{{Test work and expected evidence.}}
