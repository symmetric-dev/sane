# Foundation Design Spec

<!-- Replace every guidance comment with workstream-specific content before
delivery. Retain this H1 and every H2 exactly once and in this order. Add
subheadings only under these H2 sections. This is the root Design artifact for a
foundation workstream. It turns the approved Foundation Workstream Definition
and research evidence into durable technical direction and ordered Stage
strategy. It does not define Section-level implementation designs, Jobs, Job
Groups, agent assignments, live State, or execution scheduling. -->

## Objective and Scope

<!-- Relate the approved foundation outcomes to the included Design work,
boundaries, and explicit non-goals. Identify the repository and supported
environments that this Design governs. -->

## Inputs, Starting State, and Reuse Constraints

<!-- Identify the Foundation Workstream Definition, relevant research, current
repository condition, existing assets, interfaces, infrastructure, and patterns.
State what must be preserved, reused, migrated, isolated, retired, or replaced;
do not yet prescribe Section-level implementation steps. -->

## Architecture and Repository Topology

<!-- Define the high-level system shape: workspace or monorepo topology,
applications, packages, services, modules, ownership boundaries, and dependency
direction. Explain how the shape supports the approved foundation outcome. -->

## Platform, Configuration, and Delivery Design

<!-- Define the high-level approach to infrastructure-as-code, environments,
configuration contracts, dependency strategy, development servers, quality
gates, CI, and delivery. Do not include secret values, exact commands, or
implementation-ready configuration. -->

## Data, Integration, and Security Design

<!-- Define relevant durable data, API, external-service, identity, security, or
compliance boundaries and constraints. State integration assumptions and where
verification is required. -->

## Foundation Decisions and Deferred Work

<!-- Record every durable decision in this root Design using an H3 entry:

### FD-<number>: <concise decision title>

- **Context:** The decision question, constraint, or relevant starting state.
- **Decision:** The selected direction and its boundary.
- **Alternatives considered:** Material alternatives and why they were not
  selected.
- **Consequences:** Expected trade-offs, limitations, and obligations.
- **Evidence:** Relevant research, references, experiments, or Design context.
- **Follow-up:** Deferred work and conditions that require reconsideration.

Also identify intentionally deferred architecture and capabilities. Root Design
approval governs the decisions included in its delivered revision; no decision
has an independent approval path. -->

## Stage Strategy and Ordering

<!-- Explain the dependency-aware sequence of foundation Stages and the outcome
or decision each Stage enables. The separate Stage list and Stage Specs carry
the concrete Stage identities and technical decisions. Do not define Sections,
Jobs, or Job Groups here. -->

## Verification and User Validation

<!-- Define the high-level evidence required to show the foundation is usable:
automated checks, runnable development services, infrastructure or integration
evidence, and any user-run validation. User validation is evidence for review,
not automatic approval. -->

## Resources

<!-- List focused repository paths, research, architecture references, provider
documentation, standards, and other material needed to understand this Design. -->

## Closing Comments

<!-- Add optional non-critical continuity notes, or state `No closing comments`.
Do not place an unresolved material technical decision here. -->
