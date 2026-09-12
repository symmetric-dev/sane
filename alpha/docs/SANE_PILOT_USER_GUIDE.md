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
sane-alpha install-context-packages
```

Pair the implementation repository with its local workstream repository:

```bash
sane-alpha init-sane "$IMPL"
```

## Start a Workstream

Create and select a new workstream in the paired workstream repository:

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
- Execution: `EXECUTION_PLAN_TEMPLATE.md` →
  `execution/stages/<id>-<slug>/EXECUTION_PLAN.md`; `JOB_TEMPLATE.md` →
  `execution/stages/<id>-<slug>/jobs/<id>-<slug>.md`.
- Implementation: `IMPLEMENTATION_REPORT_TEMPLATE.md` →
  `implementation/reports/<stage-id>-<stage-slug>/<job-id>-<job-slug>.md`; after
  all authorized Jobs are completed and reviewed,
  `STAGE_IMPLEMENTATION_BRIEF_TEMPLATE.md` →
  `implementation/briefs/STAGE_<two-digit-id>.md`.

`PRD.md`, `SANE_CONTEXT.md`, and `SANE_STATE.md` are bootstrap-root artifacts;
their owning roles edit them in place.

Topic `REPORT.md` files are authoritative evidence. A Research session has one
assigned workstream or Stage scope, and only its coordinator updates that
scope's baseline. Delegated researchers write reports under the assigned scope.
Cross-scope evidence applies only when the consuming baseline explicitly links
it. Root Design reads the workstream baseline; Stage Design reads its assigned
Stage baseline. Research consumers capture that baseline's revision at Pickup
and recheck it at Delivery. Approved Design remains implementation authority,
so a material Research conflict requires a Design Update and approval.

## Resume Another Workstream

Select an existing workstream before starting a new SANE role session:

```bash
sane-alpha select-workstream "$IMPL" "$WORKSTREAM"
```

Selection takes no type argument and rejects a workstream with missing or
unsupported root `type` metadata.

## Run Git in the SANE Workstream Repository

`sane-path` prints the paired SANE workstream repository's validated absolute
path. It does not point at an individual workstream directory. Compose it with
Git rather than using a SANE Git proxy:

```bash
git -C "$(sane-alpha sane-path "$IMPL")" status
git -C "$(sane-alpha sane-path "$IMPL")" log --oneline
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
