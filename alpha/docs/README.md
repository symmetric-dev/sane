# SANE Alpha Intent

## Purpose

This directory holds a temporary, manual Alpha workflow for validating the SANE
Product, Research, Design, Execution, and Implementation model in real projects
before CLI tooling is designed or implemented.

The Alpha is a documentation and agent-context prototype. It is not a CLI
implementation or a permanent workstream artifact model. Its procedures and
state records may be retired once tested behavior is encoded by tooling.

The Alpha operating model is defined, and `alpha/templates/` is the canonical
source of SANE templates, including per-workstream context and State templates.
Role skills, tested agent-context-package installation, and the local
repository-setup convention are also available. Detailed approval rules and the
remaining README cleanup remain to be written.

The planned agent-context-package content, context-ingestion sequence, required
working-directory and permission rules, and deferred Delivery-skill option are
defined in [SANE Alpha Agent Context Packages](./SANE_AGENT_CONTEXT_PACKAGES.md).

Before creating a workstream for an implementation repository, follow
[SANE Alpha Repository Setup](./SANE_REPOSITORY_SETUP.md).

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
bun alpha/scripts/install-sane-agent-context-packages.ts [--dry-run] [--overwrite]
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
the canonical source of SANE templates. The context-package installer copies the
six role skills to the shared location:

```text
<home>/.agents/skills/<skill-name>/SKILL.md
```

OpenCode auto-discovers skills from that path. Cursor does not rely on
OpenCode's skill loader; its prompts explicitly provide the relevant skill
paths for it to read. Here `<home>` is `SANE_HOME` when it is set, otherwise the
current user's home directory.

The installer copies exactly twelve files: six OpenCode agent configurations and
six role skills. It leaves identical files unchanged, requires `--overwrite` for
differing regular files, and supports a non-mutating `--dry-run`.

## Manual Approval and State

The alpha will use documentation, not CLI state or `work approve` commands.
Future alpha documents will define:

- `ALPHA_APPROVAL_RULES.md` for manual equivalents of Product review, Research,
  root and Stage Design, Stage Execution, and eventual Implementation acceptance
  gates; and
- `ALPHA_STATE.md` for temporary approval, revocation, active-Job, and outcome
  tracking inside an alpha workstream.

Assistants must ask the user for explicit verbal or written permission at each
applicable boundary. The user or a user-authorized assistant records approvals
and revocations in the alpha state record. No agent may treat a document as
approved merely because it exists.

## Canonical Templates

`alpha/templates/` is the canonical source of SANE templates, including:

- Product Requirements Document;
- Research Index and Technical Brief;
- root, Stage, and Section Design Specifications;
- stage Execution Plan and Job documents; and
- stage-scoped Implementation Reports.

The Alpha may reveal gaps or unsafe assumptions in these templates. Record such
findings for an explicit user decision; do not silently redefine the model.
