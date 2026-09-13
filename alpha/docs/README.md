# SANE Alpha Intent

## Purpose

This directory holds a temporary, manual Alpha workflow for validating the SANE
Product, Research, Design, Execution, and Implementation model in real projects
with small, pilot-support CLI utilities.

The Alpha is a documentation and agent-context prototype. It is not a permanent
workstream artifact model. Its procedures and state records may be retired once
tested behavior is encoded by tooling.

The Alpha operating model is defined, and `alpha/templates/` is the canonical
source of SANE templates, including per-workstream context and State templates.
Role skills, tested agent-context-package installation, and the local
repository-setup convention are also available.

The agent-context-package content, context-ingestion sequence, and required
working-directory and permission rules are defined in
[SANE Alpha Agent Context Packages](./SANE_AGENT_CONTEXT_PACKAGES.md).

Before creating a workstream for an implementation repository, follow
[SANE Alpha Repository Setup](./SANE_REPOSITORY_SETUP.md).

[Workstream Types](./WORKSTREAM_TYPES.md) describes the supported `feature` and
`foundation` types, their immutable metadata, and proposed future types.

[Workstream History and Project Documentation](./WORKSTREAM_HISTORY_AND_PROJECT_DOCUMENTATION.md)
defines the boundary between historical workstream artifacts and current
implementation-repository documentation, including historical context transfer
and supersession.

[Evaluation Initiative](./EVALUATION_INITIATIVE.md) defines Alpha's initial,
user-authorized session-evidence data collection. Analysis and evaluation of that
dataset are explicitly deferred.

## Alpha Command Installation

From the SANE checkout, install the Alpha dispatcher once:

```bash
bun alpha/scripts/install-sane-alpha.ts
```

This writes `sane-alpha` to `~/.local/bin` by default and reports the required
`PATH` export when that directory is not already on `PATH`; it does not change
shell configuration. Use `--bin-dir <path>` for another directory, `--dry-run`
to validate without mutation, and `--overwrite` to replace a differing regular
file. The wrapper imports this checkout by absolute path. If the checkout moves,
run `bun alpha/scripts/install-sane-alpha.ts --overwrite` from its new location.
See the [Pilot User Guide](./SANE_PILOT_USER_GUIDE.md) for the exposed commands
and examples, and the [Mock Workflow](./SANE_MOCK_WORKFLOW.md) for an end-to-end
illustrative pilot.

## What the Alpha Will Validate

The Alpha will test the full workflow by hand:

1. Product, Research, and Design assistants prepare their defined artifacts;
   topic Research Reports hold authoritative evidence while coordinating
   Research Baselines manifest applicable direction and conflicts. A Research
   Worker may produce one bounded topic report and supporting files, while the
   coordinating Research Assistant alone owns the baseline.
2. The Planning Assistant prepares a compact per-stage `EXECUTION_PLAN.md` from
   approved complete Stage Design. After readiness confirmation and a separate
   explicit breakdown confirmation, it drafts Job Specs and delegates each to
   Job Grounder, then reviews findings and cross-job consistency with targeted
   repository inspection. Changed splits/Design require renewed confirmation
   and, for Design, an approved Update.
3. The user reviews and approves the completed Execution Plan and Job Specs.
4. A Coordination Assistant invokes worker implementer agents for the
   authorized Jobs.
5. Each worker agent carries out one Job in the target
   repository and writes its matching Implementation Report.
6. After all authorized Jobs are completed and reviewed, the Coordination
   Assistant creates or updates the actual-state Stage Implementation Brief; the
   user reviews it with the per-Job reports and carries handoff context to later
   Design work or stages.

The initial alpha may validate one Stage first. It tracks workstream State
manually and uses sequential list order unless the approved plan explicitly
authorizes parallel Jobs. Git-worktree strategy, merge automation, retry automation, and
CLI supervision are intentionally outside this first alpha scope.

