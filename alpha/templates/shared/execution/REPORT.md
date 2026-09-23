# Job <id>: <job name> Report

<!-- Replace the title placeholders, fill in applicable patterns, and remove
guidance comments before delivery. Retain the directory convention and exactly
these three H2 sections, once each and in order. H3–H6 grouping is optional.
Use the report destination supplied by `sane job <id>`.
Report the current outcome, including partial implementation, failure, or a
discovered prerequisite gap. Apply the Job's Report Requirements. Update findings
and results in place after fixes or new verification; retain history only when
it explains the current outcome. Link authoritative evidence rather than copying
logs or other reports. Adapt the number of items to the actual evidence. -->

Directory convention: resolve these prefixes using `sane job <id>`.
- `<implementation>/...` is relative to the command's **Implementation root**.
- `<workstream>/...` is relative to the command's **Workstream root**.

## Outcome

<!-- State what was achieved and what remains incomplete. A useful outcome may
be an evidenced finding rather than implemented code. Distinguish checks that
passed, failed, or were not run, and state the limits of their evidence. -->

[Current result and any incomplete part of the assignment.]

- [Implemented behavior or established finding], supported by
  [source or evidence reference].
- Verification: `[command or check]` from `[directory]` — [result, relevant
  environment details, and limitation or reason the check was not run].

## Unresolved Issues

<!-- Record unresolved defects, blockers, material deviations, and uncertainties
affecting the assignment. Include required but incomplete work here. Remove
resolved findings unless they explain a current limitation or material outcome.
If none remain, state `No unresolved issues identified within the performed work.`
That statement does not replace disclosure of verification limitations. -->

- [Current issue] — Evidence: [reference]. Effect: [requirement blocked,
  incorrect behavior, or remaining uncertainty].

## Recommendations

<!-- Include an evidence-backed next action only when useful. Name the affected
component or interface rather than assuming knowledge of the Execution Plan's job allocation.
Distinguish a proposed action from a verified remedy; reference findings above
instead of duplicating them. Required incomplete work remains in Unresolved Issues,
even when a recommendation describes how to address it. State `None` when no
recommendation is warranted. -->

- [Suggested action] for [affected component or interface], because
  [finding or evidence reference]. Applies when [relevant condition or limit].
