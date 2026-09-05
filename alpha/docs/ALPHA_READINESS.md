# SANE Alpha Pilot Readiness

## Current Readiness

The Alpha can initialize its local repository pairing, safely bootstrap and
select a workstream, provision approved role-start artifacts, and run Product,
Research, Design, Engineering, Execution, and Implementation sessions. It is
ready to begin its first manual end-to-end pilot.

Available now:

- initial-workstream bootstrap command;
- tested SANE repository-initialization command;
- tested repository-aware workstream creation and current-workstream selection;
- tested role-artifact provisioner for Research, Design, Stage Design,
  Engineering, and Execution;
- shared SANE context and State template;
- documented Implementation Stage and Job State entries;
- documented local repository and workstream-repository convention;
- tested `sane-alpha` command-wrapper installer and repository-aware utilities;
- Product, Research, Design, Engineering, Execution, and Implementation role
  skills;
- tested Alpha agent-context-package installer for all six OpenCode agent
  configurations and all six role skills. Run
  `sane-alpha install-sane-agent-context-packages [--dry-run] [--overwrite]`;
  it installs agents under `<home>/.config/opencode/agents/`, skills under
  `<home>/.agents/skills/`. `--dry-run` validates and reports without mutation,
  while `--overwrite` replaces only differing regular files;
- focused implementation-agent and read-only review-agent prompt instructions;
- Implementation Agent Cursor invocation through the recorded implementation
  repository as the Bash working directory, with a timeout of at least 40
  minutes:

  ```bash
  agent -p "<job prompt>"
  ```

  and
- workstream-local templates for all current Product, Research, Design,
  Engineering Section, Execution Job, and Implementation Report documents.

## Next Validation

Start a new workstream and follow the
[Mock Workflow](./SANE_MOCK_WORKFLOW.md) through one bounded Stage and Job
Group. No prior local provisioning constitutes a pilot; record any discovered
gaps for an explicit user decision.

## Not Blocking the First Pilot

- automated retry, worktree, merge, or supervision workflows.

## Key References

- [Alpha operating model](./ALPHA_OPERATING_MODEL.md)
- [Pilot user guide](./SANE_PILOT_USER_GUIDE.md)
- [Mock workflow](./SANE_MOCK_WORKFLOW.md)
- [Agent context packages](./SANE_AGENT_CONTEXT_PACKAGES.md)
- [Bootstrap plan](./SANE_WORKSTREAM_BOOTSTRAP_PLAN.md)
- [Bootstrap script](../scripts/create-sane-workstream.ts)
- [Repository initializer](../scripts/init-sane-repository.ts)
- [Repository-aware workstream creator](../scripts/create-sane-repository-workstream.ts)
- [Workstream selector](../scripts/select-sane-workstream.ts)
- [Role artifact provisioner](../scripts/provision-sane-role.ts)
- [Agent-context-package installer](../scripts/install-sane-agent-context-packages.ts)
- [Alpha command installer](../scripts/install-sane-alpha.ts)
- [Canonical SANE templates](../templates/)
- [Shared context template](../templates/SANE_CONTEXT.md)
- [Initial State template](../templates/SANE_STATE.md)
