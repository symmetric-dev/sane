# SANE Alpha Readiness

## Current Capability

Alpha has a tested repository and template layer for two workstream types:
`feature` and `foundation`.

- `create-workstream` requires `--type feature|foundation` and creates an
  immutable root `type` metadata file.
- Selection and role provisioning validate that metadata. Provisioning derives
  the selected workstream's type from its root; it has no type override.
- Reusable source templates live in `alpha/templates/shared/`; feature and
  foundation root artifacts and root Designs use their own template sources.
- Foundation creates `FOUNDATION.md` and uses its foundation root
  `design/SPEC.md`; that Design is its durable decision record.
- Repository pairing, workstream selection, role-artifact provisioning, the
  `sane-alpha` installer, shared context installation, and generic role skills
  are available and tested.
- Focused Feature and Foundation Product and Design skills are available as
  source packages, but are not yet installed or selected by the role agents.

The installed agent packages are still type-neutral.
Therefore, Alpha has type-aware scripts and templates, but not yet complete
type-aware agent operation.

## Work Remaining for Complete Type Support

1. Keep the existing OpenCode role configurations stable. Product and Design
   route from the workstream type explicitly declared by the user to one matching
   type-specific skill. Agents do not read the root `type` file as session
   context; if the user omits the type, they ask for it rather than guessing.
2. Keep Research, Engineering, Execution, and Implementation on their shared
   skills. Their current artifacts and contracts are intentionally type-neutral;
   they receive type-specific direction through the approved Product and Design
   artifacts.
3. Extend the agent-context-package installer and its tests to install and
   validate the four Product and Design type-specific skills while preserving
   safe dry-run and overwrite behavior.
4. Run one fresh manual `feature` pilot and one fresh manual `foundation` pilot.
   Each must validate creation, selection, provisioning, skill routing,
   implementation in the target repository, verification, user approval, and
   later-workstream handoff.
5. Use pilot evidence to decide whether foundation needs specialized Stage or
   Section templates. Research, Execution Plan, Job, Implementation Report,
   State, and shared Context remain intentionally common unless that evidence
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
