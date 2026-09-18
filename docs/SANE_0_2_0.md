# SANE 0.2.0: Single-Scope Workstream Workflow

## Purpose

SANE 0.2.0 replaces the Stage-based Alpha workflow with single-scope
workstreams coordinated through long-lived top-level phase sessions, one git
worktree per workstream, and a per-repo sqlite source of truth with files as
render.

This document defines the workflow model only. It specifies no UI.

It supersedes the Stage-based flow in
[ALPHA_OPERATING_MODEL](./_legacy/ALPHA_OPERATING_MODEL.md) and
[SANE_MOCK_WORKFLOW](./_legacy/SANE_MOCK_WORKFLOW.md). The repository layout,
initialization, and selection rules in
[SANE_REPOSITORY_SETUP](./SANE_REPOSITORY_SETUP.md) remain in force except
where this document retires Stage artifacts and renames phase and path
conventions.

Grounding: `packages/sane-cli/src/sane-repository.ts` (`SaneRepository`
{`implementationRepository`, `workstreamsRoot`}, `.sane/workstreams/` +
per-user `current_workstreams` row in `.sane/sane.db`),
`packages/sane-cli/src/init-sane-repository.ts`, `create`/`select`
commands, role skill read and Pickup/Assistance/Delivery,
role skills in `skills/*/SKILL.md`, and `docs/SANE_REPOSITORY_SETUP.md`.

Phases are exactly four: Design -> Engineering -> Planning -> Execution.
Research is a support track, not a phase. The CLI appendix sketches how a
minimal `sane` CLI absorbs the current manual tasks over time.

## 1. Workstream Model

A workstream is a single-scope effort at:

```text
<implementation-repository>/.sane/workstreams/<name>/
```

Each workstream owns one aspect or surface (one feature slice, one
architectural surface, one bounded investigation). Parallel workstreams each
own a disjoint aspect; there is no cross-workstream Stage sequencing inside
one workstream.

There is no Stage decomposition. The following are retired and must not
be created by new tooling or roles:

- `design/STAGES.md` and the `resources/STAGES_TEMPLATE.md` fallback;
- `design/stages/<stage>/SPEC.md` and Stage Sections (`SECTIONS.md`, Section
  Specs) as Stage-scoped artifacts;
- `research/stage-NN/BASELINE.md` and per-Stage topic report trees;
- `execution/stages/<stage>/EXECUTION_PLAN.md` and per-Stage Job trees;
- `implementation/briefs/STAGE_NN.md` and Stage baselines/briefs/plans.

Retired naming (do not create; remap on sight):

- Old single `design/SPEC.md` is replaced by the root doc plus `design/SDD.md`
  below.
- Old planning paths `plan/PLAN.md` and `plan/jobs/*` are retired;
  Planning owns `execution/PLAN.md` and `execution/jobs/`; Execution owns
  `execution/FINAL_REPORT.md` and `execution/reports/`.
- Old top-level `SDD.md`, `solutions/`, `SANE_CONTEXT.md`, `execution/BRIEF.md`,
  and the `type` file are retired; use `design/SDD.md`, `design/solutions/`,
  `README.md`, `execution/FINAL_REPORT.md`, and sqlite `workstreams.type`.
- Old `implementation/` prefix is replaced by `execution/`.
- The former Coordination assistant name is replaced by Execution assistant.
- The old `Implementation` phase label is replaced by Execution.

Workstream layout (new tooling bootstraps this shape):

```text
<workstream>/
  README.md                 # shared orientation (template copy, edited in place)
                          # state is viewed via `sane view` (no state file on disk; per-repo sqlite is authority)
  PRD.md | FOUNDATION.md | ISSUE.md | MAINTENANCE.md
                          # root doc, exactly one present, fixed per type (Design owns)
  design/SDD.md           # Solution Design Document (Design owns)
  design/solutions/<name>.md # one comprehensive doc per solution area (Engineering owns)
  research/<topic>/REPORT.md # append-only evidence (research owns registry)
  execution/PLAN.md       # single compact plan (Planning owns)
  execution/jobs/<job-id>-<job-slug>.md
  execution/reports/<job-id>-<job-slug>.md
  execution/FINAL_REPORT.md # single actual-state handoff (Execution owns)
  resources/              # local fallback templates (bootstrap copies only)
```

