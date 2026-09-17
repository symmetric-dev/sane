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
the twelve source agents as global OpenCode Markdown agents under:

```text
<home>/.config/opencode/agents/
```

It copies the six assistant role skills from `alpha/skills/` to:

```text
<home>/.agents/skills/<skill-name>/SKILL.md
```

The installer has exactly eighteen destinations: six primary role-agent
configurations, six worker/subagent configurations, and six assistant skills. The
primary roles are Product, Research, Design, Engineering, Planning, and
Coordination; the subagents are Scout Worker, Research Worker, Worker
Implementer, Worker Reviewer, Worker Fixer, and Job Grounder. Scout handles bounded internal
implementation-repository inspection, while Researcher handles bounded external
evidence. Job Grounder investigates bounded repository context and directly
enriches one assigned Job Spec for Planning. Each worker's substantive contract is contained in its agent
configuration rather than a worker role skill.
It validates every source and destination before changing anything.
It creates parent directories as needed, leaves identical destinations unchanged,
and refuses differing regular files by default. `--overwrite` replaces only
differing regular files; it never replaces a non-regular destination. `--dry-run`
performs the same validation and reports planned actions without making changes.
Quit and restart OpenCode after installation or an overwrite so it loads the
changed global agent and skill files.

### Nested Scout delegation prerequisite

Implementer may launch only Scout for bounded, read-only supporting inspection;
it retains ownership of implementation, verification, decisions, and its report.
Scout accepts self-contained scoped assignments from any invoking agent whose
task permissions permit it and returns findings or blockers inline directly to
that parent. This does not grant other agents new launch permissions.

For primary → implementer → Scout, merge the following into your project or global
`opencode.json` (preserving existing configuration):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "subagent_depth": 2
}
```

The published OpenCode schema defines `subagent_depth` at the top level; its
default of `1` prevents subagents from launching subagents. It is not an agent
frontmatter setting. The context-package installer does not change this setting.
Use an OpenCode version supporting it, and quit and restart OpenCode after
configuration changes. The depth setting permits nesting; agent task permissions
still restrict launch targets, and Scout itself cannot subdelegate.

### Optional per-agent models (YAML)

Source agents intentionally have no `model` field. To select models for installed
agents, create a YAML file such as `models.yaml`. Values may be string shorthand
or objects with a required `model` and optional `variant` (flow or block YAML):

```yaml
# Keys are agent filenames without .md; omitted agents keep their source bytes.
sane-assistant-engineering: "openai/gpt-5"
sane-worker-scout: "anthropic/claude-sonnet-4-6"
sane-assistant-coordination: { model: "openai/gpt-6-astra", variant: low }
sane-assistant-design:
  model: "openai/gpt-6-astra"
  variant: high
```

```bash
sane-alpha install-context-packages --model-config ./models.yaml --dry-run
sane-alpha install-context-packages --model-config ./models.yaml --overwrite
# Direct script invocation supports the same options:
bun alpha/scripts/install-sane-agent-context-packages.ts --model-config ./models.yaml
```

Only known agent names and nonempty `provider/model` strings without whitespace
are accepted. Use providers/models available in your OpenCode configuration.
Object variants must be nonempty strings. Unknown object fields, missing models,
malformed values, unknown agent names, empty files, and lists fail before any
installation writes. An empty mapping (`{}`) is allowed.

The programmatic installer accepts `modelConfigPath`. Paths resolve from the
current working directory. Models and explicitly supplied top-level variants are
injected or replaced in memory before
destination comparisons; source files and skills are never modified. Mapped
frontmatter is reserialized as YAML (formatting/comments may change), preserving
other metadata values and the exact Markdown body. Omitting `variant` (including
string shorthand) preserves the source variant, if any. Without a config, or for an
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
   repository. Its ignored `.sane/workstreams/` directory holds all
   workstreams; `.sane/current-workstream` records the selected normalized
   path relative to `.sane/workstreams`, never an absolute workstream path.
3. **Assigned role:** each agent loads its one named installed SANE role skill.

The configuration does not repeat the substantive role instructions from the
skill or duplicate SANE template guidance. `alpha/templates/` is the canonical
source of SANE templates.

The six worker/subagent configurations instead treat their invocation
prompt as the complete assignment. Their built-in context reinforces role,
permissions, scope control, stopping behavior, and return shape without adding
workstream context that could compete with the orchestrator's supplied prompt.

No role agent requires a user to declare a workstream type, and role agents do
not read root `type` metadata as session context. Product and Design load their
single generic skill directly. Their skills use the bootstrapped `PRD.md` and
applicable root Design template without routing by type.

Reinstalling updates only the eighteen managed destinations; it does not delete
files from an earlier naming scheme. After upgrading an existing installation,
inspect and explicitly remove obsolete `sane-implementation.md` and other
pre-`sane-assistant-*` agent files from `<home>/.config/opencode/agents/`, plus
`<home>/.agents/skills/sane-implementation-assistant-role/`. The installer does
not remove potentially user-modified files automatically.

### Planning migration

The source agent is now `sane-assistant-planning.md`, loading
`sane-planning-assistant-role`; their old Execution-named sources have been
renamed, not retained as aliases. The new worker is `sane-worker-grounder.md`,
formally **Job Grounder**. The Execution phase, `execution/` artifact paths,
`EXECUTION_PLAN_TEMPLATE.md`, and `JOB_TEMPLATE.md` resource filenames remain.

Existing installations keep these obsolete paths because installation never
deletes files, even with `--overwrite`:

- `<home>/.config/opencode/agents/sane-assistant-execution.md`
- `<home>/.agents/skills/sane-execution-assistant-role/` (including `SKILL.md`)

Inspect them for local customizations, transfer any wanted changes to the new
Planning sources/configuration, and manually remove the obsolete files/directory
when ready. Also inspect any manually installed copies in project or alternate
OpenCode agent/skill directories. No automatic cleanup is performed.

In custom model YAML, rename the `sane-assistant-execution` key to
`sane-assistant-planning`, preserving its model and variant. The old key is now
unknown and fails validation before installation writes. Add an explicit
`sane-worker-grounder` mapping if desired. The checked-in `alpha/models.yaml`
transfers Planning's `openai/gpt-5.6-sol` / `low` mapping unchanged and assigns
Grounder `openai/gpt-5.6-terra` / `medium`, matching Scout's evidence-oriented
repository work. Use the existing installer with `--model-config` and `--dry-run`
to review, then `--overwrite` as needed. Quit and restart OpenCode afterward.

Existing workstreams and their copied resources are not migrated by context
installation. Review their local Job template and active Job Specs explicitly:
use `# Job Spec NN: <job name>` with the existing two-digit ID and exact plan
name, retain required H2s and paths, and preserve authored content and approval
history. Grounding terms are descriptive, not new State statuses.

