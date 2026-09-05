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
bun alpha/scripts/create-sane-workstream.ts <workstream-path>
```

Install the machine-local dispatcher from the checkout:

```bash
bun alpha/scripts/install-sane-alpha.ts
```

The installed command exposes the repository-aware pilot utilities:

```bash
sane-alpha init-sane <implementation-repository>
sane-alpha create-workstream <implementation-repository> <workstream-relative-path>
sane-alpha select-workstream <implementation-repository> <workstream-relative-path>
sane-alpha provision <implementation-repository> <role> [...]
sane-alpha install-context-packages [...]
sane-alpha sane-path <implementation-repository>
```

`sane-alpha` is a command wrapper rather than a shell-specific `alias`. The
installer places it in `~/.local/bin/` by default, or a selected `--bin-dir`,
without editing shell startup files. If that directory is not on `PATH`, the
installer reports the exact user-owned `PATH` change.

## Bootstrap Output

For a new, previously nonexistent workstream path, the bootstrap command will:

1. Create the workstream root.
2. Copy the shared context and State templates to:
   ```text
   <workstream>/SANE_CONTEXT.md
   <workstream>/SANE_STATE.md
   ```
3. Copy the Product template to:
   ```text
   <workstream>/PRD.md
   ```
4. Copy the shared local templates to:
   ```text
   <workstream>/resources/IMPLEMENTATION_REPORT_TEMPLATE.md
   <workstream>/resources/SECTION_SPEC_TEMPLATE.md
   <workstream>/resources/JOB_TEMPLATE.md
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
or Implementation Report artifacts. Their owning roles create and deliver them
when their work begins.

## Templates

The bootstrap command copies version-controlled Alpha templates; it does not
generate their contents from document definitions at runtime.

Required source templates are:

```text
alpha/templates/SANE_CONTEXT.md
alpha/templates/SANE_STATE.md
alpha/templates/PRD.md
alpha/templates/implementation/REPORT.md
alpha/templates/design/section/SPEC.md
alpha/templates/execution/JOB.md
```

`SANE_STATE.md` must start with the Workstream Foundation structure and empty
Workstream Stages and Workstream Implementation sections. Stage and Job entries
are added only after the workstream establishes their existing identities.

The `PRD.md` template must be created from the agreed Product document contract
before the bootstrap command is implemented.

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

1. Create the copyable `PRD.md` template and simplify `SANE_STATE.md` so it has
   no placeholder Stage or Job entries.
2. Implement `create-sane-workstream.ts` with destination/template validation,
   safe creation, and clear output.
3. Implement `install-sane-alpha.ts` and its managed `sane-alpha` wrapper.
4. Add a dry-run mode and automated temporary-directory tests for bootstrap
   success, existing-destination refusal, missing-template refusal, and wrapper
   installation safety.
5. Install the wrapper, create a sample workstream, and begin the Product
   workflow.

## Open Decisions

- Decide whether initial empty directories should be retained in Git by a
  placeholder file when a workstream is version controlled.
