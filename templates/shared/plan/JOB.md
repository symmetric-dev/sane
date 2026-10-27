# Job Spec {{id}}: {{job name}}

<!-- Authoring guidance: replace every {{...}} slot with authored content and remove guidance comments
before delivery. Retain the directory convention below and every H2 once, in
order. Use the Execution Plan's exact Job ID and name, including inserted IDs such as 07a.
Write a complete assignment for a fresh worker with no planning conversation
or sibling jobs. Translate approved decisions into starting conditions,
requirements, interfaces, and boundaries; keep scheduling and cross-job
coordination in the Execution Plan. Adapt the pattern items to the assignment; their count
does not prescribe the number of requirements or checks.-->

Directory convention:
- `<implementation>/...` is relative to the **Implementation root**.
- `<workstream>/...` is relative to the **Workstream root**.

## Goal and Scope

<!-- State the technical objective and resulting product capability or behavior
in a short paragraph. Include the concrete scope limits, adjacent interfaces to
preserve, and explicit exclusions rather than repeating them in Instructions. -->

{{Technical outcome and the behavior or capability it enables.}}

- Preserve {{adjacent interface, behavior, or data invariant}}.
- {{Related capability or change}} is outside this assignment.

## Context

<!-- State relevant starting conditions and locked decisions directly. List
verified inputs with a reading purpose and useful section or symbol anchors.
Include only references needed for this assignment; add optional or conditional
references when they have a concrete purpose. Omit unused reading groups. -->

{{Relevant existing behavior, expected starting state, and approved decisions needed to understand this assignment.}}

Read:
- `<implementation>/`{{source path}}, {{symbol}} — {{What to inspect and how it informs the implementation.}}
- `<workstream>/design/solutions/`{{spec}}.md, “{{section}}” — {{Specific contract or decision to apply.}}

Conditional reference:
- `<implementation>/`{{related path}} — Read if {{concrete trigger}}; establish {{fact needed to resolve it}}.

## Operational Readiness

<!-- Before implementation, name only the job-specific operational prerequisites:
applicable repository skills or procedures, safe non-test preflight checks,
required starting state, and when to stop with evidence for Execution. Reference
reusable procedures instead of copying them. When a skill provides a script for
the operation, name the script with the skill. Do not assume that a skill proves
the current environment state or authorizes a mutation. If no additional
preflight is needed, state that explicitly. Keep tests and Verification Spec
references out of this Job Spec. -->

- Consult `<implementation>/.agents/skills/`{{name}}`/SKILL.md` for {{applicable operation}}; confirm {{required starting state}} using {{safe, non-test evidence}}.
- If {{specific prerequisite is missing or an operational decision is required}}, stop before implementation and report {{observed state and decision needed}} to Execution.

## Instructions

<!-- Use numbered, actionable instructions grounded in inspected code. State
locations, contracts, and expected behavior; make genuine ordering constraints
explicit. Include meaningful job-specific non-test checks alongside the relevant
work, with working directories and expected outcomes. Do not repeat general
checking rules or checkpoint test work. Resolve missing design decisions before
assigning implementation. Put operational stop conditions in Operational
Readiness and other assignment-specific decision boundaries with the affected
instruction; do not restate the goal as a completion checklist. -->

1. {{Action}} in `<implementation>/`{{path}} to produce {{required behavior}}, using {{specified interface or data contract}}.
2. {{Related action or integration}} so that {{caller/consumer}} receives {{expected result, including relevant failure behavior}}.

## Report Requirements

<!-- List only assignment-specific evidence beyond the standard Job Report.
Reference checks from Instructions rather than repeating their commands, and
link authoritative sources rather than duplicating logs. The report destination
and template are supplied with the job assignment. State `None` when no additional
evidence is needed. -->

- {{Assignment-specific result to report}}, linking {{authoritative source or artifact}} for detailed evidence.
- {{Additional evidence needed to evaluate this outcome, referencing the relevant instruction or authoritative artifact.}}
- If {{relevant issue is encountered}}, record {{finding and evidence needed for follow-up}}.
