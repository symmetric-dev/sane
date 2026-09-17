# SANE Alpha Pilot User Guide

Install the Alpha command once from the SANE checkout, then run the pilot
commands from any directory. Replace the example implementation repository and
workstream names with your own values.

```bash
IMPL="/absolute/path/to/implementation-repository"
WORKSTREAM="01-my-workstream"
```

## One-Time Setup

Install the `sane-alpha` command wrapper:

```bash
bun alpha/scripts/install-sane-alpha.ts
```

The installer writes a managed wrapper to `~/.local/bin/sane-alpha` by default
(`SANE_HOME/.local/bin` when `SANE_HOME` is set). It never edits shell startup
files. Ensure that directory is on `PATH`, for example:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Use `--bin-dir <path>` to select another user-owned executable directory.
`--dry-run` validates without changing files, and `--overwrite` is required to
replace a differing regular `sane-alpha` file. The installed wrapper remains
tied to this checkout. If the checkout moves, run this from its new location:

```bash
bun alpha/scripts/install-sane-alpha.ts --overwrite
```

Install the SANE OpenCode agents and role skills:

```bash
sane-alpha install-context-packages --overwrite --model-config ./alpha/models.yaml 
```

Quit and restart OpenCode after installation (and after any overwrite) so the
twelve agent configurations and six assistant skills are loaded. The installer
manages eighteen destinations in total: six assistants and six workers plus
the six skills.

Initialize local SANE workstream storage inside the implementation repository:

```bash
sane-alpha init-sane "$IMPL"
```

## Start a Workstream

Create and select a new workstream under the ignored `.sane/workstreams/` root:

```bash
sane-alpha create-workstream "$IMPL" "$WORKSTREAM" --type feature
```

`--type` is required and accepts only `feature` or `foundation`. This example
creates a feature workstream, records `feature` in its immutable root `type`
file, selects it, and creates `PRD.md` plus local fallback templates at:

```text
resources/IMPLEMENTATION_REPORT_TEMPLATE.md
resources/STAGE_IMPLEMENTATION_BRIEF_TEMPLATE.md
resources/SECTION_SPEC_TEMPLATE.md
resources/JOB_TEMPLATE.md
resources/RESEARCH_REPORT_TEMPLATE.md
resources/RESEARCH_BASELINE_TEMPLATE.md
resources/ROOT_DESIGN_SPEC_TEMPLATE.md
resources/STAGES_TEMPLATE.md
resources/STAGE_DESIGN_SPEC_TEMPLATE.md
resources/STAGE_SECTIONS_TEMPLATE.md
resources/EXECUTION_PLAN_TEMPLATE.md
```

For `--type foundation`, creation also creates `PRD.md`; root Design uses the
foundation `design/SPEC.md` template. Start the appropriate SANE role
agent in OpenCode. Product and Design load their single generic role skill and
work with the applicable bootstrapped root artifact and root Design template. No
role agent requires a type declaration or reads root `type` metadata as session
context; type only controls bootstrap root artifacts and templates.

## Role-Created Artifacts

There is no CLI command to create role artifacts. When an owning role needs an artifact,
it inspects `resources/`, creates the parent directory, copies the matching local
template to the destination, and edits the copy. It never overwrites an existing
artifact and preserves the template's required headings and structure:

- Coordinating Research: `RESEARCH_BASELINE_TEMPLATE.md` → either
  `research/workstream/BASELINE.md` for non-Stage or cross-Stage scope, or
  `research/stage-NN/BASELINE.md` for Stage scope.
- Topic Research: `RESEARCH_REPORT_TEMPLATE.md` → `<assigned-scope>/<topic>/REPORT.md`.
- Design: `ROOT_DESIGN_SPEC_TEMPLATE.md` → `design/SPEC.md`,
  `STAGES_TEMPLATE.md` → `design/STAGES.md`, and
  `STAGE_DESIGN_SPEC_TEMPLATE.md` → `design/stages/<id>-<slug>/SPEC.md`.
- Engineering: `STAGE_SECTIONS_TEMPLATE.md` →
  `design/stages/<id>-<slug>/SECTIONS.md`; `SECTION_SPEC_TEMPLATE.md` →
  `design/stages/<id>-<slug>/sections/<id>-<slug>.md`.
- Planning (Execution phase): `EXECUTION_PLAN_TEMPLATE.md` →
  `execution/stages/<id>-<slug>/EXECUTION_PLAN.md`; `JOB_TEMPLATE.md` →
  `execution/stages/<id>-<slug>/jobs/<id>-<slug>.md`.
- Implementation: `IMPLEMENTATION_REPORT_TEMPLATE.md` →
  `implementation/reports/<stage-id>-<stage-slug>/<job-id>-<job-slug>.md`; after
  all authorized Jobs are completed and reviewed,
  `STAGE_IMPLEMENTATION_BRIEF_TEMPLATE.md` →
  `implementation/briefs/STAGE_<two-digit-id>.md`.

`PRD.md`, `SANE_CONTEXT.md`, and `SANE_STATE.md` are bootstrap-root artifacts;
their owning roles edit them in place.

