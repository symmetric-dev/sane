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

The generic role skills and installed agent packages are still type-neutral.
Therefore, Alpha has type-aware scripts and templates, but not yet complete
type-aware agent operation.

## Work Remaining for Complete Type Support

1. Create focused `feature` and `foundation` skills for Product and Design.
   These are the only roles whose root artifacts and root responsibilities differ
   materially by type.
2. Keep the existing OpenCode role configurations stable. All role agents must
   validate the workstream root `type` before operating; only Product and Design
   route from the user-declared and root-`type`-confirmed type to a matching
   type-specific skill. A prompt/type mismatch must be reported to the user, not
   guessed.
3. Keep Research, Engineering, Execution, and Implementation on their shared
   skills. Their current artifacts and contracts are intentionally type-neutral;
   they receive type-specific direction through the approved Product and Design
   artifacts.
4. Extend the agent-context-package installer and its tests to install and
   validate the four Product and Design type-specific skills while preserving
   safe dry-run and overwrite behavior.
5. Run one fresh manual `feature` pilot and one fresh manual `foundation` pilot.
   Each must validate creation, selection, provisioning, skill routing,
   implementation in the target repository, verification, user approval, and
   later-workstream handoff.
6. Use pilot evidence to decide whether foundation needs specialized Stage or
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