Top-level dirs are exactly: design/, execution/, research/, resources/.
There is no top-level SDD.md, solutions/, plan/, planning/, execution/BRIEF.md,
SANE_CONTEXT.md, or `type` file. `type` lives in sqlite only
(workstreams.type column).

Workstream types are provisional and may change. Four are defined; the root
doc name is fixed per type and the `type` value is stored in sqlite
(workstreams.type), not in a file:

- `feature` -> `PRD.md` (problem, users, goals, acceptance).
- `foundation` -> `FOUNDATION.md` (goals, constraints, surfaces, consumers).
- `issue` -> `ISSUE.md` (symptoms, repro, impact, evidence, suspected area;
  includes debug).
- `maintenance` -> `MAINTENANCE.md` (scope, rationale, risk, verification).

`--type` is required at create; select takes no type argument.

Docs chain: Design owns the root doc and `design/SDD.md`. `design/SDD.md` is the nexus of
product intent and technical requirements: it always links the root doc
(+ revision / hash) to the Solution Specs in `design/solutions/<name>.md`.
Engineering owns the Solution Specs (one comprehensive doc per solution
area). Design is the only type-branching agent ("if type X expect doc A
with sections B..."). Downstream roles (Engineering, Planning, Execution,
and the research support track) are type-agnostic: they read only
SDD / Specs / jobs and never branch on `type`.

Foundation work is not a Stage and not a phase inside a feature workstream.
Workstreams never stack: there is no cross-workstream revision precondition.
The user owns sequencing between foundation and dependent workstreams.

## 2. Data Model

`sqlite` at `<repo>/.sane/sane.db` is the source of truth: one database per
repository, not one per workstream. Markdown files (root
doc, `design/SDD.md`, specs, reports) are renders for humans and agent
context. On conflict, the database wins; the renderer regenerates the files.
Workstream state is viewed via `sane view` (stdout render, no state
file on disk).
Every mutation records `(actor_role, session_id, timestamp)`.

Identity: every row is keyed by `(repo_root, user, workstream_id)` so
multiple users on one server and multiple repositories never clash. `repo_root`
is the absolute repository root; `user` is the operating user. Branches are
`sane/<user>/<workstream>` and worktrees are `<dir>/<user>/<workstream>`
(see section 4). `<workstream>` is the normalized relative workstream path
with separators flattened.

### Tables

```sql
workstreams(
  repo_root TEXT NOT NULL,
  user TEXT NOT NULL,
  workstream_id TEXT NOT NULL,  -- normalized relative path under .sane/workstreams/
  type TEXT NOT NULL,            -- feature | foundation | issue | maintenance (sole type authority; no type file)
  status TEXT NOT NULL,          -- open | blocked | done | abandoned (retained, not displayed)
  created_at TEXT NOT NULL,
  PRIMARY KEY (repo_root, user, workstream_id)
);

selections(                      -- session registry / address book
  repo_root TEXT NOT NULL,
  user TEXT NOT NULL,
  workstream_id TEXT NOT NULL,
  slot TEXT NOT NULL,            -- phase (design | engineering | planning | execution)
                                 -- or support-track key (research:<topic>, ...)
  session_id TEXT NOT NULL,      -- top-level OpenCode sessionID for the slot
  worktree_path TEXT,            -- NULL on main; set for execution work
  branch TEXT,                   -- NULL on main; else sane/<user>/<workstream>
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo_root, user, workstream_id, slot)
);
-- Composite key is intentional: it fixes the old single-column phase key
-- that could not distinguish workstreams, repos, or users.

state_entries(
  repo_root TEXT NOT NULL,
  user TEXT NOT NULL,
  workstream_id TEXT NOT NULL,
  phase TEXT NOT NULL,           -- design | engineering | planning | execution
  status TEXT NOT NULL,          -- pending | in_progress | delivered | approved | blocked
  owner_role TEXT NOT NULL,      -- design | engineering | planning | execution
  approval_ref TEXT,             -- user approval note or timestamp; NULL until approved
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo_root, user, workstream_id, phase)
);

approvals(
  repo_root TEXT NOT NULL,
  user TEXT NOT NULL,
  workstream_id TEXT NOT NULL,
  phase TEXT NOT NULL,            -- design | engineering | planning | execution
  artifact_path TEXT NOT NULL,    -- validated file list (comma-joined)
  sane_hash TEXT NOT NULL,       -- composite hash over the validated files
  git_commit TEXT,               -- NULL when the workflow is not git-backed
  approval_ref TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  PRIMARY KEY (repo_root, user, workstream_id, phase)
);
-- Columns exist in the model now. No enforcement or auto-revoke on hash
-- mismatch yet; that behavior is explicitly left room for.

research_reports(                 -- append-only registry of completed reports
  repo_root TEXT NOT NULL,
  user TEXT NOT NULL,
  workstream_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  path TEXT NOT NULL,            -- research/<topic>/REPORT.md
  created_at TEXT NOT NULL,      -- registration timestamp
  sane_hash TEXT NOT NULL,       -- content hash at registration
  git_commit TEXT,               -- NULL when not git-backed
  actor_role TEXT NOT NULL,
  session_id TEXT NOT NULL,
  PRIMARY KEY (repo_root, user, workstream_id, topic)
);

jobs(
  repo_root TEXT NOT NULL,
  user TEXT NOT NULL,
  workstream_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  spec_path TEXT NOT NULL,       -- execution/jobs/<job-id>-<job-slug>.md
  report_path TEXT,              -- execution/reports/<job-id>-<job-slug>.md
  status TEXT NOT NULL,          -- planned | running | completed
  PRIMARY KEY (repo_root, user, workstream_id, job_id)
);

merges(
  repo_root TEXT NOT NULL,
  user TEXT NOT NULL,
  workstream_id TEXT NOT NULL,
  branch TEXT NOT NULL,          -- sane/<user>/<workstream>
  base_rev TEXT NOT NULL,        -- main HEAD the worktree branched from
  merge_commit TEXT,             -- NULL until merged with --no-ff
  PRIMARY KEY (repo_root, user, workstream_id)
);
```

