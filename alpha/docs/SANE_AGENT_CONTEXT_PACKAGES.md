# SANE Alpha Agent Context Packages

## Purpose

An Alpha assistant context package combines a concise OpenCode agent
configuration with the installed skill for its assigned SANE role. Worker
context packages are self-contained OpenCode agent configurations. The
configuration is the entrypoint; assistant role skills provide the detailed
contracts for Pickup, Assistance, Delivery, approvals, and artifact boundaries.

Source OpenCode agent definitions are maintained under:

```text
alpha/opencode/agents/
```

Install the complete context package with:

```bash
sane-alpha install-context-packages [--dry-run] [--overwrite] [--model-config <path>]
```

The installer uses `SANE_HOME` when set (otherwise the current user's home), so
the command is isolated with `SANE_HOME=/temporary/home` when needed. It copies
the eleven source agents as global OpenCode Markdown agents under:

```text
<home>/.config/opencode/agents/
```

It copies the six assistant role skills from `alpha/skills/` to:

```text
<home>/.agents/skills/<skill-name>/SKILL.md
```

The installer has exactly seventeen destinations: six primary role-agent
configurations, five worker/subagent configurations, and six assistant skills. The
primary roles are Product, Research, Design, Engineering, Execution, and
Coordination; the subagents are Scout Worker, Research Worker, Worker
Implementer, Worker Reviewer, and Worker Fixer. Scout handles bounded internal
implementation-repository inspection, while Researcher handles bounded external
evidence. Each worker's substantive contract is contained in its agent
configuration rather than a worker role skill.
It validates every source and destination before changing anything.
It creates parent directories as needed, leaves identical destinations unchanged,
and refuses differing regular files by default. `--overwrite` replaces only
differing regular files; it never replaces a non-regular destination. `--dry-run`
performs the same validation and reports planned actions without making changes.
Quit and restart OpenCode after installation or an overwrite so it loads the
changed global agent and skill files.

### Optional per-agent models (YAML)

Source agents intentionally have no `model` field. To select models for installed
agents, create a flat YAML file such as `models.yaml`:

```yaml
# Keys are agent filenames without .md; omitted agents keep their source bytes.
sane-assistant-engineering: "openai/gpt-5"
sane-worker-scout: "anthropic/claude-sonnet-4-6"
```

```bash
sane-alpha install-context-packages --model-config ./models.yaml --dry-run
sane-alpha install-context-packages --model-config ./models.yaml --overwrite
# Direct script invocation supports the same options:
bun alpha/scripts/install-sane-agent-context-packages.ts --model-config ./models.yaml
```

Only known agent names and nonempty `provider/model` strings without whitespace
are accepted. Use providers/models available in your OpenCode configuration.
An empty mapping (`{}`) is allowed; empty files, lists, nested mappings, unknown
names, and invalid model values fail before any installation writes.

The programmatic installer accepts `modelConfigPath`. Paths resolve from the
current working directory. Models are injected or replaced in memory before
destination comparisons; source files and skills are never modified. Mapped
frontmatter is reserialized as YAML (formatting/comments may change), preserving
other metadata values and the exact Markdown body. Without a config, or for an
unmapped agent, original bytes are preserved. Repeating the same configuration is
a no-op; changing or removing an installed override requires `--overwrite` when
the destination differs. Dry runs perform the same validation without writes.
Quit and restart OpenCode after installation to load the selected models.

## Agent-Configuration Content

Each of the six primary role configurations starts with the same three concepts,
in this order:

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

The five worker/subagent configurations instead treat their invocation
prompt as the complete assignment. Their built-in context reinforces role,
permissions, scope control, stopping behavior, and return shape without adding
workstream context that could compete with the orchestrator's supplied prompt.

No role agent requires a user to declare a workstream type, and role agents do
not read root `type` metadata as session context. Product and Design load their
single generic skill directly. Their skills use the bootstrapped `PRD.md` and
applicable root Design template without routing by type.

Reinstalling updates only the seventeen managed destinations; it does not delete
files from an earlier naming scheme. After upgrading an existing installation,
inspect and explicitly remove obsolete `sane-implementation.md` and other
pre-`sane-assistant-*` agent files from `<home>/.config/opencode/agents/`, plus
`<home>/.agents/skills/sane-implementation-assistant-role/`. The installer does
not remove potentially user-modified files automatically.

## Context Ingestion and Pickup

The Scout Worker, Research Worker, Worker Implementer, Worker Reviewer, and Worker Fixer are
intentionally different from the six user-started role agents described below.
They are subagents invoked by their authorized launcher with self-contained,
narrowly scoped prompts. They do not discover `.sane` and workstream context.
They may load directly relevant
non-SANE technical or repository skills, while OpenCode permission rules deny
all `sane-*-assistant-role` skills. Worker Implementer and Worker Fixer can edit
only within their supplied assignments; Worker Reviewer and Scout are strictly
read-only.

The coordinating Research Assistant owns and updates its scope's baseline. It
may launch a Research Worker for one bounded external-evidence topic. An
Engineering Assistant may use Scout for bounded internal codebase inspection
after normal user confirmation to proceed with Assistance. It may use Researcher
only after the user explicitly requests bounded external research during its
normal, otherwise unchanged lifecycle. Engineering owns synthesis and decisions
with the user. A user may still start the Research Assistant directly.

A Scout receives an exact implementation-repository scope and question plus any
exact workstream-artifact paths Engineering supplies as necessary context. It
inspects applicable repository instructions, source, tests, configuration,
callers, and integration points with safe non-destructive commands, then returns
an inline evidence handoff with paths and line numbers. It cannot ask questions,
use web research, launch children, discover wider external context, mutate files,
or write a Research `REPORT.md`.

A Research Worker receives one exact, self-contained prompt specifying the
bounded external-evidence question, baseline and source paths to read, report and supporting-file
paths it may write, implementation-repository path, constraints, verification,
and concise return shape. It reads the baseline, writes only those assigned
Research destinations, and never updates the baseline. It has no user Pickup,
Delivery, approval, State update, or question loop. It returns only a concise
summary of outputs, findings, verification, and blockers to its launcher.

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
   A role that consumes Research records the revision of its assigned scope's
   `research/workstream/BASELINE.md` or `research/stage-NN/BASELINE.md`.
7. The agent performs Pickup and reports a readiness checkpoint to the user. The
   checkpoint concisely identifies the workstream, assigned role and Stage when
   applicable, relevant current State, proposed session scope, and any missing
   inputs or blocking conditions.
8. The agent stops after the readiness checkpoint. It does not begin Assistance,
   draft artifacts, or treat the initial session prompt as permission to proceed.
9. The user resolves missing inputs, supplies additional details, or explicitly
   directs the agent to proceed, for example with “let's start,” “proceed,” or
   “continue.” The agent then performs Assistance according to its role skill.

Before Delivery, a Research-consuming role rechecks the captured baseline
revision and reconciles changes or reports the stale-input conflict. Topic
`REPORT.md` files remain authoritative evidence. A Research session has one
assigned scope, and only its coordinator updates that scope's baseline;
delegated researchers write reports. Evidence from another scope applies only
through an explicit link in the consuming baseline. Approved Design remains
implementation authority, so a material Research conflict is routed to Design
as an Update.

## Working Directory, Permissions, and Scope

The implementation repository is the required OpenCode session working
directory. An agent started elsewhere reports that condition and waits for the
user to start it from the implementation repository or otherwise resolve the
location; it does not guess a repository.

Each SANE OpenCode configuration must grant `external_directory: allow` so the
agent can read and, when its role permits, edit the paired workstream repository
outside the implementation repository. It must also grant `skill: allow` so the
agent can load its role skill. Other permissions remain role-specific.

For the Research Worker, permissions support assigned external research and
report outputs but do not imply reliable dynamic enforcement of every supplied
path. Its behavioral contract allows only exact supplied local context needed to
understand the external question; general implementation-repository discovery
belongs to Scout. It prohibits all implementation-repository writes, installs,
migrations, and deployments. Live credentials or external-system calls require
an exact explicit assignment.

Scout has `external_directory: allow` because the paired workstream repository
is separate from the implementation repository and Engineering may need to give
it exact Stage, Section, or other workstream artifacts as inspection context.
The permission does not authorize external discovery: Scout may read only exact
external paths supplied in its assignment. It denies web access and has
`edit: deny`. Although Bash supports focused inspection, its contract prohibits
every mutating command and keeps codebase exploration inside the exact supplied
implementation scope.

Engineering, Execution, and Implementation sessions require a user-selected
Stage. Without one, Pickup is incomplete and the agent reports the missing Stage
at its readiness checkpoint. Design may operate on the root Design or on a
user-selected Stage; Product and Research normally operate across the
workstream, though Research may have a user-directed Stage scope.

A Research session is assigned either workstream scope for non-Stage or
cross-Stage work, or one Stage scope. Its coordinator owns that scope's
baseline. Delegated agents write only their assigned topic reports. Root Design
reads the workstream baseline; Stage Design reads its assigned Stage baseline.

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
