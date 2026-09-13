# Job Spec <id>: <job name>

<!-- Replace `<id>`, `<job name>`, and every guidance comment with actual
content before delivery. Retain this H1 and every H2 exactly once and in this
order. Use a two-digit local Job ID: `# Job Spec NN: <job name>`, with the
plan's exact name. A Job is the unit of work; this Job Spec documents one
bounded implementation request. It must apply approved
decisions rather than inventing material product, architectural, or technical
decisions. -->

## Goal

<!-- State the technical objective and resulting product capability or behavior. -->

## Context

<!-- Link only the relevant root and Stage Design, Section Specs, Execution Plan,
source paths, interfaces, and predecessor outputs. Include a compact prioritized
read map with verified paths, symbols, reasons, and line evidence where available.
Separate required-start reads from conditional references with concrete triggers.
Guide inspection first; expand for concrete correctness, integration, regression,
or verification concerns without a hard read cap or exhaustive reference traversal.
Distinguish current repository facts, required changes, and predecessor expected
outputs; a predecessor spec is not evidence that its code already exists.
Explain surrounding code and locked decisions that implementation must follow. -->

## Instructions

<!-- Give direct instructions for applying the approved design: locations,
names, interfaces, sequences, examples, and focused Section-Spec references.
Use actionable steps grounded in inspected code. Specify integration contracts
and producer/consumer expectations, including callers, data shapes, configuration,
registrations, and tests when applicable. Do not invent missing decisions. -->

## Boundaries

<!-- List concise allowlisted paths/files the Job may edit and denylisted
paths/files it must not edit. Distinguish verified existing paths from required
new paths traceable to approved Design or confirmed scope. Escalate a changed
split, ownership boundary, or Design instead of silently expanding the Job. -->

## Verification

<!-- Define exact commands, working directories, prerequisites, focused tests,
expected outputs, and step-by-step checks. Cite inspected scripts/configuration
or tool usage verifying each command. Distinguish definition-verified commands
from commands actually run and their outcomes. Label future tests/commands as
required additions with their approved basis, never as existing verified checks.
Record limitations for unavailable or unsafe checks; grounding need not execute
mutating checks. Mark a check as user-only when the implementation agent must not
perform it. Never invent command names, paths, flags, or passing results. -->

## Report Requirements

<!-- Define Job-specific evidence and information the Implementation Report must
include, without changing the shared Report structure. -->

## Resolutions

<!-- Define completion, escalation, retry/fix, and stop rules: what completes
the Job, what may be debugged, what must be raised, and when to stop. -->