### Status values

- Workstream `status`: `open`, `blocked`, `done`, `abandoned`.
- Phase `state_entries.status`: `pending`, `in_progress`, `delivered`,
  `approved`, `blocked`.
- Job `status`: `planned`, `running`, `completed`. `planned` means
  authorized: planning approval registers every job spec as `planned`. The
  Execution Assistant moves jobs forward (`running`, then `completed`) as
  work proceeds — progress tracking, not per-job gates. Execution approval
  completes any stragglers left outstanding.

### Ownership and approvals

Each artifact has exactly one writer role; all other roles read it:

- Design Assistant: root doc (`PRD.md` | `FOUNDATION.md` | `ISSUE.md` |
  `MAINTENANCE.md`), `design/SDD.md`, Design `state_entries`.
- Engineering Assistant: `design/solutions/<name>.md`, Engineering `state_entries`.
- Planning Assistant: `execution/PLAN.md`, `execution/jobs/*`, `jobs` rows
  (`planned`), Planning `state_entries`. Sole editor of plans and Job Specs,
  including factual corrections.
- Execution Assistant: `execution/reports/*` (via Implementer workers),
  `execution/FINAL_REPORT.md`, `jobs` status transitions from `running` onward,
  `merges` row, Execution `state_entries`. Implementer workers stay
  worker-level under this assistant; they never own phase sessions.
- Research support track: `research/<topic>/REPORT.md` files plus their
  `research_reports` registry rows (topic, path, creation time, content hash,
  commit). Reports are append-only: never update a registered report, write a
  new topic instead. The Research Assistant registers each completed report
  (`sane research --register`) and reconciles the index (`--index` /
  `--unregister`); workers may register their own report only when asked.
  No approval semantics.
- User: approvals only. No role self-approves.

Phase approvals (user action required, recorded as `approval_ref` plus a
composite `sane_hash` in `approvals`, the phase marked `approved` in
`state_entries`, and a `[✓] Approved` note in the `sane view`
render). `sane validate <phase>` checks the phase's documents
(exists, non-empty, no template guidance comments); `sane approve
<phase>` runs the same validation first and refuses on problems:

1. Design (root doc plus design/SDD.md).
2. Engineering (design/solutions specs).
3. Planning (`execution/PLAN.md` + all Job Specs; registers every job
   spec found on disk as `planned`, but does not start execution).
4. Execution (final report plus job reports).

No gates and no per-job approval. Research has no approval at
all.