## Context Ingestion and Pickup

The Scout Worker, Research Worker, Job Grounder, Worker Implementer, Worker Reviewer, and Worker Fixer are
intentionally different from the six user-started role agents described below.
They are subagents invoked by their authorized launcher with self-contained,
narrowly scoped prompts. They do not discover `.sane` and workstream context.
They may load directly relevant
non-SANE technical or repository skills, while OpenCode permission rules deny
all `sane-*-assistant-role` skills. Worker Implementer and Worker Fixer can edit
only within their supplied assignments; Worker Reviewer and Scout are strictly
read-only.

The Research Assistant reconciles its scope's research index. It
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
bounded external-evidence question, source paths to read, report and supporting-file
paths it may write, implementation-repository path, constraints, verification,
and concise return shape. The prompt carries no baseline context. It writes only those assigned
Research destinations, and registers its own report only when asked. It has no user Pickup,
Delivery, approval, State update, or question loop. It returns only a concise
summary of outputs, findings, verification, and blockers to its launcher.

Every user-started SANE session follows this sequence:

1. The user selects an OpenCode SANE role agent and sends an initial session
   prompt.
2. The harness provides the selected agent configuration before the user's
   prompt. The configuration tells the agent which role skill to load.
3. The agent loads that installed role skill.
4. The agent treats its current working directory as the implementation
   repository and reads `.sane/current-workstream` to obtain the normalized
   workstream-relative path.
5. Unless the user explicitly selected a different workstream, the agent uses
   that selection directly.
   If that current pointer is missing or invalid, the agent asks the user to
   select a workstream and stops. It must not infer, create, or switch a
   workstream.
6. The agent resolves the selected absolute workstream as
   `<implementation-repository>/.sane/workstreams/<current-workstream>`, then reads its
   `SANE_CONTEXT.md` and the role-specific Pickup inputs
   required by its installed skill, and views state via
   `sane-alpha state <impl-repo> <ws-path>`.
   A role that consumes Research records the hashes of the registered
   `research/<topic>/REPORT.md` files it uses, as shown by
   `sane-alpha research <impl-repo> <ws-path> --index`.
7. The agent performs Pickup and reports a readiness checkpoint to the user. The
   checkpoint concisely identifies the workstream, assigned role and Stage when
   applicable, relevant current State, proposed session scope, and any missing
   inputs or blocking conditions.
8. The agent stops after the readiness checkpoint. It does not begin Assistance,
   draft artifacts, or treat the initial session prompt as permission to proceed.
9. The user resolves missing inputs, supplies additional details, or explicitly
   directs the agent to proceed, for example with “let's start,” “proceed,” or
   “continue.” The agent then performs Assistance according to its role skill.

Before Delivery, a Research-consuming role rechecks the captured report hashes
and reconciles new, edited, or removed reports as a mismatch. Topic
`REPORT.md` files remain authoritative evidence. A Research session has one
assigned scope; delegated researchers write reports. Only the Research Assistant
reconciles the index (`--index`/`--unregister`); a worker registers its own
report only when asked. Evidence from another scope applies only
through an explicit reference to its registered report. Research has no gates.
Approved Design remains implementation authority, so a material Research conflict
is routed to a Design/Engineering update and re-approval. The retired baseline
model (`research/BASELINE.md`, the baselines table, baseline revisions, and
`sane-alpha baseline --record|--recheck`) no longer exists.

## Working Directory, Permissions, and Scope

