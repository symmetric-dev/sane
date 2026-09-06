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

1. Product, Research, and Design assistants prepare their defined artifacts.
2. The Execution Assistant prepares a per-stage `EXECUTION_PLAN.md` and Job
   documents from an approved complete Stage Design specification.
3. The user reviews and authorizes the stage Execution plan manually.
4. An Implementation Assistant invokes Cursor implementation agents for the
   authorized Jobs.
5. Each Cursor implementation agent carries out one Job in the target
   repository and writes its matching Implementation Report.
6. The user reviews reports and carries handoff context to later agents or
   stages.

The initial alpha may validate one Stage first. It tracks workstream State
manually and permits parallel implementation only when an Execution-defined Job
Group allows it. Git-worktree strategy, merge automation, retry automation, and
CLI supervision are intentionally outside this first alpha scope.

## Agent Model

The user remains the authority for assistant selection, handoffs, approvals,
and acceptance. No alpha command selects, starts, approves, or transfers work
between agents automatically.

### OpenCode assistants

The Product, Research, Design, Engineering, Execution, and top-level
Implementation Assistants will be selected and started by the user in OpenCode.
Their global OpenCode agent configurations are installed with:

```bash
sane-alpha install-context-packages [--dry-run] [--overwrite]
```

The command installs them under:

```text
<home>/.config/opencode/agents/
```

The top-level Implementation Assistant coordinates an authorized Job's Cursor
invocation; it is distinct from the Cursor implementation agent that performs
the repository work.

### Cursor implementation agents

Cursor implementation agents do not receive special OpenCode agent
configurations. The top-level Implementation Assistant invokes one agent for
one authorized Job through Cursor's CLI with the target repository as the Bash
working directory and a timeout of at least 40 minutes:

```bash
agent -p "<job prompt>"
```

The focused Job and review prompts identify only their assigned documents,
repository paths, and report requirements. They do not provide general SANE
context.
The alpha must not use Cursor's `--force` or `--yolo` options by default.

## Shared Context Packages

The Alpha source material is maintained in this directory. `alpha/templates/` is
the canonical source of SANE templates: reusable templates are under
`alpha/templates/shared/`, feature roots under `alpha/templates/feature/`, and
foundation roots under `alpha/templates/foundation/`. The context-package
installer copies the four shared role skills plus four typed Product and Design
skills to the shared location:

```text
<home>/.agents/skills/<skill-name>/SKILL.md
```

OpenCode auto-discovers skills from that path. Cursor does not rely on
OpenCode's skill loader; its prompts explicitly provide the relevant skill
paths for it to read. Here `<home>` is `SANE_HOME` when it is set, otherwise the
current user's home directory.

The installer copies exactly fourteen files: six OpenCode agent configurations
and eight role skills. Product and Design select a Feature or Foundation skill
from the type explicitly declared by the user; the other roles use shared skills.
It leaves identical files unchanged, requires `--overwrite` for differing regular
files, and supports a non-mutating `--dry-run`.

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
- Research Index and Technical Brief;
- root, Stage, and Section Design Specifications;
- stage Execution Plan and Job documents; and
- stage-scoped Implementation Reports.

The Alpha may reveal gaps or unsafe assumptions in these templates. Record such
findings for an explicit user decision; do not silently redefine the model.
