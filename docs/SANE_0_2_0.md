# SANE 0.2.0: Single-Scope Workstream Workflow

## Purpose

SANE 0.2.0 replaces the multi-Stage Alpha workflow with single-scope
workstreams coordinated through long-lived top-level phase sessions, one git
worktree per workstream, and a sqlite source of truth with files as render.

This document defines the workflow model only. It specifies no UI.

It supersedes the Stage-based flow in
[ALPHA_OPERATING_MODEL](./ALPHA_OPERATING_MODEL.md) and
[SANE_MOCK_WORKFLOW](./SANE_MOCK_WORKFLOW.md). The repository layout,
initialization, and selection rules in
[SANE_REPOSITORY_SETUP](./SANE_REPOSITORY_SETUP.md) remain in force except
where this document retires Stage artifacts.

Grounding: `scripts/sane-repository.ts` (`SaneRepository`
{`implementationRepository`, `workstreamsRoot`}, `.sane/workstreams/` +
`current-workstream`, legacy `.sane/paths` rejected),
`scripts/init-sane-repository.ts`, `create`/`select` commands (no `sane-path`),
`opencode/agents/sane-assistant-*.md` setup steps
(`.sane/current-workstream` read, role skill read, Pickup/Assistance/Delivery),
role skills in `skills/*/SKILL.md`, and `docs/SANE_REPOSITORY_SETUP.md`.

## 1. Workstream Model

A workstream is a single-scope effort at:

```text
<implementation-repository>/.sane/workstreams/<name>/
```

Each workstream owns one aspect or surface (one feature slice, one
architectural surface, one bounded investigation). Parallel workstreams each
own a disjoint aspect; there is no cross-workstream Stage sequencing inside
one workstream.

There is no multi-Stage decomposition. The following are retired and must not
be created by new tooling or roles:

- `design/STAGES.md` and the `resources/STAGES_TEMPLATE.md` fallback;
- `design/stages/<stage>/SPEC.md` and Stage Sections (`SECTIONS.md`, Section
  Specs) as Stage-scoped artifacts;
- `research/stage-NN/BASELINE.md` and per-Stage topic report trees;
- `execution/stages/<stage>/EXECUTION_PLAN.md` and per-Stage Job trees;
- `implementation/briefs/STAGE_NN.md` and Stage baselines/briefs/plans.

Workstream layout (new tooling bootstraps this shape):

```text
<workstream>/
  type                    # immutable one-line type file (unchanged)
  PRD.md                  # product direction (Product Assistant owns)
  SANE_CONTEXT.md         # shared orientation (template copy, edited in place)
  SANE_STATE.md           # rendered state (see section 2; sqlite is authority)
  sane.db                 # sqlite source of truth (see section 2)
  design/SPEC.md          # single workstream Design (Design Assistant owns)
  research/BASELINE.md    # single workstream baseline (Research owns)
  research/<topic>/REPORT.md
  execution/PLAN.md       # single compact plan (Planning owns)
  execution/jobs/<job-id>-<job-slug>.md
  implementation/reports/<job-id>-<job-slug>.md
  implementation/BRIEF.md # single actual-state handoff (Coordination owns)
  resources/              # local fallback templates (bootstrap copies only)
```

Foundation work is not a Stage and not a phase inside a feature workstream.
When a workstream depends on foundation outcomes, it declares a revision
precondition: `foundation_rev` records the `design/SPEC.md` revision (or merge
commit, see section 2) of the foundation workstream it builds on. Pickup fails
when the precondition is missing or the referenced foundation revision is
superseded without user re-confirmation. The user owns sequencing between
foundation and dependent workstreams; the CLI enforces nothing beyond
recording and checking the declared precondition.

Workstream `type` behavior (`feature` | `foundation`, immutable root `type`
file, `--type` required at create, no type argument at select) is unchanged
from [WORKSTREAM_TYPES](./WORKSTREAM_TYPES.md).

## 2. Data Model

`sqlite` at `<workstream>/sane.db` is the source of truth. Markdown files
(`SANE_STATE.md`, `PRD.md`, specs, reports) are renders for humans and agent
context. On conflict, the database wins; the renderer regenerates the files.
Every mutation records `(actor_role, session_id, timestamp)`.

