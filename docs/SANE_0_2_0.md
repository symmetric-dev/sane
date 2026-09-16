# SANE 0.2.0: Single-Scope Workstream Workflow

## Purpose

SANE 0.2.0 replaces the Stage-based Alpha workflow with single-scope
workstreams coordinated through long-lived top-level phase sessions, one git
worktree per workstream, and a per-repo sqlite source of truth with files as
render.

This document defines the workflow model only. It specifies no UI.

It supersedes the Stage-based flow in
[ALPHA_OPERATING_MODEL](./ALPHA_OPERATING_MODEL.md) and
[SANE_MOCK_WORKFLOW](./SANE_MOCK_WORKFLOW.md). The repository layout,
initialization, and selection rules in
[SANE_REPOSITORY_SETUP](./SANE_REPOSITORY_SETUP.md) remain in force except
where this document retires Stage artifacts and renames phase and path
conventions.

Grounding: `scripts/sane-repository.ts` (`SaneRepository`
{`implementationRepository`, `workstreamsRoot`}, `.sane/workstreams/` +
`current-workstream`), `scripts/init-sane-repository.ts`, `create`/`select`
commands, `opencode/agents/sane-assistant-*.md` setup steps
(`.sane/current-workstream` read, role skill read, Pickup/Assistance/Delivery),
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

- Old single `design/SPEC.md` is replaced by the root doc plus `SDD.md`
  below.
- Old planning paths `execution/PLAN.md` and `execution/jobs/*` are retired;
  Planning owns `plan/`; Execution owns `execution/`.
- Old `implementation/` prefix is replaced by `execution/`.
- The former Coordination assistant name is replaced by Execution assistant.
- The old `Implementation` phase label is replaced by Execution.

Workstream layout (new tooling bootstraps this shape):

```text
<workstream>/
  type                    # immutable one-line type file (unchanged)
  PRD.md | FOUNDATION.md | ISSUE.md | MAINTENANCE.md
                          # root doc, exactly one present, fixed per type (Design owns)
  SDD.md                  # Solution Design Document (Design owns)
  solutions/<name>.md     # one comprehensive doc per solution area (Engineering owns)
  SANE_CONTEXT.md         # shared orientation (template copy, edited in place)
  SANE_STATE.md           # rendered state (see section 2; per-repo sqlite is authority)
  research/BASELINE.md    # support-track baseline (support track owns, no gate)
  research/<topic>/REPORT.md
  plan/PLAN.md            # single compact plan (Planning owns)
  plan/jobs/<job-id>-<job-slug>.md
  execution/reports/<job-id>-<job-slug>.md
  execution/BRIEF.md      # single actual-state handoff (Execution owns)
  resources/              # local fallback templates (bootstrap copies only)
```

Workstream types are provisional and may change. Four are defined; the root
doc name is fixed per type and the `type` file is immutable:

- `feature` -> `PRD.md` (problem, users, goals, acceptance).
- `foundation` -> `FOUNDATION.md` (goals, constraints, surfaces, consumers).
- `issue` -> `ISSUE.md` (symptoms, repro, impact, evidence, suspected area;
  includes debug).
- `maintenance` -> `MAINTENANCE.md` (scope, rationale, risk, verification).

`--type` is required at create; select takes no type argument.

Docs chain: Design owns the root doc and `SDD.md`. `SDD.md` is the nexus of
product intent and technical requirements: it always links the root doc
(+ revision / hash) to the Solution Specs in `solutions/<name>.md`.
Engineering owns the Solution Specs (one comprehensive doc per solution
area). Design is the only type-branching agent ("if type X expect doc A
with sections B..."). Downstream roles (Engineering, Planning, Execution,
and the research support track) are type-agnostic: they read only
SDD / Specs / jobs and never branch on `type`.

Foundation work is not a Stage and not a phase inside a feature workstream.
When a workstream depends on foundation outcomes, it declares a revision
precondition: `foundation_rev` records the root-doc revision (or merge
commit, see section 2) of the foundation workstream it builds on. Pickup fails
when the precondition is missing or the referenced foundation revision is
superseded without user re-confirmation. The user owns sequencing between
foundation and dependent workstreams; the CLI enforces nothing beyond
recording and checking the declared precondition.

## 2. Data Model

`sqlite` at `<repo>/.sane/sane.db` is the source of truth: one database per
repository, not one per workstream. Markdown files (`SANE_STATE.md`, root
doc, `SDD.md`, specs, reports) are renders for humans and agent
context. On conflict, the database wins; the renderer regenerates the files.
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
  scope TEXT NOT NULL,           -- one-aspect statement; Design owns via root doc
  status TEXT NOT NULL,          -- open | blocked | done | abandoned
  foundation_rev TEXT,           -- NULL or "<workstream-id>@<revision>"
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
  gate TEXT NOT NULL,            -- root-plus-sdd | solutions | plan | jobs-batch | merge
  artifact_path TEXT NOT NULL,
  sane_hash TEXT NOT NULL,       -- content hash of the approved artifact
  git_commit TEXT,               -- NULL when the workflow is not git-backed
  approval_ref TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  PRIMARY KEY (repo_root, user, workstream_id, gate)
);
-- Columns exist in the model now. No enforcement or auto-revoke on hash
-- mismatch yet; that behavior is explicitly left room for.