Pickup records consumed revisions (report hashes, SDD revision,
solution revisions, `sane_hash` values). Delivery rechecks
them; on mismatch the role reconciles or reports instead of delivering
against stale inputs. Approved SDD and Specs remain execution authority;
later research conflicts require a Design or Engineering update and
re-approval before Planning or Execution follows the new direction.

## 3. Session Flow

Each workstream has one long-lived top-level phase session per active phase
(Design, Engineering, Planning, Execution). Phases are never run as
subagents: subagent sessions are invisible to the user and cannot sustain the
chat loop that Pickup, Assistance, Updates, and Delivery require.

Research is not a phase. It is the first support track: kickoff-able from
any phase with no approval semantics. A phase assistant (or the user) starts a
track session for a bounded topic; the track reads SDD / Specs / jobs and
returns evidence to its launcher. Track sessions never block phase progress.

### Handoff mechanism

The handing-off assistant uses its `shell` tool to call the OpenCode server
API directly:

```text
POST /api/session               # only when the target slot has no registered session
POST /api/session/{id}/prompt   # deliver the handoff message to the registered session
```

Queue delivery is the default: the handoff prompt queues behind the target
session's current work. `steer` (interrupting an in-progress turn) is reserved
for two cases only: an explicit user redirect, and an Execution abort (stale
research, superseded foundation, conflicting merge). Roles never steer each
other for routine handoffs.

### Handoff message shape

Handoff messages are compact references, never pasted artifact contents. The
target session reads the artifacts itself during Pickup:

```text
From: <slot> (<session_id>) / <user> / workstream <workstream-id>
To: <slot> (<session_id or "new">)
Approvals: <phase + approval_ref + sane_hash, if any>
Revisions: research <n> report(s), sdd <hash>, solutions <name>@<hash>
Paths: <absolute workstream path>, <artifact paths changed>
Next action: <one sentence>
```

### Session registry

The `selections` table is the address book: `(repo, user, workstream, slot)`
-> `sessionID`, plus the worktree path and branch for execution work. A role
resolves the target sessionID from the registry, creates a session only when
the slot has none, and updates the registry when it does. SessionIDs are
stable across handoffs; a new session for an existing slot requires user
direction. Phase slots are `design`, `engineering`, `planning`, `execution`;
support-track slots look like `research:<topic>`.

### No auto-open

Delivering a handoff prompt does not open or focus the target session in the
user's client. To signal the user, the handing-off assistant renames the
target session (e.g. prefix `[ready] <slot>: <next action>`) via the session
rename API. The user decides when to switch; nothing advances merely because a
handoff was delivered.

## 4. Parallelism

> QUARANTINED FOR PILOT. SANE-managed worktrees (`sane worktree`,
> `sane merge`) are unwired from the dispatcher and untested; the code
> stays in tree. Worktrees are OpenCode-native for the pilot: the user
> selects/creates them in the client, the session (and its subagents, which
> inherit its working directory) runs there, and SANE only *records* the
> foreign path via `sane handoff --worktree-path <dir> --branch <name>`
> so CWD auto-detection resolves it. Revisit after the pilot.

One git worktree plus one branch per active execution workstream:

```text
git -C <implementation-repository> worktree add \
  <worktrees-dir>/<user>/<workstream> -b sane/<user>/<workstream> <base_rev>
```

The branch name is `sane/<user>/<workstream>` where `<workstream>` is the
normalized relative workstream path with separators flattened (e.g.
`01-csv-export`). The `merges` row records the branch and the `base_rev`
(main HEAD at creation). Execution owns worktree and branch lifecycle; no
other role creates them.

The dev server stays on main. Worktrees run isolated checks only (typecheck,
unit tests, lint for the touched surface). No worktree starts a shared dev
server, migration against shared data, or deployment.

### Merge protocol

1. Rebase the workstream branch onto current main inside its worktree;
   resolve conflicts per the rules below.
2. Run the workstream's checks in the worktree (typecheck + affected tests).
3. Read-only review of the diff against the SDD and Job Specs.
4. User approves the merge (gate 5).
5. Merge into main with `git merge --no-ff sane/<user>/<workstream>` from a
   clean main checkout.
6. Run main checks and smoke (typecheck + affected tests + boot check).
7. Record `merge_commit` in the `merges` table; viewable via `sane view`.
8. Remove the worktree (`git worktree remove`) and delete the branch only
   after the merge commit is recorded.

### Conflict rules

