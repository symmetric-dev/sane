# SANE Alpha Readiness

## Current Capability

Alpha has a tested repository and template layer for two workstream types:
`feature` and `foundation`.

- `create-workstream` requires `--type feature|foundation` and creates an
  immutable root `type` metadata file.
- Selection validates that metadata; roles do not read it as session context.
- Reusable source templates live in `alpha/templates/shared/`; feature and
  foundation root artifacts and root Designs use their own template sources.
- Every workstream creates `PRD.md`; foundation uses its foundation root
  `design/SPEC.md`, which remains its durable decision record.
- Repository pairing, workstream selection, the `sane-alpha` installer, shared
  context installation, and generic role skills are available and tested.
- The six generic role skills serve Product, Research, Design, Engineering,
  Execution, and Implementation. No role agent requires a user type declaration
  or reads root `type` metadata as session context.

Alpha has type-aware scripts and templates, with type-neutral role-agent
operation.

## Work Remaining for Complete Type Support

1. Keep all six role skills generic. Their artifacts and contracts are
   intentionally type-neutral except for the type-selected root artifacts and
   templates handled by Product and Design.
2. Run one fresh manual `feature` pilot and one fresh manual `foundation` pilot.
    Each must validate creation, selection, template-copy artifact creation, generic skill use,
   implementation in the target repository, verification, user approval, and
   later-workstream handoff.
3. Use pilot evidence to decide whether foundation needs specialized Stage or
   Section templates. Research, Execution Plan, Job, Implementation Report,
   Stage Implementation Brief, State, and shared Context remain intentionally
   common unless that evidence
   shows otherwise.

## Deferred

- executable `maintenance`, `defect`, and `incident` types;
- cancellation, failure-history, and replacement-workstream lifecycle records;
- retry, worktree, merge, and supervision automation.

## Key References

- [Workstream types](./WORKSTREAM_TYPES.md)
- [Alpha operating model](./ALPHA_OPERATING_MODEL.md)
- [Pilot user guide](./SANE_PILOT_USER_GUIDE.md)
- [Mock workflow](./SANE_MOCK_WORKFLOW.md)
- [Agent context packages](./SANE_AGENT_CONTEXT_PACKAGES.md)
- [Repository setup](./SANE_REPOSITORY_SETUP.md)
- [Feature templates](../templates/feature/)
- [Foundation templates](../templates/foundation/)
- [Shared templates](../templates/shared/)