baselines(
  repo_root TEXT NOT NULL,
  user TEXT NOT NULL,
  workstream_id TEXT NOT NULL,
  revision INTEGER NOT NULL,     -- incremented by the support track on each update
  path TEXT NOT NULL,            -- research/BASELINE.md
  PRIMARY KEY (repo_root, user, workstream_id)
);

research_reports(
  repo_root TEXT NOT NULL,
  user TEXT NOT NULL,
  workstream_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  baseline_rev INTEGER NOT NULL, -- baseline revision this report was written against
  path TEXT NOT NULL,
  PRIMARY KEY (repo_root, user, workstream_id, topic)
);

jobs(
  repo_root TEXT NOT NULL,
  user TEXT NOT NULL,
  workstream_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  spec_path TEXT NOT NULL,       -- plan/jobs/<job-id>-<job-slug>.md
  report_path TEXT,              -- execution/reports/<job-id>-<job-slug>.md
  status TEXT NOT NULL,          -- planned | authorized | running | reported | reviewed | accepted
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
- Job `status`: `planned`, `authorized`, `running`, `reported`, `reviewed`,
  `accepted`. `planned` becomes `authorized` only by explicit user approval of
  the plan package; `accepted` only by explicit user acceptance of the outcome.

### Ownership and approval gates

Each artifact has exactly one writer role; all other roles read it:

- Design Assistant: root doc (`PRD.md` | `FOUNDATION.md` | `ISSUE.md` |
  `MAINTENANCE.md`), `SDD.md`, Design `state_entries`.
- Engineering Assistant: `solutions/<name>.md`, Engineering `state_entries`.
- Planning Assistant: `plan/PLAN.md`, `plan/jobs/*`, `jobs` rows
  (`planned`), Planning `state_entries`. Sole editor of plans and Job Specs,
  including factual corrections.
- Execution Assistant: `execution/reports/*` (via Implementer workers),
  `execution/BRIEF.md`, `jobs` status transitions from `running` onward,
  `merges` row, Execution `state_entries`. Implementer workers stay
  worker-level under this assistant; they never own phase sessions.
- Research support track: `research/BASELINE.md`, `baselines.revision`,
  `research_reports` rows for its workstream (topic work may be drafted by
  bounded workers; only the track coordinator commits the baseline row).
  No gate semantics.
- User: approvals only. No role self-approves.

Approval gates (user action required, recorded as `approval_ref` plus
`sane_hash` in `approvals` and a `[✓] Approved` note in the `SANE_STATE.md`
render):

1. Root doc plus SDD (Design).
2. Solution Specs (Engineering).
3. Plan package (`plan/PLAN.md` + all Job Specs; authorizes Jobs but does
   not start execution).
4. Job outcomes (per batch; accepts results or authorizes retry/fix).
5. Merge (authorizes the `sane/<user>/<workstream>` merge into main).

Pickup records consumed revisions (baseline `revision`, SDD revision,
solution revisions, `foundation_rev`, `sane_hash` values). Delivery rechecks
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
any phase with no gate semantics. A phase assistant (or the user) starts a
track session for a bounded topic; the track reads SDD / Specs / jobs and
returns evidence to its launcher. Track sessions never gate phase progress.

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
baseline, superseded foundation, conflicting merge). Roles never steer each
other for routine handoffs.

### Handoff message shape

Handoff messages are compact references, never pasted artifact contents. The
target session reads the artifacts itself during Pickup:

```text
From: <slot> (<session_id>) / <user> / workstream <workstream-id>
To: <slot> (<session_id or "new">)
Approvals: <gate name + approval_ref + sane_hash, if any>
Revisions: baseline r<revision>, sdd r<revision>, solutions <name>@<rev>, foundation <id>@<rev>
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
7. Record `merge_commit` in the `merges` table; render into `SANE_STATE.md`.
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
  `<implementation-repository> <workstream-relative-path>` signatures.
- No auto-advance. Handoffs, approvals, merges, and session switches require
  explicit user action.
- No hash enforcement yet. `approvals` records `sane_hash` (and nullable
  `git_commit`) but nothing auto-revokes on mismatch; enforcement is future
  work.
- No Research phase. Research is a support track with no gate semantics.

## Appendix A. `sane` CLI

A new minimal `sane` CLI carries forward v1 (`packages/workstreams`) idioms
(`--repo-root` detection, `--json`, atomic writes, hash-on-approve) with a
narrow scope. It absorbs manual in-chat tasks over time; the full manual-task
mapping lives in chat as T0-T25.

- P0: `init`, `create`, `select`, `state`, `artifact`, `pickup`, `status`.
  Bootstrap the repo, create/select a typed workstream, render state,
  copy templates to artifact destinations, run pickup checks (including
  `foundation_rev`), and report status.
- P1: approvals, baseline record/recheck, session registry, handoff
  compose/send. Record `sane_hash` (+ nullable `git_commit`) on approval,
  record and recheck baseline revisions, read/update the
  `(repo, user, workstream, slot)` registry, and compose/send the compact
  queue-default handoff prompt.
- P2: worktree/merge. Create the namespaced worktree and branch, then run
  the section-4 protocol (rebase, checks, review, user merge approval,
  `--no-ff`, main checks, record, cleanup).
