# SANE Alpha Pilot Readiness

## Current Readiness

The Alpha can bootstrap a workstream and run Product, Research, Design,
Engineering, Execution, and Implementation sessions. It is not yet ready for an
end-to-end pilot.

Available now:

- initial-workstream bootstrap command;
- shared SANE context and State template;
- documented Implementation Stage and Job State entries;
- documented local repository and workstream-repository convention;
- Product, Research, Design, Engineering, Execution, and Implementation role
  skills;
- focused implementation-agent and read-only review-agent prompt instructions;
  and
- templates for all current Product, Research, Design, Execution, and
  Implementation documents.

## Required Before an End-to-End Pilot

### Repository Initialization

Implement and test the SANE repository-initialization command or script defined
in [SANE Alpha Repository Setup](./SANE_REPOSITORY_SETUP.md). It must create or
validate the local workstream repository, write the ignored `.sane/README.md`
pointer, and add `/.sane/` to the implementation repository's `.gitignore`.

The Implementation Assistant uses the recorded implementation-repository path
as the Bash working directory when it invokes Cursor with a timeout of at least
40 minutes:

```bash
agent -p "<job prompt>"
```

### Later-Template Provisioning

The role skills deliberately focus on role intent, file ownership, and workflow;
they do not instruct assistants to locate source templates. Before each later
role session, its documents therefore need to be provisioned by either:

- a small user-run template-copy command; or
- a documented user-run copy procedure.

The bootstrap script already exposes reusable template-registry helpers, but its
CLI intentionally creates only the initial workstream files.

### OpenCode Context Packages and Installation

Create concise OpenCode agent configurations for Product, Research, Design,
Engineering, Execution, and Implementation. Define and test installation of:

- role skills under `~/.agents/skills/`;
- agent configurations under `~/.config/opencode/agents/`; and
- stable shared V2-contract paths usable by OpenCode and Cursor prompts.

### Approval Rules and Documentation Cleanup

Create `ALPHA_APPROVAL_RULES.md` for user approvals, revocations, Updates, and
implementation-outcome handling. Also update the stale `ALPHA_STATE.md`
reference in `README.md` to `SANE_STATE.md`.

## Not Blocking the First Pilot

- the `sane-alpha` alias installer;
- a fully automated template-copy CLI, if a documented manual procedure exists;
- automated retry, worktree, merge, or supervision workflows.

## Key References

- [Alpha operating model](./ALPHA_OPERATING_MODEL.md)
- [Bootstrap plan](./SANE_WORKSTREAM_BOOTSTRAP_PLAN.md)
- [Bootstrap script](./scripts/create-sane-workstream.ts)
- [Template catalog](./templates/README.md)
- [Shared context template](./templates/SANE_CONTEXT.md)
- [Initial State template](./templates/SANE_STATE.md)
- [V2 Workstream structure](../work/014-workstream-v2/docs/PLAN_STRUCTURE.md)
- [V2 assistant boundaries](../work/014-workstream-v2/docs/WORKSTREAM_ASSISTANTS.md)
- [Implementation Report contract](../work/014-workstream-v2/docs/IMPLEMENTATION_REPORT_DEFINITION.md)