Coordination consumes `Jobs` / `Split Notes` using execution batches (one Job or
an explicitly parallel set), without new plan headings or State statuses.
Planning alone edits plans and Job Specs, including factual corrections, with
Grounder limited to its assigned spec. Coordination returns actionable corrections
through the user to Planning and waits; it never launches Grounder. See the
[operating model](./ALPHA_OPERATING_MODEL.md#alpha-execution-model).

## Agent Model

The user remains the authority for assistant selection, handoffs, approvals,
and acceptance. No alpha command selects, starts, approves, or transfers work
between agents automatically.

### OpenCode assistants

The Product, Research, Design, Engineering, Planning, and top-level
Coordination Assistants will be selected and started by the user in OpenCode.
Their global OpenCode agent configurations are installed with:

```bash
sane-alpha install-context-packages [--dry-run] [--overwrite] [--model-config <path>]
```

The command installs them under:

```text
<home>/.config/opencode/agents/
```

The top-level Coordination Assistant coordinates an authorized Job's
invocation; it is distinct from the worker implementer agent that performs
the repository work.

### Implementation subagents

Worker implementer, reviewer, and fixer agents receive narrow OpenCode subagent
configurations. The top-level Coordination Assistant invokes one implementer
for one authorized Job, one read-only reviewer per completed execution batch, and
one fixer for an authorized Narrow Fix or Bounded Remediation. Delegated review/fix
cycles require user-approved scope and attempt limits; only the user accepts work.

The focused worker, review, and fix prompts identify only their assigned
documents, repository paths, requirements, and boundaries. They do not provide
general SANE context.

Dispatch readiness consumes grounded specs and actual predecessor evidence,
without duplicate grounding. Implementers begin with required-start read maps
and follow conditional references or expand for concrete concerns without hard
read caps. Reviewers receive relevant Section Specs, Job Specs, and bounded
repository/review/output instructions, independently inspect code and evidence,
and read reports only as necessary to verify accuracy. No mandatory report
template, Execution Plan, or exhaustive reference list is required for review.
Stage handoff is based on Stage/Job Specs and actual reports/reviews.

### Job Grounder

Planning invokes `sane-worker-grounder` after explicit breakdown confirmation.
It investigates bounded repository context and writes only one assigned Job Spec,
using Scout's evidence discipline. Its guidance includes a compact prioritized
read map with symbols/reasons, actionable steps, integration contracts, and exact
verified command definitions, separating current facts, required changes,
predecessor expected outputs, and actual command outcomes. It returns findings,
gaps, and limitations to Planning; it makes no application, Design, plan, or
State edits and has no user conversation, approval, or subdelegation authority.

### Scout and Research Workers

Both workers are subagents, not user-started role sessions. After the user
normally confirms Engineering Assistance, Engineering may use Scout for one
bounded internal implementation-repository inspection. Scout is read-only,
cannot use the web, and returns a concise inline handoff with path-and-line
evidence without writing a Research Report. Engineering may supply exact
artifacts from the separate workstream repository as read-only context; Scout
cannot discover wider external context or mutate either repository.

A coordinating Research Assistant may launch Researcher for one bounded
external-evidence topic. Engineering may launch Researcher only after an
explicit user request for bounded external research during Engineering's normal,
otherwise unchanged lifecycle. Users may still start the Research Assistant
directly. Research Assistant performs direct repository audits itself and cannot
launch Scout. Engineering remains responsible for synthesis and decisions with
the user.

Researcher reads the applicable baseline and receives one exact, self-contained
prompt with its topic, inputs, allowed report/supporting-file destinations,
constraints, verification, and concise return shape. It has no user Pickup,
Delivery, approval, or question loop and never edits the baseline. Exact local
context needed to interpret the external question may be inspected read-only,
but general internal repository discovery belongs to Scout. Implementation
writes, installs, migrations, and deployments are prohibited. Live credentials
or external-system calls require an exact explicit assignment. This is a behavioral
boundary, not an overstatement of dynamic path permission enforcement.

## Shared Context Packages

The Alpha source material is maintained in this directory. `alpha/templates/` is
the canonical source of SANE templates: reusable templates are under
`alpha/templates/shared/`, feature roots under `alpha/templates/feature/`, and
foundation roots under `alpha/templates/foundation/`. The context-package
installer copies six assistant role skills to the shared location:

```text
<home>/.agents/skills/<skill-name>/SKILL.md
```

OpenCode auto-discovers skills from that path. Here `<home>` is `SANE_HOME` when it is set, otherwise the
current user's home directory.

The installer manages exactly eighteen destinations: twelve OpenCode agent
configurations and six assistant skills. Restart OpenCode after installation or an
overwrite so it loads them. No role agent requires a type declaration or reads root `type`
metadata as session context. Type remains an input to CLI creation: it creates
`PRD.md` and selects the matching root Design resource template,
which the generic Product and Design skills handle directly. The
installer leaves identical files unchanged, requires `--overwrite` for differing
regular files, and supports a non-mutating `--dry-run`. Reinstalling does not
delete previously installed typed skill directories; cleanup is explicit and
user-directed.

For the Execution-to-Planning source rename, obsolete installed paths, manual
cleanup, and model-key migration, see
[Planning migration](./SANE_AGENT_CONTEXT_PACKAGES.md#planning-migration).

## Manual Approval and State

The Alpha uses workstream documentation and role skills, not CLI approval
commands. `SANE_CONTEXT.md` establishes the user's exclusive authority over
session starts, approvals, redirects, and stops. Each role skill defines its
Pickup, Delivery, approval boundary, and State-update procedure.

`SANE_STATE.md` records the current approval, active, blocked, cancelled, and
accepted-outcome status. No agent may treat an artifact as approved merely
because it exists or because the user is silent. On explicit user approval, the
role that owns the relevant entry updates only that entry and only when the user
requests the State update.

## Canonical Templates

`alpha/templates/` is the canonical source of SANE templates, including:

- Product Requirements Document;
- Foundation Workstream Definition;
- authoritative topic Research Reports plus scope-specific Research Baselines;
- root, Stage, and Section Design Specifications;
- stage Execution Plan and Job Specs (documents specifying bounded Jobs); and
- stage-scoped Implementation Reports and Stage Implementation Briefs.

The Alpha may reveal gaps or unsafe assumptions in these templates. Record such
findings for an explicit user decision; do not silently redefine the model.

## Research Baseline Model

`research/workstream/BASELINE.md` coordinates non-Stage and cross-Stage
Research. `research/stage-NN/BASELINE.md` coordinates Research for one Stage.
Topic reports live below the assigned scope. A Research session has exactly one
assigned scope; only its coordinator updates that baseline, while delegated
researchers write reports. Evidence from another scope applies only when the
consuming baseline explicitly links it.

Root Design reads the workstream baseline, and Stage Design reads its assigned
Stage baseline. Research-consuming roles capture that baseline's revision at
Pickup and recheck it at Delivery. Approved Design remains implementation
authority: a material Research conflict requires a Design Update and approval.
Alpha has one shared baseline template for both scope types.