Planning first reads its Pickup inputs, reports readiness, and waits. After the
user permits Assistance, it proposes only the compact Execution Plan (`Jobs`
and `Split Notes`) and waits for explicit breakdown confirmation before creating
draft Job Specs or launching Job Grounder. Each worker receives one spec's exact
writable path, bounded repository scope, and exact read-only Design, plan, and
predecessor context. It enriches that spec with a prioritized path/symbol/reason
read map, actionable steps, integration contracts, and exact verified command
definitions, distinguishing current facts, required changes, expected predecessor
outputs, and actual command outcomes. It returns findings, gaps, and limitations.
It cannot edit application files, Design, plan, State, or other specs, approve
anything, converse with users, or subdelegate. Planning reviews summaries and
cross-job consistency, performs targeted inspection, and obtains renewed
confirmation for changed splits and approved Design Updates for changed Design.
The completed plan and all Job Specs then require final user package approval.

Job Grounder's `edit: allow` and `external_directory: allow` permit writing its
assigned spec in the ignored workstream directory. Arbitrary invocation-supplied path limits
are behavioral, not dynamically enforced by those permissions. Bash is available
only for safe read-only inspection; mutating verification must be recorded as not
run. Planning may delegate only to `sane-worker-grounder`.

Planning is the sole owner/editor of Execution Plans and Job Specs, including
later factual corrections and revisions, with Grounder limited to its assigned
spec. Coordination never edits planning artifacts or launches Grounder; its task
allowlist contains only implementer, reviewer, and fixer. It reports **“Planning
needs to make these corrections”** with actionable paths/issues and evidence and
waits for the user to return to Planning. Planning redelivers revisions under the
existing explicit breakdown/final approval gates and Design Update escalation.
Engineering retains `ask` permissions for both Scout and Researcher.

Coordination consumes compact `Jobs` / `Split Notes` with lightweight dispatch
readiness rather than duplicate grounding. Sequential list order is the default;
parallel execution requires explicit plan authorization. An execution batch is
one Job or an explicitly parallel set, with ready, reviewed, user-accepted
predecessors and current user run authorization. It adds no plan headings or
State schema. One reviewer assesses each completed batch; review/fix cycles retain
user-selected checkpoints or delegated scope/attempt limits and user-only acceptance.
Stage handoff uses Stage/Job Specs, actual reports, and review evidence.

Implementer assignments start inspection at the Job Spec's required-start read
map and applicable repository instructions. Conditional references carry triggers;
concrete correctness, integration, regression, or verification concerns justify
targeted expansion without hard read caps. Material context gaps stop affected
work for the user's Planning handoff. The reviewer core assignment is relevant
Design Section Spec(s), Job Spec(s), and bounded repository/review/output
instructions. Reviewers independently inspect actual code and evidence, reading
reports only as necessary to verify report and verification accuracy. There is
no mandatory report template, Execution Plan, global context, or exhaustive
reference traversal. Full review quality applies within the boundary; Narrow Fix
reviews stay targeted, and Bounded Remediation reviews cover the coherent problem.
Reviewers never edit files; fixers never edit planning artifacts.

The implementation repository is the required OpenCode session working
directory. An agent started elsewhere reports that condition and waits for the
user to start it from the implementation repository or otherwise resolve the
location; it does not guess a repository.

Each SANE OpenCode configuration must grant `external_directory: allow` so the
agent can read and, when its role permits, edit the ignored workstream
directory outside the tracked implementation repository. It must also grant `skill: allow` so the
agent can load its role skill. Other permissions remain role-specific.

For the Research Worker, permissions support assigned external research and
report outputs but do not imply reliable dynamic enforcement of every supplied
path. Its behavioral contract allows only exact supplied local context needed to
understand the external question; general implementation-repository discovery
belongs to Scout. It prohibits all implementation-repository writes, installs,
migrations, and deployments. Live credentials or external-system calls require
an exact explicit assignment.

Scout has `external_directory: allow` because workstreams live in the ignored
`.sane/workstreams/` directory and Engineering may need to give
it exact Stage, Section, or other workstream artifacts as inspection context.
The permission does not authorize external discovery: Scout may read only exact
external paths supplied in its assignment. It denies web access and has
`edit: deny`. Although Bash supports focused inspection, its contract prohibits
every mutating command and keeps codebase exploration inside the exact supplied
implementation scope.

Engineering, Planning (Execution phase), and Implementation sessions require a user-selected
Stage. Without one, Pickup is incomplete and the agent reports the missing Stage
at its readiness checkpoint. Design may operate on the root Design or on a
user-selected Stage; Product and Research normally operate across the
workstream, though Research may have a user-directed Stage scope.

A Research session is assigned either workstream scope for non-Stage or
cross-Stage work, or one Stage scope. Completed evidence lives at
`research/<topic>/REPORT.md` (from `resources/RESEARCH_REPORT_TEMPLATE.md`).
Reports are append-only: never update a registered report, write a new topic
instead. The registry is the `research_reports` table. Delegated agents write
only their assigned topic reports. Root Design reads the workstream reports;
Stage Design reads its assigned Stage reports.

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
