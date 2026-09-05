# SANE Alpha Repository Setup

## Purpose

A SANE workstream is not stored in, and does not duplicate, the repository where
its implementation occurs. Each implementation repository has one separate,
local SANE workstream repository that contains all of its workstreams.

This document defines the Alpha convention for creating and locating that
workstream repository before the first workstream is created.

## Layout

For an implementation repository named `<project-name>`, its SANE workstream
repository is:

```text
~/workstreams/<project-name>-work/
```

For example:

```text
/Users/beto/sane/                 # implementation repository
~/workstreams/sane-work/           # separate Git workstream repository
  <workstream-name>/                # one bootstrapped SANE workstream
```

The workstream repository is a Git repository. Its direct children are SANE
workstreams; a workstream is created at a user-selected path inside that
repository. Repository changes made by implementation agents remain in the
implementation repository.

## Local Repository Reference

The implementation repository records its local workstream-repository location
in an ignored file:

```text
<implementation-repository>/.sane/paths
```

The implementation repository's `.gitignore` must contain:

```gitignore
/.sane/
```

The `.sane/` directory is local-machine coordination data. Do not commit it,
copy it into workstreams, or treat it as a product artifact.

Initialization creates `paths` from
[`templates/repository/paths`](./templates/repository/paths). Its exact plain-text
schema is:

```text
implementation-path: /absolute/path/to/project
workstream-repository-path: /absolute/path/to/project-work
```

Both paths are normalized absolute local paths. When either repository moves,
the user updates this local file; an assistant must not infer, relocate, or
rewrite the paths without the user's direction.

The currently selected workstream is separate local state at:

```text
<implementation-repository>/.sane/current-workstream
```

It contains one normalized path relative to `workstream-repository-path`,
followed by a newline; it never contains an absolute workstream path. It is
written only by an explicit selection or a successful repository-aware create.

## Initialization

SANE repository initialization is distinct from workstream bootstrap. Run the
initializer with an explicit implementation-repository path:

```bash
sane-alpha init-sane-repository <implementation-repository>
```

Use `--dry-run` to validate the repository, template, and existing local state
and print the planned changes without modifying either repository:

```bash
sane-alpha init-sane-repository <implementation-repository> --dry-run
```

The command:

1. resolve the implementation repository's Git root and project name;
2. create or validate `~/workstreams/<project-name>-work/` as its separate Git
   workstream repository without overwriting unrelated content;
3. create `.sane/paths` with the two absolute paths; and
4. add `/.sane/` to the implementation repository's `.gitignore` without
   removing existing entries.

It does not create a workstream, source or product files, agents, sessions,
branches, or commits. Workstream bootstrap happens later inside the recorded
workstream repository.

## Workstream Helpers

After initialization, use the repository-aware creator rather than manually
combining the paths record and bootstrap paths:

```bash
sane-alpha create-workstream <implementation-repository> <workstream-relative-path>
```

It validates the paths record and target containment, bootstraps with the standard
templates, then records the selection only after the bootstrap succeeds. To
select an existing bootstrapped workstream instead:

```bash
sane-alpha select-sane-workstream <implementation-repository> <workstream-relative-path>
```

Both commands support `--dry-run`. A selected workstream must contain
`SANE_CONTEXT.md`, `SANE_STATE.md`, `PRD.md`, and
`resources/IMPLEMENTATION_REPORT_TEMPLATE.md` and
`resources/SECTION_SPEC_TEMPLATE.md` and `resources/JOB_TEMPLATE.md`.

Provision only the approved role-start documents with:

```bash
sane-alpha provision-sane-role <implementation-repository> <research|design|stage-design|engineering|execution> [--workstream <relative-path>] [--stage <two-digit-id>-<slug>]
```

Without `--workstream`, provision uses `current-workstream`. Stage roles require
`--stage`; all provisioned destinations must be new. The command supports
`--dry-run` and deliberately does not create Product, Implementation report,
Section Spec, or Job documents.

## Assistant Use

When a top-level SANE assistant session starts in an implementation repository,
it reads `.sane/paths` to locate the workstream repository and
`.sane/current-workstream` for the normalized relative selection. The selected
absolute workstream is `<workstream-repository-path>/<current-workstream>`.
If the current pointer is missing or invalid, the assistant asks the user to
select a workstream and stops; it does not infer or switch one. Its
`SANE_CONTEXT.md`, `SANE_STATE.md`, assigned artifacts, and role skill then
govern the session.

The Implementation Assistant uses the recorded `implementation-path` as
the Bash working directory when launching Cursor. Cursor implementation and
review prompts receive only their assigned paths and instructions. They do not
read `.sane/paths`, `SANE_CONTEXT.md`, or `SANE_STATE.md`.
