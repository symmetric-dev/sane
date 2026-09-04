# SANE Alpha Pilot Readiness

## Current Readiness

The Alpha can initialize its local repository pairing, safely bootstrap and
select a workstream, provision approved role-start artifacts, and run Product,
Research, Design, Engineering, Execution, and Implementation sessions. It is
not yet ready for an end-to-end pilot.

Available now:

- initial-workstream bootstrap command;
- tested SANE repository-initialization command;
- tested repository-aware workstream creation and current-workstream selection;
- tested role-artifact provisioner for Research, Design, Stage Design,
  Engineering, and Execution;
- shared SANE context and State template;
- documented Implementation Stage and Job State entries;
- documented local repository and workstream-repository convention;
- Product, Research, Design, Engineering, Execution, and Implementation role
  skills;
- tested Alpha agent-context-package installer for all six OpenCode agent
  configurations, all six role skills, and the shared Implementation Report
  contract. Run
  `bun alpha/scripts/install-sane-agent-context-packages.ts [--dry-run] [--overwrite]`;
  it installs agents under `<home>/.config/opencode/agents/`, skills under
  `<home>/.agents/skills/`, and the contract at
  `<home>/.agents/sane/contracts/IMPLEMENTATION_REPORT_DEFINITION.md`.
  `--dry-run` validates and reports without mutation, while `--overwrite`
  replaces only differing regular files;
- focused implementation-agent and read-only review-agent prompt instructions;
- Implementation Agent Cursor invocation through the recorded implementation
  repository as the Bash working directory, with a timeout of at least 40
  minutes:

  ```bash
  agent -p "<job prompt>"
  ```

  and
- templates for all current Product, Research, Design, Execution, and
  Implementation documents.

## Required Before an End-to-End Pilot

### Approval Rules and Documentation Cleanup

Create `ALPHA_APPROVAL_RULES.md` for user approvals, revocations, Updates, and
implementation-outcome handling. Also update the stale `ALPHA_STATE.md`
reference in `README.md` to `SANE_STATE.md`.

## Not Blocking the First Pilot

- the `sane-alpha` alias installer;
- automated retry, worktree, merge, or supervision workflows.

## Key References

- [Alpha operating model](./ALPHA_OPERATING_MODEL.md)
- [Agent context packages](./SANE_AGENT_CONTEXT_PACKAGES.md)
- [Bootstrap plan](./SANE_WORKSTREAM_BOOTSTRAP_PLAN.md)
- [Bootstrap script](./scripts/create-sane-workstream.ts)
- [Repository initializer](./scripts/init-sane-repository.ts)
- [Repository-aware workstream creator](./scripts/create-sane-repository-workstream.ts)
- [Workstream selector](./scripts/select-sane-workstream.ts)
- [Role artifact provisioner](./scripts/provision-sane-role.ts)
- [Agent-context-package installer](./scripts/install-sane-agent-context-packages.ts)
- [Template catalog](./templates/README.md)
- [Shared context template](./templates/SANE_CONTEXT.md)
- [Initial State template](./templates/SANE_STATE.md)
- [V2 Workstream structure](../work/014-workstream-v2/docs/PLAN_STRUCTURE.md)
- [V2 assistant boundaries](../work/014-workstream-v2/docs/WORKSTREAM_ASSISTANTS.md)
- [Implementation Report contract](../work/014-workstream-v2/docs/IMPLEMENTATION_REPORT_DEFINITION.md)
