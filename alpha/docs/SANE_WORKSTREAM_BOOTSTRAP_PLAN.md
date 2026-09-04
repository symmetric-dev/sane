# SANE Alpha Workstream Bootstrap Plan

## Goal

Provide one Alpha-era command that safely creates a new SANE workstream from
the maintained templates, plus an installer that makes that command available
on the user's machine.

This is convenience tooling for the manual Alpha workflow. It does not select
agents, move work between roles, approve work, or implement V2 CLI behavior.

## Proposed Commands

The source command is a Bun script in this Alpha directory:

```bash
bun alpha/scripts/create-sane-workstream.ts <workstream-path>
```

An installation script creates a machine-local command alias:

```bash
bun alpha/scripts/install-sane-alpha.ts
```

The installed command is proposed as:

```bash
sane-alpha create <workstream-path>
```

`sane-alpha` is a command wrapper rather than a shell-specific `alias`. The
installer should place it in a user-local executable directory, proposed as
`~/.local/bin/`, so it works from all shells without editing shell startup
files. If that directory is not on `PATH`, the installer reports the exact
user-owned `PATH` change rather than modifying shell configuration silently.

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
4. Create the initial standard directories:
   ```text
   resources/
   docs/
   research/
   design/
   execution/
   implementation/
   ```
5. Print every created path and the next manual action: start a Product
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

The installer will create or replace only the dedicated `sane-alpha` wrapper in
the chosen user-local binary directory. The wrapper invokes the maintained
source command with Bun and forwards all arguments.

The installer must:

1. Resolve and validate the Alpha source directory and Bun executable.
2. Create the chosen binary directory when needed.
3. Refuse to replace an unrelated existing `sane-alpha` executable.
4. Write or update the wrapper only when it is already SANE-managed or the user
   explicitly allows replacement.
5. Mark the wrapper executable.
6. Report the installed location, source location, and whether the binary
   directory is on `PATH`.

The wrapper points to this checkout's Alpha script. If the checkout moves or is
removed, the user reruns the installer from its new location.

## Implementation Sequence

1. Create the copyable `PRD.md` template and simplify `SANE_STATE.md` so it has
   no placeholder Stage or Job entries.
2. Implement `create-sane-workstream.ts` with destination/template validation,
   safe creation, and clear output.
3. Implement `install-sane-alpha.ts` and its managed `sane-alpha` wrapper.
4. Add a dry-run mode and automated temporary-directory tests for bootstrap
   success, existing-destination refusal, missing-template refusal, and wrapper
   installation safety.
5. Manually install the wrapper, create a sample workstream, and begin the
   Product workflow.

## Open Decisions

- Confirm `sane-alpha` as the installed command name.
- Confirm whether the bootstrap should support a user-selected binary directory
  in addition to the default `~/.local/bin`.
- Decide whether initial empty directories should be retained in Git by a
  placeholder file when a workstream is version controlled.
