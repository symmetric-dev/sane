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
resources/SECTION_SPEC_TEMPLATE.md
resources/JOB_TEMPLATE.md
resources/RESEARCH_INDEX_TEMPLATE.md
resources/RESEARCH_TECH_BRIEF_TEMPLATE.md
resources/ROOT_DESIGN_SPEC_TEMPLATE.md
resources/STAGES_TEMPLATE.md
resources/STAGE_DESIGN_SPEC_TEMPLATE.md
resources/STAGE_SECTIONS_TEMPLATE.md
resources/EXECUTION_PLAN_TEMPLATE.md
```

For `--type foundation`, creation instead creates `FOUNDATION.md`; root Design
uses the foundation `design/SPEC.md` template. Start the appropriate SANE role
agent in OpenCode. Product begins with the bootstrapped type-specific root
document. Product and Design require the user to declare `feature` or
`foundation` at session start so their agents load the matching installed skill;
the other roles use shared skills.

## Provision Role Artifacts

Run a command immediately before starting the corresponding role session:

```bash
# Research
sane-alpha provision "$IMPL" research --workstream "$WORKSTREAM"

# Root Design
sane-alpha provision "$IMPL" design --workstream "$WORKSTREAM"

# Stage Design
sane-alpha provision "$IMPL" stage-design \
  --workstream "$WORKSTREAM" --stage 01-foundation

# Engineering
sane-alpha provision "$IMPL" engineering \
  --workstream "$WORKSTREAM" --stage 01-foundation

# Execution
sane-alpha provision "$IMPL" execution \
  --workstream "$WORKSTREAM" --stage 01-foundation
```

The Implementation Assistant creates each Job's report from the workstream-local
template; there is no report-provisioning command.

## Resume Another Workstream

Select an existing workstream before starting a new SANE role session:

```bash
sane-alpha select-workstream "$IMPL" "$WORKSTREAM"
```

Selection takes no type argument and rejects a workstream with missing or
unsupported root `type` metadata. Provisioning derives its template type from
that metadata and has no type override.

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
