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
- Context installation now manages eleven agent configurations (six assistants
  and five workers), six assistant skills, and seventeen destinations. OpenCode
  must be restarted after installation or an
  overwrite. No role agent requires a user type declaration
  or reads root `type` metadata as session context.
- Research uses authoritative topic `REPORT.md` evidence within one assigned
  workstream or Stage scope, coordinated by that scope's `BASELINE.md`. Every
  baseline uses the single `RESEARCH_BASELINE_TEMPLATE.md` resource.
- The coordinating Research Assistant owns each baseline. A Research Worker is
  focused on external evidence, reads the baseline, and writes one bounded topic
  report plus assigned supporting files. Engineering may launch Researcher only
  after an explicit user request for bounded external research during its
  otherwise unchanged lifecycle; users may still start the Research Assistant.
- After normal user confirmation to proceed with Engineering Assistance,
  Engineering may launch Scout for exact bounded internal repository inspection.
  Scout is read-only, has no web access, writes no Research Report, and returns
  inline path-and-line evidence. Its external-directory permission lets it read
  only exact workstream-artifact paths supplied by Engineering from the paired
  repository; it cannot discover wider external context or mutate either
  repository. Engineering owns synthesis and decisions with the user. Research
  Assistant performs repository audits directly and cannot launch Scout.
- The worker has no user Pickup, Delivery, approval, or question loop. Its exact,
  self-contained prompt and concise return govern the assignment. Read-only
  exact supplied local context and non-destructive verification are allowed only
  as needed to understand its external question; general internal inspection
  belongs to Scout. Implementation writes, installs, migrations, and deployments
  are prohibited. Live credentials or external-system calls require an exact
  explicit assignment. This is a behavioral, not overstated dynamic
  path-permission, boundary.

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
4. Validate that Research consumers capture the assigned baseline revision at
   Pickup, recheck it at Delivery, and route material conflicts with approved
   Design through an explicit Design Update.

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
