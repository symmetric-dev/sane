# SANE Alpha Workstream Types

## Purpose

Workstream types are a shared way to describe the intended outcome and scope of
a SANE workstream. They help the user select an appropriate starting point,
evidence, and Stage sequence; they do not alter the user's authority over
sessions, approvals, redirects, or stops.

A workstream is a bounded, evidence-producing effort. It must not try to own an
entire project or become the project's all-encompassing context system. Its
scope ends when it has delivered the approved outcomes that make the next
reasonable effort possible.

Workstreams are not exploratory or documentation-only constructs. Their
documentation governs, records, and hands off the work, but every workstream
must create an approved outcome. When the outcome calls for repository or
operational change, the implementation repository and its supported environment
are transformed as part of the work; documentation is not a substitute for that
result.

## Type Metadata and CLI Behavior

Alpha supports exactly two types: `feature` and `foundation`. The user chooses
the type when creating a workstream:

```bash
sane-alpha create-workstream <implementation-repository> <workstream-relative-path> --type <feature|foundation> [--dry-run]
```

`--type` is required. Creation writes the selected immutable type as the exact
one-line plain-text root file `<workstream>/type`; it also selects the new
workstream. `.sane/current-workstream` stores only the selected path normalized
relative to `.sane/workstreams`, followed by a newline, never a type.

`sane-alpha select-workstream` takes no type argument. It accepts only a
bootstrapped workstream with a valid root `type` file. Missing, malformed, or
unsupported type metadata is rejected. Legacy or untyped workstreams are not
supported.

The CLI does not enforce eligibility, dependencies, or relationships between
workstreams. The user retains authority over scope, sequencing, approvals,
redirects, and stops. A type cannot be changed after creation; if it was chosen
incorrectly, the user creates a new workstream and decides how to record the
prior one.

## Type Boundaries for Templates and Agents

Type controls CLI creation and the root Design template copied into `resources/`.
Every workstream
receives `PRD.md`; feature and foundation each receive their matching root Design
template. The six role skills are generic: role-agent admission and skill loading
do not require a user type declaration and do not use root `type` metadata as
session context.

## Feature

A **feature** workstream develops a coherent product outcome within an
established project. It is deliberately focused on non-foundation product work:
it extends or changes a project that already has the foundation needed for that
work.

A feature workstream must not start a project. Starting a project means creating
or establishing an almost-empty implementation repository and its initial
technical foundation. That work belongs to a `foundation` workstream, even when
the foundation delivers a small first useful slice. After the foundation has
established the required decisions and enabling outcomes, later feature
workstreams use the ordinary SANE phases and approved Stages to develop product
capabilities.

## Foundation

A **foundation** workstream is a bounded project-starting effort that establishes
the decisions and enabling outcomes needed for a project to proceed safely. It
is required when creating or establishing an almost-empty implementation
repository, and is also useful when an existing project needs a deliberate
architectural reset.

Its Product-phase root artifact is `PRD.md`, using the foundation-specific
canonical template at `alpha/templates/foundation/PRD.md`. Its root Design
artifact is `design/SPEC.md`, copied from
`alpha/templates/foundation/design/SPEC.md`; this is the sole durable-decision
record. Alpha does not use
`FOUNDATION_DECISIONS.md`.

Its intended outcomes may include:

- product direction, constraints, and a long-term design horizon;
- architectural principles, boundaries, and explicitly deferred decisions;
- an actual repository foundation: workspace or monorepo configuration,
  packages, application modules, services, and infrastructure-as-code as the
  approved scope requires;
- selected dependencies and their rationale;
- installed initial dependencies, repository conventions, development servers,
  quality gates, and delivery approach;
- durable data, API, integration, security, and external-service configuration
  decisions, with safe implementation and verification where required; and
- a small working vertical slice or other implementation proof: placeholder UI,
  endpoints, data, and integrations are appropriate when they verify the
  foundation without attempting to deliver every future capability.

Foundation is real implementation work. Its authorized Implementation Jobs may
create and configure the workspace, packages, modules, services, infrastructure,
dependencies, and development servers in the implementation repository. Agents
run the verification defined by their Jobs; the user may also test the running
foundation as part of reviewing and approving the Stage outcome.

Foundation does not mean implementing every architectural element, anticipated
feature, deployment target, or future integration. It records the decisions and
evidence needed to guide those future efforts while delivering the approved
physical foundation, and clearly identifies what is not being implemented yet.

Stages are the appropriate way to sequence a foundation workstream. A Stage is
an ordered checkpoint whose outcome informs the next technical decision or
requires user approval. For example, a foundation workstream may have a
repository-configuration Stage before a database-schema Stage, followed by a
bounded integration or proof-of-concept Stage. The actual sequence must follow
the approved root and Stage Designs rather than a fixed type-specific recipe.

The resulting approved designs, research, execution records, and implementation
reports are useful evidence of how the project began. Later workstreams may use
them as references when making compatible decisions. Reusable lessons may inform
future templates or project-type frameworks, but must be deliberately extracted
and approved; a foundation workstream does not automatically prescribe future
work.

Both supported types use the same Research model: authoritative topic reports
and one baseline for each independently assigned workstream or Stage scope. Type
does not change baseline ownership or authority. Only the coordinator of an
assigned scope updates its baseline; approved Design remains implementation
authority until the user approves a required Design Update.

## Proposed Future Types

The following types are useful candidates for later Alpha definition. They do
not yet have distinct templates, approval paths, or tooling behavior.

### Maintenance

Routine upkeep such as dependency upgrades, compatibility work, configuration
changes, or technical-debt reduction. A future definition should cover affected
versions, compatibility risk, migrations, security advisories, and release or
changelog requirements.

### Defect

A bounded correction to unintended behavior. A future definition should require
expected versus actual behavior, reproduction evidence, affected environments
or versions, a narrow approved fix boundary, and regression verification.

### Incident

An urgent operational problem requiring containment and recovery. A future
definition should address severity and impact, immediate containment, rollback,
monitoring, and post-incident follow-up, while preserving explicit user
authorization for every work boundary.

## Applying a Type

1. The user chooses the type and the bounded outcome when starting the
   workstream.
2. Product, Research, and Design make the scope, assumptions, deferred work,
   and evidence appropriate to that outcome explicit.
3. The root Design divides only the required work into Stages whose outcomes
   support later decisions or approval milestones.
4. Later workstreams refer to the recorded evidence, then establish their own
   bounded scope and approvals.
