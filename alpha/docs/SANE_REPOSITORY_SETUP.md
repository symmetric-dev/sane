# SANE Alpha Repository Setup

## Purpose

A SANE workstream is not stored in, and does not duplicate, the repository where
its implementation occurs. Each implementation repository keeps its workstreams
in a local, ignored directory inside that same repository.

This document defines the Alpha convention for creating and locating those
workstreams before the first workstream is created.

## Layout

For an implementation repository, its SANE workstreams live at:

```text
<implementation-repository>/.sane/workstreams/<workstream-name>/
```

For example:

```text
~/projects/example-project/                         # implementation repository
~/projects/example-project/.sane/workstreams/        # local workstreams root (ignored)
~/projects/example-project/.sane/workstreams/01-foo/ # one bootstrapped SANE workstream
```

The workstreams root is not a separate Git repository. Its direct children are
SANE workstreams; a workstream is created at a user-selected relative path
inside that root. Repository changes made by implementation agents remain in the
implementation repository.

## Local Reference

The implementation repository records its currently selected workstream in a
local file:

```text
<implementation-repository>/.sane/current-workstream
```

The implementation repository's `.gitignore` must contain:

```gitignore
/.sane/
```

The `.sane/` directory is local-machine coordination data. Do not commit it,
copy it into workstreams, or treat it as a product artifact. No separate paths
file exists: workstream locations are derived from the implementation
repository itself, never from a recorded absolute pairing.

The current-workstream file contains one normalized path relative to
`.sane/workstreams`, followed by a newline; it never contains an absolute
workstream path. It is written only by an explicit selection or a successful
create.

## Initialization

SANE repository initialization is distinct from workstream bootstrap. Run the
initializer with an explicit implementation-repository path:

```bash
sane-alpha init-sane <implementation-repository>
```

Use `--dry-run` to validate the repository and existing local state and print
the planned changes without modifying anything:

```bash
sane-alpha init-sane <implementation-repository> --dry-run
```

The command:

1. resolve the implementation repository's Git root;
2. create or validate `<implementation-repository>/.sane/workstreams/` without
   overwriting unrelated content; and
3. add `/.sane/` to the implementation repository's `.gitignore` without
   removing existing entries.

It does not create a workstream, source or product files, agents, sessions,
branches, or commits. Workstream bootstrap happens later inside
`.sane/workstreams/`.

## Workstream Helpers

After initialization, use the repository-aware creator rather than manually
combining paths and bootstrap templates:

```bash
sane-alpha create-workstream <implementation-repository> <workstream-relative-path> --type <feature|foundation> [--dry-run]
```

`--type` is required. The command validates the target containment, writes the
immutable root `type` file, bootstraps with shared and type-specific templates,
then records the selection only after bootstrap succeeds. To select an existing
bootstrapped workstream instead:

```bash
sane-alpha select-workstream <implementation-repository> <workstream-relative-path> [--dry-run]
```

Both commands support `--dry-run`; selection takes no type argument. A selected
workstream must contain a valid root `type` file, `SANE_CONTEXT.md`,
`PRD.md`, and every bootstrapped `resources/` fallback template.
There is no state file; view state with
`sane-alpha state <implementation-repository> <workstream-relative-path>`.
Those fallbacks include the Implementation Report, Section Spec, Job Spec,
Research Report, root Design, Stage list, Stage Design, Stage
Sections, and Execution Plan templates.

There is no role-artifact CLI command. When a role needs an artifact, it inspects
the selected workstream's `resources/`, creates the artifact's parent directory,
copies the matching local template to its normal destination, then edits the
copy. It never overwrites an existing artifact and preserves required headings
and structure. `PRD.md` and `SANE_CONTEXT.md` are bootstrap-root
artifacts and are edited in place. There is no state file; view state with
`sane-alpha state <implementation-repository> <workstream-relative-path>`.

Research is an append-only archive: completed evidence lives at
`research/<topic>/REPORT.md` (from `resources/RESEARCH_REPORT_TEMPLATE.md`).
Never update a registered report, write a new topic instead.
`research/BASELINE.md`, `RESEARCH_BASELINE_TEMPLATE.md`, the baselines table,
and baseline revisions are retired. The registry is the `research_reports`
table (topic, path, creation time, content hash, commit); inspect it with
`sane-alpha research <implementation-repository> <workstream-relative-path>`
(default `--index` prints presence/status plus unregistered files;
`--register`/`--unregister` record or remove rows). The old `sane-alpha
baseline --record|--recheck` command is gone. Research has no gates: Pickup
surfaces warnings for missing, modified, or unregistered files, and delivery
mismatches on new, edited, or removed reports route to a Design/Engineering
update plus re-approval.

A Research Worker may investigate one bounded external-evidence topic and write
its report and explicitly assigned supporting files beneath `research/<topic>/`.
Only the Research Assistant reconciles the index (`--index`/`--unregister`); a
worker registers its own report only when asked. Engineering may launch a
Research Worker only following an explicit user request for bounded external research in its normal,
unchanged lifecycle; the user may still start a Research Assistant directly.
Research Assistant performs internal repository audits directly and cannot
launch Scout.

## Assistant Use

When a top-level SANE assistant session starts in an implementation repository,
it reads `.sane/current-workstream` for the normalized relative selection and
resolves the selected absolute workstream as
`<implementation-repository>/.sane/workstreams/<current-workstream>`.
If the current pointer or selected workstream type metadata is missing or
invalid, the assistant asks the user to select a valid workstream and stops; it
does not infer or switch one. Its
`SANE_CONTEXT.md`, state viewed via `sane-alpha state`, assigned artifacts, and role skill then
govern the session.

The Coordination Assistant uses the implementation repository root as the Bash
working directory when launching workers. Worker and
review prompts receive only their assigned paths and instructions. They do not
read `.sane/current-workstream` or `SANE_CONTEXT.md`, nor view state via `sane-alpha state`.

A Scout receives a self-contained bounded implementation-repository assignment
from its invoking parent agent, subject to that parent's launch permissions.
Engineering launches it after normal Assistance confirmation; Implementer may
launch only Scout for supporting inspection and retains Job ownership. Because
the workstream lives under the ignored `.sane/` directory, the parent supplies exact artifact paths when they are
needed as context. Scout performs codebase inspection only inside its bounded
implementation scope, reads only those exact external context paths, runs safe
non-destructive commands, writes no files or Research Reports, and returns inline
path-and-line evidence or blockers directly to its parent. Necessary directly
connected implementation inspection may extend beyond starting paths, never
beyond explicit scope or forbidden-path boundaries. It does not discover wider
workstream context or subdelegate.

A Research Worker likewise receives exact paths in one self-contained prompt
with no baseline context;
it does not discover or select workstream context. It has no user Pickup,
Delivery, approval, State update, or questions, and returns a concise result to
its launcher. It researches external evidence and may inspect only exact supplied
local context necessary to understand the question; internal repository
discovery belongs to Scout. It must not make implementation writes, install,
migrate, or deploy. Live-credential or external-system access requires an exact
explicit assignment. This is a
behavioral scope boundary; the documentation does not claim dynamic permissions
can enforce arbitrary prompt-supplied paths.

Planning launches Job Grounder only after explicit breakdown confirmation and
draft Job Spec creation. It supplies the absolute implementation path, bounded
inspection scope, exact read-only context paths, and one assigned Job Spec path
as the only writable file. Grounder enriches that spec and returns findings,
gaps, and limitations; it does not discover `.sane` context, edit application,
Design, plan, or State files, converse with users, approve, or subdelegate.
The Execution phase, `execution/` layout, and resource filenames remain unchanged.
