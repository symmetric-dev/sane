# Job Spec <id>: <job name>

<!-- Replace `<id>`, `<job name>`, and every guidance comment with actual
content before delivery. Retain this H1 and every H2 exactly once and in this
order. Use the plan's exact Job ID and name: `# Job Spec NN: <job name>` for
ordinary two-digit IDs, or an inserted ID such as `07a` when listed in the plan.
A Job is the unit of work; this Job Spec documents one bounded implementation
request at `execution/jobs/<job-id>-<job-slug>.md`. It must apply approved
decisions from the root doc, `design/SDD.md`, Solution Specs, and
`execution/PLAN.md` rather than inventing material product, architectural, or
technical decisions. Planning is the sole editor, including factual
corrections. Paths here are relative to the workstream root unless identified
as implementation-repository paths. -->

## Goal

<!-- State the technical objective and resulting product capability or behavior. -->

## Context

<!-- Link only the relevant root doc, `design/SDD.md`, Solution Specs in
`design/solutions/<name>.md`, `execution/PLAN.md`, source paths, interfaces, and
predecessor outputs. Include a compact prioritized read map with verified
paths, symbols, reasons, and line evidence where available. Separate
required-start reads from conditional references with concrete triggers.
Guide inspection first; expand for concrete correctness, integration, regression,
or verification concerns without a hard read cap or exhaustive reference traversal.
Explain surrounding code and locked decisions that implementation must follow. -->

## Instructions

<!-- Give direct instructions for applying the approved design: locations,
names, interfaces, sequences, examples, and focused Solution-Spec references.
Use actionable steps grounded in inspected code. Specify integration contracts
and producer/consumer expectations, including callers, data shapes, configuration,
registrations, and tests when applicable. Do not invent missing decisions. -->

## Boundaries

<!-- Overall heuristic on what not to modify, no exact files are needed but they can be included.
Escalate a changed split, ownership boundary, or SDD/Spec update instead of silently expanding the Job. -->

## Verification

<!-- Define overall commands, working directories, prerequisites, focused tests,
expected outputs, and overall checks. Label future tests/commands as
required additions with their approved basis, never as existing verified checks.
Record limitations for unavailable or unsafe checks. -->

## Report Requirements

<!-- Define Job-specific evidence and information the execution report at
`execution/reports/<job-id>-<job-slug>.md` must include, without changing the
shared report structure. For each required claim or check, name the evidence
needed and its authoritative location: the report section for a concise result,
or the exact linked artifact/source for detailed evidence. Require essential
commands, outcomes, and limitations needed to evaluate completion, not duplicate
logs or a chronological work diary. The report keeps exactly these H2 sections:
Accomplished, Found Issues, Notes, Implementation Recommendations, in that order;
allow H3–H6 subordinate grouping within them. -->

## Resolutions

<!-- Define completion, escalation, retry/fix, and stop rules: what completes
the Job, what may be debugged, what must be raised, and when to stop. -->