Select `sane-assistant-planning` for the Execution phase. After Pickup it reports
readiness and waits. Once you permit Assistance, it proposes the compact plan
(`Jobs` and `Split Notes`) and waits for separate explicit breakdown confirmation.
Only then does it draft Job Specs and invoke `sane-worker-grounder` for one spec
at a time per worker. A Job is the work unit; a Job Spec is its document, titled
`# Job Spec NN: <job name>` with the plan's exact ID and name.

Job Grounder writes only its assigned spec, adding a prioritized verified read
map (paths, symbols, reasons), steps, integration contracts, and exact command
definitions. It distinguishes existing facts, required changes, expected
predecessor outputs, and actual verification outcomes, and returns findings,
gaps, and limitations. It cannot edit application files, Design, plan, State,
or other specs, hold user conversations, approve, or subdelegate. Planning
reviews cross-job consistency and targeted evidence. A changed split requires
renewed confirmation; changed Design requires an approved Update. Finally you
approve the complete plan and all Job Specs; grounding itself grants no approval
and introduces no State status.

Planning alone edits plans and Job Specs, including factual corrections, through
its own work and assigned Grounder enrichment. Coordination never edits them or
launches Grounder. If a spec is stale or incomplete, it reports **“Planning needs
to make these corrections”** with actionable paths/issues and waits for you to
return to Planning. Existing breakdown/final approvals and Design escalation apply.

Coordination checks grounded dispatch inputs and actual predecessor readiness,
including review and your acceptance. Execution follows sequential list order
unless `Split Notes` explicitly authorizes parallel work. Each execution batch
(one Job or an explicitly parallel set) gets one read-only review. Implementers
use required-start read maps, conditional references, and targeted expansion
without hard read caps. Reviewers receive relevant Section Specs, Job Specs, and
bounded repository/review/output instructions; they independently inspect code
and evidence and read reports as necessary to verify accuracy. They need no
mandatory report template or Execution Plan and never edit files.

Choose checkpointed or delegated review/fix cycles, with explicit scope and
attempt limits for delegation. Only you accept outcomes. Narrow Fix reviews stay
targeted; Bounded Remediation reviews cover the coherent remediation. Stage
handoff uses the Stage Spec, Job Specs, actual reports, and reviews to produce
the existing brief and Implementation State record. See the
[operating model](./_legacy/ALPHA_OPERATING_MODEL.md#alpha-execution-model).

Topic `REPORT.md` files are authoritative evidence. A Research session has one
assigned workstream or Stage scope, and only its coordinator updates that
scope's baseline. Delegated researchers write reports under the assigned scope.
Cross-scope evidence applies only when the consuming baseline explicitly links
it. Root Design reads the workstream baseline; Stage Design reads its assigned
Stage baseline. Research consumers capture that baseline's revision at Pickup
and recheck it at Delivery. Approved Design remains implementation authority,
so a material Research conflict requires a Design Update and approval.

The coordinating Research Assistant may invoke a Research Worker for external
evidence and to write one bounded topic report and explicitly named supporting files; only the coordinator
owns the baseline. Engineering may invoke that worker only after an explicit
user request for bounded external research during its normal, unchanged lifecycle. You may always
start the Research Assistant directly instead.

Researcher receives an exact, self-contained prompt, reads the baseline, and
returns a concise summary to its launcher. It has no user Pickup, Delivery,
approval, or question loop. It may inspect exact supplied local context needed
for the external question, but general internal repository discovery belongs to
Scout. It may not write
implementation files, install dependencies, or run migrations or deployments.
Live-credential or external-system access requires an exact explicit assignment.
Treat this as a behavioral
boundary; do not assume dynamic path permissions enforce every prompt path.

After you normally confirm Engineering Assistance, Engineering may invoke Scout
for one exact internal implementation-repository inspection. Scout can inspect
instructions, source, tests, configuration, callers, and integration points and
run safe non-destructive commands. Engineering may give it exact artifacts from
the local workstream repository as read-only context. It cannot ask
questions, use external research, launch children, discover wider external
context, mutate either repository, or write a Research Report; it returns concise
inline findings with precise paths and line numbers. Engineering reviews and
synthesizes those findings with you. Research Assistant does its own repository
audits and cannot invoke Scout.

## Resume Another Workstream

Select an existing workstream before starting a new SANE role session:

```bash
sane-alpha select-workstream "$IMPL" "$WORKSTREAM"
```

Selection takes no type argument and rejects a workstream with missing or
unsupported root `type` metadata.

## Inspect the Selected Workstream

Workstreams live under the ignored `$IMPL/.sane/workstreams/` root and are
never committed. Inspect the selected workstream directly rather than using
Git on it:

```bash
ls "$IMPL/.sane/workstreams/$WORKSTREAM"
cat "$IMPL/.sane/current-workstream"
```

## Update Installed Agent Context

After changing Alpha agent configurations or role skills, reinstall them and
restart OpenCode:

```bash
sane-alpha install-context-packages --overwrite
```

Reinstalling does not remove typed skill directories installed by earlier Alpha
versions. Remove those directories only if you explicitly choose to clean them
up.

The same non-deletion rule retains old installed
`sane-assistant-execution.md` and `sane-execution-assistant-role/`. Inspect and
manually clean up those paths after preserving local customizations, and rename
custom model key `sane-assistant-execution` to `sane-assistant-planning` before
installation. See [Planning migration](./SANE_AGENT_CONTEXT_PACKAGES.md#planning-migration)
for exact paths, model choices, and existing-workstream template guidance.
