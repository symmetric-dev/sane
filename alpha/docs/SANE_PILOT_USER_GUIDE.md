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
sane-alpha install-sane-agent-context-packages
```

Pair the implementation repository with its local workstream repository:

```bash
sane-alpha init-sane-repository "$IMPL"
```

## Start a Workstream

Create and select a new workstream in the paired workstream repository:

```bash
sane-alpha create-sane-repository-workstream "$IMPL" "$WORKSTREAM"
```

This creates the initial Product documents and the local Implementation Report
Section Spec, and Job templates at:

```text
resources/IMPLEMENTATION_REPORT_TEMPLATE.md
resources/SECTION_SPEC_TEMPLATE.md
resources/JOB_TEMPLATE.md
```

Start the appropriate SANE role agent in OpenCode. Product begins with the
bootstrapped `PRD.md`.

## Provision Role Artifacts

Run a command immediately before starting the corresponding role session:

```bash
# Research
sane-alpha provision-sane-role "$IMPL" research --workstream "$WORKSTREAM"

# Root Design
sane-alpha provision-sane-role "$IMPL" design --workstream "$WORKSTREAM"

# Stage Design
sane-alpha provision-sane-role "$IMPL" stage-design \
  --workstream "$WORKSTREAM" --stage 01-foundation

# Engineering
sane-alpha provision-sane-role "$IMPL" engineering \
  --workstream "$WORKSTREAM" --stage 01-foundation

# Execution
sane-alpha provision-sane-role "$IMPL" execution \
  --workstream "$WORKSTREAM" --stage 01-foundation
```

The Implementation Assistant creates each Job's report from the workstream-local
template; there is no report-provisioning command.

## Resume Another Workstream

Select an existing workstream before starting a new SANE role session:

```bash
sane-alpha select-sane-workstream "$IMPL" "$WORKSTREAM"
```

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
sane-alpha install-sane-agent-context-packages --overwrite
```
