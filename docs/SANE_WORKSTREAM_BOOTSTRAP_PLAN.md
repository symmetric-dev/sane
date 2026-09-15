# SANE Alpha Workstream Bootstrap Plan

## Goal

Provide one Alpha-era command that safely creates a new SANE workstream from
the maintained templates, plus an installer that makes that command available
on the user's machine.

This is convenience tooling for the manual Alpha workflow. It does not select
agents, move work between roles, approve work, or implement V2 CLI behavior.

## Commands

The low-level bootstrap source command remains available for development:

```bash
bun alpha/scripts/create-sane-workstream.ts <workstream-path> --type <feature|foundation> [--dry-run]
```

Install the machine-local dispatcher from the checkout:

```bash
bun alpha/scripts/install-sane-alpha.ts
```

The installed command exposes the repository-aware pilot utilities:

```bash
sane-alpha init-sane <implementation-repository> [--dry-run]
sane-alpha create-workstream <implementation-repository> <workstream-relative-path> --type <feature|foundation> [--dry-run]
sane-alpha select-workstream <implementation-repository> <workstream-relative-path> [--dry-run]
sane-alpha install-context-packages [--dry-run] [--overwrite] [--model-config <path>]
sane-alpha sane-path <implementation-repository>
```

`sane-alpha` is a command wrapper rather than a shell-specific `alias`. The
installer places it in `~/.local/bin/` by default, or a selected `--bin-dir`,
without editing shell startup files. If that directory is not on `PATH`, the
installer reports the exact user-owned `PATH` change.

## Bootstrap Output

For a new, previously nonexistent workstream path, the bootstrap command will:

1. Validate the required `feature` or `foundation` type, create the workstream
   root, and write its immutable plain-text `type` file.
2. Copy the shared context and State templates to:
   ```text
   <workstream>/SANE_CONTEXT.md
   <workstream>/SANE_STATE.md
   ```
3. Copy the type-specific Product root template to `PRD.md`:
     ```text
     <workstream>/PRD.md
   ```
4. Copy the local fallback templates to:
    ```text
    <workstream>/resources/IMPLEMENTATION_REPORT_TEMPLATE.md
    <workstream>/resources/STAGE_IMPLEMENTATION_BRIEF_TEMPLATE.md
    <workstream>/resources/SECTION_SPEC_TEMPLATE.md
    <workstream>/resources/JOB_TEMPLATE.md
    <workstream>/resources/RESEARCH_REPORT_TEMPLATE.md
    <workstream>/resources/RESEARCH_BASELINE_TEMPLATE.md
    <workstream>/resources/ROOT_DESIGN_SPEC_TEMPLATE.md
    <workstream>/resources/STAGES_TEMPLATE.md
    <workstream>/resources/STAGE_DESIGN_SPEC_TEMPLATE.md
    <workstream>/resources/STAGE_SECTIONS_TEMPLATE.md
    <workstream>/resources/EXECUTION_PLAN_TEMPLATE.md
    ```
5. Create the initial standard directories:
   ```text
   resources/
   docs/
   research/
   design/
   execution/
   implementation/
   ```
6. Print every created path and the next manual action: start a Product
   Assistant session for the new workstream.

The bootstrap command does not create Research, Design, Stage, Execution, Job,
Implementation Report, or Stage Implementation Brief artifacts. Its
`resources/` copies are the sole creation mechanism for those artifacts: the
owning role inspects `resources/`,
creates the destination parent directory, copies the matching local template,
then edits the copy. Roles never overwrite an existing artifact and preserve
the copied template's required headings and structure.

## Templates

The bootstrap command copies version-controlled Alpha templates; it does not
generate their contents from document definitions at runtime.

Required source templates are:

```text
alpha/templates/shared/SANE_CONTEXT.md
alpha/templates/shared/SANE_STATE.md
alpha/templates/shared/implementation/REPORT.md
alpha/templates/shared/implementation/STAGE_BRIEF.md
alpha/templates/shared/design/section/SPEC.md
alpha/templates/shared/execution/JOB.md
alpha/templates/shared/research/REPORT.md
alpha/templates/shared/research/BASELINE.md
alpha/templates/shared/design/STAGES.md
alpha/templates/shared/design/stage/SPEC.md
alpha/templates/shared/design/stage/SECTIONS.md
alpha/templates/shared/execution/EXECUTION_PLAN.md
alpha/templates/feature/PRD.md
alpha/templates/feature/design/SPEC.md
alpha/templates/foundation/PRD.md
alpha/templates/foundation/design/SPEC.md
```

`SANE_STATE.md` must start with the Workstream Foundation structure and empty
Workstream Stages and Workstream Implementation sections. Stage and Job entries
are added only after the workstream establishes their existing identities.

The Research templates map to `resources/RESEARCH_REPORT_TEMPLATE.md` and the
single `resources/RESEARCH_BASELINE_TEMPLATE.md`. A Research session has one
assigned scope. Non-Stage and cross-Stage work uses `research/workstream/`; Stage
work uses `research/stage-NN/`. Each scope places its baseline at `BASELINE.md`
and topic evidence at `<topic>/REPORT.md`.

Feature root Design is sourced from `alpha/templates/feature/design/SPEC.md`;
foundation root Design is sourced from
`alpha/templates/foundation/design/SPEC.md`. Other reusable material is under
`alpha/templates/shared/`. Destination paths remain conventional: `PRD.md` at
the root and `design/SPEC.md` for root Design. Foundation durable decisions
belong only in that `design/SPEC.md`, not in a
`FOUNDATION_DECISIONS.md` file.

## Safety Rules

- Refuse to create a workstream when the destination already exists.
- Never overwrite a destination file.
- Validate that every required source template exists before creating output.
- If validation fails, create nothing.
- Use the supplied target path as the only destination; do not infer or alter a
  target repository.
- Do not create Git worktrees, branches, commits, configuration files, or agent
  sessions.

## Command Installation

The installer creates only the dedicated `sane-alpha` wrapper in the chosen
user-local binary directory. The wrapper imports the checked-out dispatcher by
absolute file URL with Bun and forwards all arguments.

The installer must:

1. Resolve and validate the Alpha dispatcher source file.
2. Create the chosen binary directory when needed.
3. Refuse to replace an unrelated existing `sane-alpha` executable.
4. Write or update the wrapper only when its contents are already SANE-managed
   or the user explicitly allows replacement with `--overwrite`.
5. Mark a created or updated wrapper executable.
6. Report the installed location, source location, and whether the binary
   directory is on `PATH`.

The wrapper points to this checkout's Alpha script. If the checkout moves or is
removed, the user runs the installer from its new location with `--overwrite`.

## Implementation Sequence

The implemented bootstrap uses the type-aware command above. It validates all
required template sources before writing output, refuses an existing destination,
and supports `--dry-run`. The repository-aware command selects a successfully
created workstream only after creation completes.

## Open Decisions

- Decide whether initial empty directories should be retained in Git by a
  placeholder file when a workstream is version controlled.
