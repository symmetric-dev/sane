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
<implementation-repository>/.sane/README.md
```

The implementation repository's `.gitignore` must contain:

```gitignore
/.sane/
```

The `.sane/` directory is local-machine coordination data. Do not commit it,
copy it into workstreams, or treat it as a product artifact.

`README.md` records at least:

```md
# SANE Repository Setup

- Implementation repository: `/absolute/path/to/project`
- Workstream repository: `/absolute/path/to/project-work`
```

Both paths are absolute local paths. When either repository moves, the user
updates this local file; an assistant must not infer, relocate, or rewrite the
paths without the user's direction.

## Initialization

SANE repository initialization is distinct from workstream bootstrap.

An eventual initialization command or script, run by the user from an
implementation repository, must:

1. resolve the implementation repository's Git root and project name;
2. create or validate `~/workstreams/<project-name>-work/` as its separate Git
   workstream repository without overwriting unrelated content;
3. create `.sane/README.md` with the two absolute paths; and
4. add `/.sane/` to the implementation repository's `.gitignore` without
   removing existing entries.

It must not create a workstream, modify product or implementation source files,
or start an agent session. Workstream bootstrap happens later inside the recorded
workstream repository.

## Assistant Use

When a top-level SANE assistant session starts in an implementation repository,
it reads `.sane/README.md` to locate the workstream repository. The user then
selects the relevant workstream; its `SANE_CONTEXT.md`, `SANE_STATE.md`,
assigned artifacts, and role skill govern the session.

The Implementation Assistant uses the recorded implementation-repository path as
the Bash working directory when launching Cursor. Cursor implementation and
review prompts receive only their assigned paths and instructions. They do not
read `.sane/README.md`, `SANE_CONTEXT.md`, or `SANE_STATE.md`.
