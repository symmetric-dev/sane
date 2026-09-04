# V2 Alpha Intent

## Purpose

This directory will hold a temporary, manual V2-alpha workflow for validating
the V2 Product, Research, Design, Execution, and Implementation model in real
projects before V2 CLI tooling is designed or implemented.

The alpha is a documentation and agent-context prototype. It is not a V2 CLI
implementation, a permanent workstream artifact model, or a replacement for the
target V2 decision records in `work/014-workstream-v2/docs/`. Its procedures and state records may
be retired once tested behavior is encoded by V2 tooling.

The Alpha operating model and per-workstream context and State templates are
defined. Role skills and the local repository-setup convention are also
defined. Detailed approval rules, agent configurations, and installation
procedures remain to be written.

Before creating a workstream for an implementation repository, follow
[SANE Alpha Repository Setup](./SANE_REPOSITORY_SETUP.md).

## What the Alpha Will Validate

The alpha will test the full V2 workflow by hand:

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
Their global OpenCode agent configurations will live under:

```text
~/.config/opencode/agents/
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
repository paths, and report contract. They do not provide general SANE context.
The alpha must not use Cursor's `--force` or `--yolo` options by default.

## Shared Context Packages

The alpha source material will first be developed in this directory. Selected
skills will then be copied to the shared location:

```text
~/.agents/skills/<skill-name>/SKILL.md
```

OpenCode auto-discovers skills from that path. Cursor does not rely on
OpenCode's skill loader; its prompts explicitly provide the relevant skill
paths for it to read.

The context packages will share the V2 document contracts rather than
duplicating them. In particular, the Execution Assistant and the Implementation
agent context packages will both reference the same installed Implementation
Report contract, sourced from
`work/014-workstream-v2/docs/IMPLEMENTATION_REPORT_DEFINITION.md`. The future alpha installation
procedure will provide that shared path without creating competing report
schemas.

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

## Existing V2 Contracts

The alpha uses the target V2 document contracts already defined in
`work/014-workstream-v2/docs/`,
including:

- Product Requirements Document;
- Research Index and Technical Brief;
- root, Stage, and Section Design Specifications;
- stage Execution Plan and Job documents; and
- stage-scoped Implementation Reports.

The alpha may reveal gaps or unsafe assumptions in those contracts. Such a
finding must be recorded and returned to the V2 decision records for an
explicit user decision; it must not silently redefine the target model.
