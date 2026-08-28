# Workstream Repository Layout

## Purpose

This document defines the V2 location and ownership model for workstream
state. It is a breaking change from the V1 in-repository `work/` directory.
There is no compatibility mode or migration path.

V2 deliberately does not consider migration of V1 state, documents, or active
workstreams. That work is excluded to keep the redesign simple and avoid
over-engineering around a model that V2 replaces.

The `work` executable name remains unchanged because it is concise and widely
referenced. New option names and documentation should use the more specific
term **workstreams** where that avoids ambiguity.

## Core model

Every source Git repository has a separate, local Git repository that stores
its workstream documents, configuration, and structured state.

```text
<source repository>/                 # implementation and tests
~/workstreams/<source-repository-id>/ # workstream state and documents
  .git/
  db.sqlite
  agents.yaml
  github.json
  <workstream-id>/
```

The source repository and workstream repository have different purposes:

- **Source repository:** the repository where agents implement changes, run
  tests, invoke Git for implementation work, and where OpenCode sessions run.
- **Workstream repository:** local storage for workstream planning documents,
  management artifacts, configuration, and workstream state. It must not be
  used as the implementation working directory.

This model eliminates wrapper repositories, nested repositories, and Git
submodules from the workstream setup.

## Resolution and naming

### Workstreams root

The default parent directory is:

```text
~/workstreams
```

`WORKSTREAMS_ROOT` overrides that default. Commands must create the configured
root directory when initialization requires it.

`work init --workstreams-dir <path>` explicitly selects the full workstream
repository directory for one source repository. This option uses
`workstreams`, not the overloaded term `work`. Its value takes precedence over
`WORKSTREAMS_ROOT` for that initialization.

### Source repository identity

A workstream repository name must be derived from the source repository's Git
remote identity, not merely its directory basename. A basename such as `api`,
`app`, or `sane` is not globally unique on one machine.

For V2, `work init` fails if the source repository has no usable remote. We do
not provide a path-hash fallback or other local-only naming scheme in this
version. The exact normalization of remote identity into a filesystem-safe
`<source-repository-id>` is an implementation detail, but it must be stable,
deterministic, and distinguish remote host plus repository namespace and name.

For example, a repository identified as `github.com/acme/sane` may map to a
filesystem-safe directory such as:

```text
~/workstreams/github.com--acme--sane/
```

The initialized workstream repository must store its associated source remote
and canonical source path as metadata. Initialization must fail rather than
silently reuse a directory associated with a different source repository.

## Command behavior

All normal commands continue to identify the source repository from the
current directory, or from `--repo-root` where supported. They then resolve
the associated external workstream repository and read or modify state there.

`work init` must:

1. resolve and validate the source Git repository;
2. require a usable source remote;
3. resolve `WORKSTREAMS_ROOT` or the explicit `--workstreams-dir` value;
4. create the root and target directory when absent;
5. initialize the target as its own Git repository when absent;
6. create V2 configuration and state in that repository; and
7. persist source-repository binding metadata and reject mismatched bindings.

No V1 `work/` directory is created in the source repository.

## Execution safeguard

Execution commands, including `work multi`, must explicitly use the source
repository as their working directory. This applies to the OpenCode server,
every tmux pane and window, Git subprocesses that operate on implementation,
and any retry or supervisor process.

The implementation should make this explicit rather than relying on the
launcher shell's current directory or tmux defaults. A guard should reject an
execution attempt if its resolved execution directory is the workstream
repository instead of the associated source repository.

## Deliberate exclusions

- No migration command, manual migration procedure, or V1 compatibility lookup
  is required.
- No nested wrapper repository is created around the source repository.
- No Git submodule is used to connect source and workstream repositories.
- No support for source repositories without a remote is included in V2.
- The CLI executable remains `work`; renaming it to `workstreams` is out of
  scope.