### Tables

```sql
workstreams(
  id TEXT PRIMARY KEY,            -- normalized relative path under .sane/workstreams/
  scope TEXT NOT NULL,             -- one-aspect statement; Product owns
  status TEXT NOT NULL,            -- open | blocked | done | abandoned
  foundation_rev TEXT,             -- NULL or "<workstream-id>@<revision>"
  created_at TEXT NOT NULL
);

selections(                       -- session registry / address book
  workstream_id TEXT NOT NULL,
  phase TEXT PRIMARY KEY,          -- product | research | design | planning | coordination
  session_id TEXT NOT NULL,        -- top-level OpenCode sessionID for the phase
  worktree_path TEXT,              -- NULL on main; set for implementation work
  branch TEXT,                     -- NULL on main; else sane/<workstream>
  updated_at TEXT NOT NULL
);

state_entries(
  workstream_id TEXT NOT NULL,
  phase TEXT NOT NULL,             -- product | research | design | planning | implementation
  status TEXT NOT NULL,            -- pending | in_progress | delivered | approved | blocked
  owner_role TEXT NOT NULL,        -- product | research | design | planning | coordination
  approval_ref TEXT,               -- user approval note or timestamp; NULL until approved
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workstream_id, phase)
);

baselines(
  workstream_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,       -- incremented by Research on each baseline update
  path TEXT NOT NULL               -- research/BASELINE.md
);

research_reports(
  workstream_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  baseline_rev INTEGER NOT NULL,   -- baseline revision this report was written against
  path TEXT NOT NULL,
  PRIMARY KEY (workstream_id, topic)
);

jobs(
  workstream_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  spec_path TEXT NOT NULL,         -- execution/jobs/<job-id>-<job-slug>.md
  report_path TEXT,                -- implementation/reports/<job-id>-<job-slug>.md
  status TEXT NOT NULL,            -- planned | authorized | running | reported | reviewed | accepted
  PRIMARY KEY (workstream_id, job_id)
);

merges(
  workstream_id TEXT PRIMARY KEY,
  branch TEXT NOT NULL,            -- sane/<workstream>
  base_rev TEXT NOT NULL,          -- main HEAD the worktree branched from
  merge_commit TEXT                -- NULL until merged with --no-ff
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

- Product Assistant: `PRD.md`, `workstreams.scope`, Product `state_entries`.
- Research Assistant: `research/BASELINE.md`, `baselines.revision`,
  `research_reports` rows for its workstream (topic reports may be drafted by
  bounded Research Workers; only the coordinator commits the baseline row).
- Design Assistant: `design/SPEC.md`, Design `state_entries`.
- Planning Assistant: `execution/PLAN.md`, `execution/jobs/*`, `jobs` rows
  (`planned`), Planning `state_entries`. Sole editor of plans and Job Specs,
  including factual corrections.
- Coordination Assistant: `implementation/reports/*` (via Implementer workers),
  `implementation/BRIEF.md`, `jobs` status transitions from `running` onward,
  `merges` row, Implementation `state_entries`.
- User: approvals only. No role self-approves.

Approval gates (user action required, recorded as `approval_ref` plus a
`[✓] Approved` note in the `SANE_STATE.md` render):

1. Product delivery (`PRD.md` bounded outcome + acceptance evidence).
2. Research readiness (baseline revision accepted as Design input).
3. Design (`design/SPEC.md`).
4. Plan package (`execution/PLAN.md` + all Job Specs; authorizes Jobs but does
   not start implementation).
5. Job outcomes (per batch; accepts results or authorizes retry/fix).
6. Merge (authorizes the `sane/<workstream>` merge into main).

Pickup records consumed revisions (baseline `revision`, Design revision,
`foundation_rev`). Delivery rechecks them; on mismatch the role reconciles or
reports instead of delivering against stale inputs. Approved Design remains
implementation authority; later Research conflicts require a Design Update and
re-approval before Planning or Coordination follows the new direction.

## 3. Session Flow

Each workstream has one long-lived top-level phase session per active phase
(Product, Research, Design, Planning, Coordination). Phases are never run as
subagents: subagent sessions are invisible to the user and cannot sustain the
chat loop that Pickup, Assistance, Updates, and Delivery require.

### Handoff mechanism

The handing-off assistant uses its `shell` tool to call the OpenCode server
API directly:

```text
POST /api/session            # only when the target phase has no registered session
POST /api/session/{id}/prompt  # deliver the handoff message to the registered session
```

Queue delivery is the default: the handoff prompt queues behind the target
session's current work. `steer` (interrupting an in-progress turn) is reserved
for two cases only: an explicit user redirect, and a Coordination abort (stale
baseline, superseded foundation, conflicting merge). Roles never steer each
other for routine handoffs.

### Handoff message shape

Handoff messages are compact references, never pasted artifact contents. The
target session reads the artifacts itself during Pickup:

```text
From: <phase> (<session_id>) / workstream <workstream-id>
To: <phase> (<session_id or "new">)
Approvals: <gate name + approval_ref, if any>
Revisions: baseline r<revision>, design r<revision>, foundation <id>@<rev>
Paths: <absolute workstream path>, <artifact paths changed>
Next action: <one sentence>
```

### Session registry

The `selections` table is the address book: `phase -> sessionID` plus the
worktree path and branch for implementation work. A role resolves the target
sessionID from the registry, creates a session only when the phase has none,
and updates the registry when it does. SessionIDs are stable across handoffs;
a new session for an existing phase requires user direction.

### No auto-open

Delivering a handoff prompt does not open or focus the target session in the
user's client. To signal the user, the handing-off assistant renames the
target session (e.g. prefix `[ready] <phase>: <next action>`) via the session
rename API. The user decides when to switch; nothing advances merely because a
handoff was delivered.

## 4. Parallelism

One git worktree plus one branch per active implementation workstream:

```text
git -C <implementation-repository> worktree add \
  <worktrees-dir>/<workstream> -b sane/<workstream> <base_rev>
```

The branch name is `sane/<workstream>` where `<workstream>` is the normalized
relative workstream path with separators flattened (e.g. `01-csv-export`).
The `merges` row records the branch and the `base_rev` (main HEAD at creation).
Coordination owns worktree and branch lifecycle; no other role creates them.

The dev server stays on main. Worktrees run isolated checks only (typecheck,
unit tests, lint for the touched surface). No worktree starts a shared dev
server, migration against shared data, or deployment.

### Merge protocol

1. Rebase the workstream branch onto current main inside its worktree;
   resolve conflicts per the rules below.
2. Run the workstream's checks in the worktree (typecheck + affected tests).
3. Read-only review of the diff against the Design Spec and Job Specs.
4. User approves the merge (gate 6).
5. Merge into main with `git merge --no-ff sane/<workstream>` from a clean
   main checkout.
6. Run main checks and smoke (typecheck + affected tests + boot check).
7. Record `merge_commit` in the `merges` table; render into `SANE_STATE.md`.
8. Remove the worktree (`git worktree remove`) and delete the branch only
   after the merge commit is recorded.

### Conflict rules

- Conflict on the workstream's own surface: the owning Coordination session
  resolves in its worktree, re-runs checks, and re-requests review.
- Conflict touching another active workstream's surface: stop. Do not resolve
  unilaterally. The Coordination Assistant reports both workstream IDs, the
  overlapping paths, and both `base_rev` values to the user. The user either
  serializes (one workstream merges first; the other rebases after) or splits
  the overlap into a follow-up workstream. Merging over another workstream's
  unmerged surface without its owner's user-directed approval is forbidden.

## 5. Explicit Non-Goals

- No UI. This spec defines workflow, data, sessions, and git mechanics only.
- No multi-Stage model. `STAGES.md`, Stage baselines, Stage briefs, and Stage
  plans are retired, not migrated.
- No separate `~/workstreams` repository. Workstreams live at
  `<implementation-repository>/.sane/workstreams/<name>/` per
  `SANE_REPOSITORY_SETUP.md`.
- No `.sane/paths` file. Absolute pairings are never recorded; locations
  derive from the implementation repository root. The initializer and resolver
  keep rejecting a legacy `paths` file.
- No `sane-path` CLI argument. `create` and `select` keep their
  `<implementation-repository> <workstream-relative-path>` signatures.
- No auto-advance. Handoffs, approvals, merges, and session switches require
  explicit user action.
