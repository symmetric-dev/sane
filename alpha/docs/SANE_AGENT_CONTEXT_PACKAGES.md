# SANE Alpha Agent Context Packages

## Purpose

An Alpha agent context package combines a concise OpenCode agent configuration
with the installed skill for its assigned SANE role. The configuration is the
session entrypoint; the role skill is the detailed contract for Pickup,
Assistance, Delivery, approvals, and artifact boundaries.

Source OpenCode agent definitions are maintained under:

```text
alpha/opencode/agents/
```

Install the complete context package with:

```bash
sane-alpha install-context-packages [--dry-run] [--overwrite]
```

The installer uses `SANE_HOME` when set (otherwise the current user's home), so
the command is isolated with `SANE_HOME=/temporary/home` when needed. It copies
the six source agents as global OpenCode Markdown agents under:

```text
<home>/.config/opencode/agents/
```

It copies the six generic role skills from `alpha/skills/` to:

```text
<home>/.agents/skills/<skill-name>/SKILL.md
```

The installer has exactly twelve destinations: six agent configurations and six
generic role skills: Product, Research, Design, Engineering, Execution, and
Implementation. It validates every source and destination before changing
anything.
It creates parent directories as needed, leaves identical destinations unchanged,
and refuses differing regular files by default. `--overwrite` replaces only
differing regular files; it never replaces a non-regular destination. `--dry-run`
performs the same validation and reports planned actions without making changes.
Quit and restart OpenCode after installation or an overwrite so it loads the
changed global agent and skill files.

## Agent-Configuration Content

Each role configuration starts with the same three concepts, in this order:

1. **SANE:** “SANE is a structured, reasonable way for people and agents to
   acquire and apply knowledge in service of deliberate change.”
2. **File convention:** the current working directory is the implementation
   repository. Its ignored `.sane/paths` records `implementation-path` and
   `workstream-repository-path`; `.sane/current-workstream` records the selected
   normalized path relative to `workstream-repository-path`, never an absolute
   workstream path.
3. **Assigned role:** each agent loads its one named installed SANE role skill.

The configuration does not repeat the substantive role instructions from the
skill or duplicate SANE template guidance. `alpha/templates/` is the canonical
source of SANE templates.

No role agent requires a user to declare a workstream type, and role agents do
not read root `type` metadata as session context. Product and Design load their
single generic skill directly. Their skills use the provisioned `PRD.md` and
applicable root Design template without routing by type.

Reinstalling updates only the twelve managed destinations; it does not delete
previously installed typed skill directories. If they remain from an earlier
Alpha installation, inspect and remove them only through explicit user-directed
cleanup.

## Context Ingestion and Pickup

Every user-started SANE session follows this sequence:

1. The user selects an OpenCode SANE role agent and sends an initial session
   prompt.
2. The harness provides the selected agent configuration before the user's
   prompt. The configuration tells the agent which role skill to load.
3. The agent loads that installed role skill.
4. The agent treats its current working directory as the implementation
   repository and reads `.sane/paths` to obtain the paired repository locations.
5. Unless the user explicitly selected a different workstream, the agent reads
   `.sane/current-workstream` to obtain the normalized workstream-relative path.
   If that current pointer is missing or invalid, the agent asks the user to
   select a workstream and stops. It must not infer, create, or switch a
   workstream.
6. The agent resolves the selected absolute workstream as
   `<workstream-repository-path>/<current-workstream>`, then reads its
   `SANE_CONTEXT.md`, `SANE_STATE.md`, and the role-specific Pickup inputs
   required by its installed skill.
7. The agent performs Pickup and reports a readiness checkpoint to the user. The
   checkpoint concisely identifies the workstream, assigned role and Stage when
   applicable, relevant current State, proposed session scope, and any missing
   inputs or blocking conditions.
8. The agent stops after the readiness checkpoint. It does not begin Assistance,
   draft artifacts, or treat the initial session prompt as permission to proceed.
9. The user resolves missing inputs, supplies additional details, or explicitly
   directs the agent to proceed, for example with “let's start,” “proceed,” or
   “continue.” The agent then performs Assistance according to its role skill.

## Working Directory, Permissions, and Scope

The implementation repository is the required OpenCode session working
directory. An agent started elsewhere reports that condition and waits for the
user to start it from the implementation repository or otherwise resolve the
location; it does not guess a repository.

Each SANE OpenCode configuration must grant `external_directory: allow` so the
agent can read and, when its role permits, edit the paired workstream repository
outside the implementation repository. It must also grant `skill: allow` so the
agent can load its role skill. Other permissions remain role-specific.

Engineering, Execution, and Implementation sessions require a user-selected
Stage. Without one, Pickup is incomplete and the agent reports the missing Stage
at its readiness checkpoint. Design may operate on the root Design or on a
user-selected Stage; Product and Research normally operate across the
workstream, though Research may have a user-directed Stage scope.

## Deferred Delivery-Skill Design

The current role skills contain Pickup, Assistance, and Delivery together. This
means an agent can see Delivery guidance from the beginning of a session.

A possible later design is a separate pair of skills for each role:

- `sane-<role>-start` for context acquisition, Pickup, Assistance, and role
  boundaries; and
- `sane-<role>-end` for Delivery, handoff, approval prompting, and State update
  guidance.

The agent would load the end skill only after the user asks to assess completion,
deliver, or prepare a handoff. This is an open design question only. Alpha does
not yet split the existing role skills or change their Delivery behavior.
