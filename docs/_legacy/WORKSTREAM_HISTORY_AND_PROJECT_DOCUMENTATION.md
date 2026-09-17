# Workstream History and Project Documentation

## Purpose

SANE separates the records used to govern a bounded change from the durable
documentation used to operate and evolve the implementation repository. The
separation preserves decision history without making historical workstream
documents compete with the repository's description of its current state.

This policy applies to both `feature` and `foundation` workstreams.

## Two Kinds of Canon

| Kind | Location | What it is canonical for | Expected lifetime |
| --- | --- | --- | --- |
| Workstream record | The ignored `.sane/workstreams/` directory | The intent, evidence, decisions, approvals, and delivery record for one bounded change at a particular time | Historical after delivery |
| Project documentation | The implementation repository | The current practical description of what the repository, product, service, and operating environment contain and how to use or evolve them | Continuously maintained as the repository changes |

Workstream artifacts include `PRD.md`, research documents, root and Stage Design,
State, Execution Plans, Job Specs, and Implementation Reports.
They explain what was intended, why it was chosen, what constraints applied, and
what the user approved.

For Research, topic `REPORT.md` files are the authoritative historical evidence.
The `research/workstream/BASELINE.md` file preserves non-Stage and cross-Stage
context; each `research/stage-NN/BASELINE.md` preserves its Stage context.
Cross-scope evidence applies only where the consuming baseline explicitly links
it.

Project documentation includes material such as a README, architecture overview,
developer and contributor guidance, operational runbooks, interface
documentation, product overview, and setup instructions. It explains what exists
now and how to use, operate, or extend it.

Neither kind replaces the other. A project document is not a copy of a PRD or
Design Spec, and a workstream document is not rewritten to act as the current
repository manual.

## Documentation as an Implementation Outcome

Documentation that belongs to the project may be a real target-repository
outcome of a workstream. For example, a foundation may establish an architecture
overview, project scope document, core-feature overview, setup guide, or
operational documentation that later work needs.

Such documentation must be explicitly included in the workstream's approved
outcome and acceptance evidence:

- Product identifies its intended audience, purpose, required outcome, and
  validation in `PRD.md`.
- Design identifies its relationship to the repository, ownership, destination
  paths, and high-level constraints in root or Stage Design.
- Engineering and Planning turn it into bounded Sections and Job Specs where needed.
- Implementation creates or updates the target-repository documents, verifies
  them against the implemented repository, and records the result in the
  Implementation Report.

A foundation is not documentation-only. Project documentation can be one of its
outcomes, but the foundation must also deliver the bounded real repository or
environment outcome it was established to produce.

## Role Boundaries

Product and Design supply the high-level context that makes a project-document
outcome useful. They do not directly mutate target-repository documentation.

- **Product** establishes the product or foundation outcome and user-facing
  purpose without making technical implementation decisions.
- **Research** gathers evidence in topic reports; each session has one assigned
  scope, whose coordinating assistant alone maintains its baseline.
- **Design** establishes technical direction, documentation constraints, and
  the relationship between the intended documentation and the repository.
- **Engineering, Planning (Execution phase), and Implementation** prepare and perform
  the target-repository change at the appropriate Stage and Job scopes.
  The user alone authorizes it; Job Grounder enriches one assigned Job Spec with
  repository evidence and never edits project documentation or approves work.

This keeps high-level roles authoritative over intent and design without giving
them uncontrolled implementation-repository mutation authority. An
Implementation Agent may read the approved Product and Design artifacts, the
authorized Job, current repository files, and current project documentation to
produce a practical project document. It must not merely copy a workstream
artifact into the repository.

## Historical Workstreams and Supersession

A delivered workstream is a trace of the work done and the decisions made at
that time. It is not continuously rewritten as the project evolves.

When later learning changes a feature, architecture, or product direction:

1. the user starts a new bounded workstream;
2. the new workstream identifies relevant predecessor work and whether it
   reuses, constrains, replaces, or supersedes an earlier decision;
3. the new workstream produces and approves its own Product, Research, and
   Design direction;
4. implementation changes the target repository and its current-state
   documentation; and
5. the earlier workstream remains available as historical provenance.

Do not retroactively rewrite completed workstream Design to make it describe the
present repository. The current repository documentation carries the current
description; the later workstream carries the new justification and decision
trace.

## Historical Context Transfer

Product, Research, and Design may investigate earlier workstreams to transfer
context into a new workstream. This is purposeful work about the work: it helps
the user understand prior intent, evidence, decisions, outcomes, recurring
questions, and established patterns before deciding what the new change should
do.

The user explicitly selects the historical scope: a predecessor workstream, a
set of artifacts, or a question to investigate. Agents must not automatically
ingest all prior history or infer that the latest workstream is the only relevant
one.

The roles have distinct historical responsibilities:

- **Product** investigates prior intent, stakeholder commitments, scope changes,
  and product decisions.
- **Research** investigates prior evidence, outcomes, recurring unknowns, and
  relevant implementation history, citing authoritative topic reports and the
  baseline for the assigned scope.
- **Design** investigates reusable technical patterns, architecture decisions,
  trade-offs, and decisions that the new work must preserve or supersede.

The result is a concise synthesis in the new workstream's owned artifacts. It
names the relevant predecessor artifacts and records whether their direction is
reused, constrained, or superseded. It does not edit the predecessor workstream
or make downstream roles reconstruct a full history.

## Focused Downstream Context

Engineering, Planning, and Implementation consume the distilled, approved
current-workstream artifacts plus only the implementation-repository paths and
current documentation relevant to their assigned Stage or Job. They do not
perform open-ended historical archaeology by default.

When historical material is needed downstream, Product, Research, or Design
should identify the exact predecessor artifact or the approved current-workstream
synthesis that matters. `SANE_CONTEXT.md` and Design resources can point to
those focused inputs. This preserves bounded agent context while allowing the
new workstream to benefit from history.

## Conflicts Between History, Design, and Current Reality

An Implementation Agent documents the repository as it exists after its
authorized work, not as an earlier workstream once intended it to exist. If an
approved Job or Design conflicts materially with the current repository,
project documentation, or discovered implementation constraints, the agent must
report the mismatch. It must not silently select a historical direction, change
approved Design, or publish misleading current-state documentation.

Approved Design remains implementation authority. If current Research conflicts
with it, the responsible role requests a Design Update and approval rather than
allowing a baseline or report to alter implementation direction implicitly.

The user then decides whether to clarify the current workstream, return to the
appropriate earlier role, or establish a new/superseding workstream.

## Practical Rule

Use the workstream repository to answer: **what did we decide, why, and what
was approved for this bounded change?**

Use the implementation repository to answer: **what exists now, and how do we
use, operate, or evolve it?**
