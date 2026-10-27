# Job {{id}}: {{job name}} Report

<!-- Replace every {{...}} slot with authored content and remove
guidance comments before delivery. Retain the directory convention and the H2s
Outcome, Unresolved Issues, and Recommendations once each and in order. Include
Operational Findings between Unresolved Issues and Recommendations only when
there are material operational findings; otherwise omit that section entirely.
H3–H6 grouping is optional.
Use the report destination supplied with the job assignment.
Report the current outcome, including partial implementation, failure, or a
discovered prerequisite gap. Apply the Job's Report Requirements. Update findings
and results in place after fixes or new verification; retain history only when
it explains the current outcome. Link authoritative evidence rather than copying
logs or other reports. Adapt the number of items to the actual evidence. -->

Directory convention:
- `<implementation>/...` is relative to the **Implementation root**.
- `<workstream>/...` is relative to the **Workstream root**.

## Outcome

<!-- State what was achieved and what remains incomplete. A useful outcome may
be an evidenced finding rather than implemented code. Distinguish checks that
passed, failed, or were not run, and state the limits of their evidence. Reference
operational findings when they affect the outcome rather than repeating them. -->

{{Current result and any incomplete part of the assignment.}}

- {{Implemented behavior or established finding}}, supported by {{source or evidence reference}}.
- Verification: {{command or check}} from {{directory}} — {{result, relevant environment details, and limitation or reason the check was not run}}.

## Unresolved Issues

<!-- Record unresolved implementation defects, missing behavior, material
deviations, and uncertainties, with required next actions. Include required but
incomplete implementation work here. Record operational problems in Operational
Findings instead. Remove resolved findings unless they explain a current
limitation or material outcome.
If none remain, state `No unresolved implementation issues identified within the performed work.`
That statement does not replace disclosure of verification limitations. -->

- {{Current issue}} — Evidence: {{reference}}. Effect: {{requirement blocked, incorrect behavior, or remaining uncertainty}}. Required action: {{correction or decision needed}}.

## Operational Findings

<!-- Optional: omit this heading and its contents when there are no material
process, tooling, setup, or documentation problems. When one occurred, disclosure
is required if a workaround affected correctness, evidence quality,
reproducibility, or safe continuation. Record the expected approach, observed
failure, workaround (if any), evidence and outcome impact, and required action.
State whether it must be resolved before continuing; a successful workaround is
not proof that the documented procedure is reliable or authorization to adopt it.
Do not duplicate the finding in Unresolved Issues or Recommendations. -->

- {{Operational problem}} — Expected: {{documented approach}}. Observed: {{failure and evidence}}. Workaround: {{alternative or none}}. Impact: {{evidence or continuation limitation}}. Required action: {{correction or decision, and whether needed before continuing}}.

## Recommendations

<!-- Include an evidence-backed optional improvement or guidance only when
useful. Name the affected component or interface rather than assuming knowledge
of the Execution Plan's job allocation. Distinguish a proposed action from a
verified remedy; reference findings above instead of duplicating them. Required
corrections belong with their findings, not here. State `None` when no
recommendation is warranted. -->

- {{Suggested action}} for {{affected component or interface}}, because {{finding or evidence reference}}. Applies when {{relevant condition or limit}}.