- Conflict on the workstream's own surface: the owning Execution session
  resolves in its worktree, re-runs checks, and re-requests review.
- Conflict touching another active workstream's surface: stop. Do not resolve
  unilaterally. The Execution Assistant reports both workstream IDs, the
  overlapping paths, and both `base_rev` values to the user. The user either
  serializes (one workstream merges first; the other rebases after) or splits
  the overlap into a follow-up workstream. Merging over another workstream's
  unmerged surface without its owner's user-directed approval is forbidden.

## 5. Explicit Non-Goals

- No UI. This spec defines workflow, data, sessions, and git mechanics only.
- No Stage model. `STAGES.md`, Stage baselines, Stage briefs, and Stage
  plans are retired, not migrated.
- No separate `~/workstreams` repository. Workstreams live at
  `<implementation-repository>/.sane/workstreams/<name>/` per
  `SANE_REPOSITORY_SETUP.md`.
- No legacy paths file. Absolute pairings are never recorded; locations
  derive from the implementation repository root. The initializer and resolver
  keep rejecting a legacy file of that kind.
- No legacy path CLI argument. `create` and `select` keep their
  `<implementation-repository> <workstream-relative-path>` signatures. CWD
  auto-detection (Appendix A) fills addressing for the other commands only;
  it never supplies `create`'s new path or `select`'s target.
- No auto-advance. Handoffs, approvals, merges, and session switches require
  explicit user action.
- No hash enforcement yet. `approvals` records `sane_hash` (and nullable
  `git_commit`) but nothing auto-revokes on mismatch; enforcement is future
  work.
- No Research phase. Research is a support track with no approval semantics.

## Appendix A. `sane` CLI

A new minimal `sane` CLI carries forward v1 (`packages/workstreams`) idioms
(`--repo-root` detection, `--json`, atomic writes, hash-on-approve) with a
narrow scope. It absorbs manual in-chat tasks over time; the full manual-task
mapping lives in chat as T0-T25.

- P0: `init`, `create`, `select`, `view`, `provide`, `validate`, `status`.
  Bootstrap the repo, create/select a typed workstream, render state,
  provision phase starters, validate phase documents, and report status.
- P1: approvals, research index, session registry, handoff
  compose/send. Validate then record the phase approval (validated file
  list + composite hash), register and index research reports, read/update
  the
  `(repo, user, workstream, slot)` registry, and compose/send the compact
  queue-default handoff prompt.
- P2: worktree/merge. Create the namespaced worktree and branch, then run
  the section-4 protocol (rebase, checks, review, user merge approval,
  `--no-ff`, main checks, record, cleanup).

### Command addressing (CWD auto-detection)

Repository-aware commands address a workstream three ways, in precedence
order:

1. Explicit positionals: `<implementation-repository>
   <workstream-relative-path>`.
2. `--repo-root <path>` plus one positional (the workstream path).
3. Bare invocation (no positionals): the target is auto-detected from the
   current directory with this fallback chain:
   a. CWD inside a checkout containing `.sane/` is a main-repo context:
      repo_root is the git toplevel and the workstream is the per-user
      `current_workstreams` row in `<repo>/.sane/sane.db` (the sole
      authority; no selection file exists). The lookup is strict per-user
      with no cross-user adoption; a missing row errors and names the fix:
      run `select --name <workstream-name>` from the repository root. The
      pointed workstream directory is validated (missing or old-layout
      files fail with re-create guidance).
   b. Otherwise the `git rev-parse --git-common-dir` main-repo candidate is
      tried: when `<candidate>/.sane` exists, its `sane.db` is matched for a
      `selections` row whose `worktree_path` equals the CWD toplevel
      (realpath-resolved on both sides, same repo only). The current OS user
      wins; a single other-user registration is adopted as the effective
      user (an explicit `--user` never falls back). No match, or more than
      one distinct `(user, workstream)` registration, errors and asks for
      explicit args.
   c. Outside any git tree, or anything else ambiguous, errors: explicit
      args required.

Bare invocation is supported by `view`, `status`, `validate`, `approve`,
`provide`, `research`, and `handoff`, which all auto-detect the workstream
from the current directory and take no address arguments. (`init`,
`create`, and `select` run from the repository root with flags instead of
address positionals.) Explicit positionals and `--repo-root` on `view`,
`status`, `research`, and `handoff` always win and behave exactly as
without auto-detection.
