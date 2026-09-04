# SANE Alpha Pilot Readiness

## Current Readiness

The Alpha can bootstrap a workstream and run Product, Research, Design,
Engineering, and Execution sessions. It is not yet ready for an end-to-end pilot
that carries authorized Jobs through repository implementation and review.

Available now:

- initial-workstream bootstrap command;
- shared SANE context and State template;
- documented Implementation Stage and Job State entries;
- Product, Research, Design, Engineering, and Execution role skills; and
- templates for all current Product, Research, Design, Execution, and
  Implementation documents.

## Required Before an End-to-End Pilot

### Implementation Package

Create the Stage-scoped `sane-implementation-assistant-role`, plus explicit
Cursor instructions for:

- an implementation agent carrying out one Job; and
- a read-only review agent reviewing one completed Job Group.

The package must define Implementation Report handling, user-directed retries,
and implementation State updates. The report contract is shared with Execution;
it must not be replaced by a competing report schema.

### Target Repository Convention

Decide where a workstream durably records its target repository. The
Implementation Assistant needs that path when it invokes Cursor:

```bash
agent -p --model composer-2.5 --workspace <target-repository> "<job prompt>"
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
