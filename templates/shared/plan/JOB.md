# Job Spec {{id}}: {{job name}}

<!-- Authoring guidance: replace every {{...}} slot with authored content and remove guidance comments
before delivery. Retain the directory convention below and every H2 once, in
order. Use the Execution Plan's exact Job ID and name, including inserted IDs such as 07a.
Write a complete assignment for a fresh worker with no planning conversation
or sibling jobs. Translate approved decisions into starting conditions,
requirements, interfaces, and boundaries; keep scheduling and cross-job
coordination in the Execution Plan. Adapt the pattern items to the assignment; their count
does not prescribe the number of requirements or checks.-->

Directory convention: resolve these prefixes using `sane job <id>`.
- `<implementation>/...` is relative to the command's **Implementation root**.
- `<workstream>/...` is relative to the command's **Workstream root**.

## Goal

<!-- State the technical objective and resulting product capability or behavior
in a short paragraph. -->

{{Technical outcome and the behavior or capability it enables.}}

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

## Instructions

<!-- Use numbered, actionable instructions grounded in inspected code. State
locations, contracts, and expected behavior; make genuine ordering constraints
explicit. Resolve missing design decisions before assigning implementation. -->

1. {{Action}} in `<implementation>/`{{path}} to produce {{required behavior}}, using {{specified interface or data contract}}.
2. {{Related action or integration}} so that {{caller/consumer}} receives {{expected result, including relevant failure behavior}}.

## Boundaries

<!-- Use bullets for concrete scope limits and adjacent interfaces to preserve.
Describe the boundary itself rather than naming the job that owns other work. -->

- Preserve {{adjacent interface, behavior, or data invariant}}.
- {{Related capability or change}} is outside this assignment.

## Verification

<!-- List non-test checks available to the Implementer, such as typechecking,
static analysis, or a build, with working directories and expected outcomes.
Keep test work in the Verification Spec, not in this Job Spec. -->

- From `<implementation>/`{{directory}}, run {{non-test command}}. Expect {{observable result}}.

## Report Requirements

<!-- List only evidence specific to evaluating this assignment's outcome.
Reference authoritative source or artifacts for detail rather than duplicating
logs. The report destination and template are supplied by `sane job <id>`. -->

- {{Assignment-specific result to report}}, linking {{authoritative source or artifact}} for detailed evidence.
- {{Verification evidence needed to evaluate this outcome, including relevant command results or environment identity.}}
- If {{relevant issue is encountered}}, record {{finding and evidence needed for follow-up}}.

## Resolutions

<!-- State completion conditions and assignment-specific reasons to stop or
raise a decision. -->

- Complete when {{required outcome and verification conditions are satisfied}}.
- If {{specific prerequisite gap or decision boundary arises}}, return {{evidence and decision needed to proceed}}.
