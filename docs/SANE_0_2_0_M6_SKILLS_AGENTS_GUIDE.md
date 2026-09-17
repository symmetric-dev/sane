# SANE 0.2.0 M6 Guide: Skills + Agents Cutover (self-serve)

Source of truth: `docs/SANE_0_2_0.md` (esp. Sections 1-3, Retired naming).
CLI already landed (M1-M5, 184 tests green). This guide covers only what the
CLI cannot do: the 6 assistant agents + 6 role skills + installer manifest.
Workers need path updates only.

## 0. Global rules (apply to every file you touch)

1. Phases are exactly four: Design -> Engineering -> Planning -> Execution.
   Research is a support track, not a phase. No Product phase.
2. Single-scope workstream, no Stage decomposition. Delete every
   `stage`, `Stage`, `STAGES.md`, `SECTIONS.md`, `section spec` reference.
3. New layout (Sec 1):
   `type`, `PRD.md|FOUNDATION.md|ISSUE.md|MAINTENANCE.md` (exactly one),
   `SDD.md`, `solutions/<name>.md`, `SANE_CONTEXT.md`, `SANE_STATE.md`,
   `research/<topic>/REPORT.md`,
   `plan/PLAN.md`, `plan/jobs/<job-id>-<job-slug>.md`,
   `execution/reports/<job-id>-<job-slug>.md`, `execution/BRIEF.md`, `resources/`.
4. Retired (do not reference, do not create):
   `design/STAGES.md`, `resources/STAGES_TEMPLATE.md`,
   `design/stages/*/SPEC.md`, `SECTIONS.md`, `research/stage-NN/BASELINE.md`,
   `research/BASELINE.md`, `resources/RESEARCH_BASELINE_TEMPLATE.md`,
   `execution/stages/*/EXECUTION_PLAN.md`, `implementation/briefs/STAGE_NN.md`,
   `design/SPEC.md` (single), `execution/PLAN.md`, `execution/jobs/*`,
   `implementation/` prefix, `Coordination` name, `Implementation` phase label.
5. `SANE_STATE.md` is a render: DB (`sane.db`) wins. Skills must say
   "record approval via `sane-alpha approve ...`, then re-render with
   `sane-alpha state ...`" — never hand-edit status.
6. Pickup records revisions (SDD hash, solutions hashes, `foundation_rev`,
   approval `sane_hash`) and surfaces research index warnings
   (missing/modified/unregistered files); Delivery rechecks and reconciles
   or reports on mismatch (`sane-alpha pickup`, `sane-alpha status`,
   `sane-alpha research`).
   Approved SDD + Specs stay execution authority.
7. Handoff (Sec 3): compact refs only (From/To/Approvals/Revisions/Paths/Next),
   queue default, steer only for user-redirect + Execution abort, rename target
   `[ready] <slot>: <next>`, no auto-open. CLI: `sane-alpha handoff ...`.
8. Design is the ONLY type-branching role ("if type X expect doc A").
   Engineering / Planning / Execution / Research are type-agnostic: they read
   only SDD / Specs / jobs, never branch on `type`.

## 1. Agent files (`opencode/agents/`)

### 1a. RETIRE `sane-assistant-product.md` — DONE (in `_legacy/`, no successor)

### 1b. RENAME `sane-assistant-coordination.md` -> `sane/assistant/execution.md` — DONE (scaffold; fill body per below)
- Frontmatter `description`: "Coordinates authorized SANE job execution,
  worktrees, read-only reviews, bounded fixes, and the execution brief."
- Body `You are a SANE Execution Assistant Agent.`
- `task:` keep `sane-worker-implementer/reviewer/fixer` only (workers stay
  worker-level, never own phase sessions).
- Setup steps: add (3) "Resolve target session via `selections` registry;
  (4) handoff via `sane-alpha handoff` (queue default); (5) own worktree/branch
  lifecycle (`sane-alpha worktree/merge`), isolated checks only."
- Remove every `Stage` / `STAGE_<NN>` / `implementation/briefs` / `Coordination`.

### 1c. `sane-assistant-design.md`
- `description`: "Owns the typed root doc plus SDD for one single-scope workstream."
- Owns: root doc + `SDD.md` + Design `state_entries`. Only type-branching agent.
- `SDD.md` always links root doc (+ revision/hash) to `solutions/<name>.md`.
- Pickup: root doc + `SANE_STATE.md`; record revisions. Research reports
  surface as index warnings only.
- Delete `design/stages`, `STAGES.md`, `SECTIONS.md` refs.

### 1d. `sane-assistant-engineering.md`
- `description`: "Owns one comprehensive solution spec per solution area."
- Owns: `solutions/<name>.md` only. Type-agnostic. Reads SDD, never `type`.
- Keep Scout (`ask`) + Researcher (`ask`, only on explicit user request).
- Delete `design/stages/*/SECTIONS.md`, `sections/`, Stage split language.

### 1e. `sane-assistant-planning.md` (mostly current, fix paths)
- Owns: `plan/PLAN.md`, `plan/jobs/*`, jobs rows (`planned`). Sole editor
  including factual corrections.
- Replace `execution/stages/<id>-<slug>/EXECUTION_PLAN.md` with `plan/PLAN.md`,
  `execution/stages/.../jobs/` with `plan/jobs/`.
- Keep plan-first breakdown gate + Grounder delegation. Handoff target becomes
  Execution assistant (not Coordination).

### 1f. `sane-assistant-research.md`
- `description`: "Support track: append-only topic evidence. No gates,
  never blocks phases."
- Paths: `research/<topic>/REPORT.md` only
  (`resources/RESEARCH_REPORT_TEMPLATE.md`). `research/BASELINE.md`,
  `resources/RESEARCH_BASELINE_TEMPLATE.md`, the baselines table, and baseline
  revisions are retired; never update a registered report, write a new topic
  instead. Delete `research/workstream/` vs `research/stage-NN/` scope branching.
  Registry is the `research_reports` table (topic, path, creation
  time, content hash, commit); CLI is `sane-alpha research <impl-repo>
  <ws-path> [--index|--register|--unregister]` (default `--index` prints
  presence/status plus unregistered files). Only the coordinator reconciles
  the index (`--index`/`--unregister`); workers register their own report only
  when asked. No approval/state language.

Agents live in `opencode/agents/sane/assistant/*.md` and
`opencode/agents/sane/worker/*.md` (short names). Agent IDs are path-derived:
`sane/assistant/design`, `sane/worker/scout`. Update every ID reference below
accordingly.

### 1g. Workers (no role rewrite, path sweep only)
- `sane-worker-implementer.md`: report destination
  `implementation/reports/<stage>/*` -> `execution/reports/<job-id>-<job-slug>.md`
  via `resources/EXECUTION_REPORT_TEMPLATE.md`. Stays worker-level.
- `sane-worker-reviewer.md`: read SDD + solution specs + job specs (not Stage/
  Section specs).
- `sane-worker-fixer.md`: same report path fix.
- `sane-worker-grounder.md`: writable file is `plan/jobs/<job-id>-<job-slug>.md`;
  read-only context is SDD + solutions + plan (not Stage design).
- `sane-worker-researcher.md` / `sane-worker-scout.md`: unchanged contracts;
  researcher receives an exact self-contained prompt with no baseline context,
  scout reads exact supplied paths.

## 2. Role skills (`skills/*/`)

### 2a. RETIRE `sane-product-assistant-role/` (merge into design)
- Move "bounded outcome, acceptance evidence" guidance into
  `sane-design-assistant-role/SKILL.md` root-doc section.

### 2b. RENAME `sane-coordination-assistant-role/` -> `sane-execution-assistant-role/`
- `name:` + `description:` + H1 updated. Directory rename must match installer
  manifest.
- Purpose: `execution/reports/*` (via Implementers), `execution/BRIEF.md`
  (single actual-state handoff from `resources/EXECUTION_BRIEF_TEMPLATE.md`),
  jobs `running` onward, `merges` row, Execution `state_entries`.
- Pickup: `plan/PLAN.md` + all job specs + `SDD.md` + solutions + `SANE_STATE.md`;
  confirm plan-package approval (gate 3) before dispatch; record SDD/
  foundation revs; research reports surface as index warnings only
  (missing/modified/unregistered files).
- Assistance: batches from `plan/PLAN.md` Jobs + Split Notes (sequential default,
  parallel only if plan authorizes); worktree `sane/<user>/<slug>` via
  `sane-alpha worktree`; isolated checks only; read-only review per batch;
  "Planning needs to make these corrections" (never edit plan/specs, never
  launch Grounder).
- Delivery: per-Job reports + `execution/BRIEF.md`; user accepts per batch
  (gate 4) or authorizes retry/fix. Merge via Sec 4 protocol + gate 5.
- Delete all `implementation/reports/<stage>`, `implementation/briefs/STAGE_NN`,
  `Stage Implementation Brief`, `[~] Active/[!] Blocked` Stage-state language
  that references Stage entries (keep per-Job coordination notes if useful,
  but status source is DB + `sane-alpha status`).

### 2c. `sane-design-assistant-role/SKILL.md`
- Owns root doc + `SDD.md`. Add per-type root section:
  `feature->PRD.md`, `foundation->FOUNDATION.md`, `issue->ISSUE.md`,
  `maintenance->MAINTENANCE.md` (copy `resources/` fallback? No — root doc +
  `SDD.md` are edited in place/bootstrap roots; solutions use
  `resources/SOLUTION_SPEC_TEMPLATE.md`).
- `SDD.md` section: links root doc (+ rev/hash) to solutions; update + re-approval
  required before Planning/Execution follows new direction.
- Artifact Creation: root `SDD.md` from `resources/SDD_TEMPLATE.md` (copy once,
  then edit); never overwrite.
- Pickup/Delivery: add revision record/recheck + `foundation_rev` check.

### 2d. `sane-engineering-assistant-role/SKILL.md` (biggest rewrite)
- Owns `solutions/<name>.md` (one comprehensive doc per solution area) from
  `resources/SOLUTION_SPEC_TEMPLATE.md`. Delete `SECTIONS.md`, `sections/`,
  `STAGE_SECTIONS_TEMPLATE.md`, `SECTION_SPEC_TEMPLATE.md`, Stage split steps.
- Assistance 1-4 become: read SDD -> propose solution areas -> write one spec
  per area (architecture, interfaces, behavior, affected code, verification,
  code refs) -> remove downstream decision gaps. Keep Scout/Researcher routing
  (already correct) + "surface approved-Design conflict, suggest Design Update."
- Delivery: specs complete + ready for Planning. Approval: user approves Solution
  Specs (gate 2) via `sane-alpha approve --gate solutions`.

### 2e. `sane-planning-assistant-role/SKILL.md` (path sweep + gates)
- Replace owned paths with `plan/PLAN.md` (`resources/PLAN_TEMPLATE.md`) +
  `plan/jobs/<job-id>-<job-slug>.md` (`resources/JOB_TEMPLATE.md`).
- Delete `execution/stages/...`, Stage Design/Section inputs -> SDD + solutions.
- Keep breakdown-confirmation gate, Grounder assignment, cross-job review.
- Delivery: plan package approval = gate 3 (`sane-alpha approve --gate plan`),
  authorizes Jobs but does not start execution. Handoff to Execution.

### 2f. `sane-research-assistant-role/SKILL.md`
- Append-only archive: reports `research/<topic>/REPORT.md`
  (`resources/RESEARCH_REPORT_TEMPLATE.md`). `research/BASELINE.md`,
  `resources/RESEARCH_BASELINE_TEMPLATE.md`, the baselines table, and baseline
  revisions are retired; the old `sane-alpha baseline --record|--recheck`
  command is gone. Delete `research/workstream/` vs `research/stage-NN/`
  branching.
- Pickup surfaces research index warnings (missing/modified/unregistered files)
  via `sane-alpha research <impl-repo> <ws-path>` (default `--index`); read
  root doc (any of 4, for context only — type-agnostic) + registered reports +
  SDD/solutions if present. Never update a registered report; write a new topic
  instead.
- No gates: delete "approve baseline / mark Workstream -> Research Approved".
  Delivery = reconcile the index, hand evidence to launcher; mismatches on
  new/edited/removed reports route to a Design/Engineering update +
  re-approval; never blocks.
- Only the Research Assistant reconciles the index (`--index`/`--unregister`);
  workers register their own report only when asked. Keep Researcher-delegation
  + Scout-ownership rules as-is.

## 3. Installer manifest (must change with the above)
- File: `packages/sane-cli/src/install-sane-agent-context-packages.ts`
  (+ `packages/sane-cli/tests/install-sane-agent-context-packages.test.ts`).
- Remove `sane-assistant-product` + `sane-product-assistant-role`; rename
  `sane-assistant-coordination` -> `sane-assistant-execution`,
  `sane-coordination-assistant-role` -> `sane-execution-assistant-role`.
- Keep 6 workers. Keep model-config behavior.
- After editing, run `bun run test packages/sane-cli/tests/install-sane-agent-context-packages.test.ts`
  — its assertions on agent/task permissions + skill registrations WILL fail
  until manifest + tests match your renamed files. Update both sides together.

## 4. Retired template files still on disk (optional cleanup, do together)
- Unmapped but present: `templates/shared/design/*`, `templates/shared/implementation/*`,
  `templates/shared/execution/EXECUTION_PLAN.md`, `templates/design/*`,
  `templates/feature/design/SPEC.md`, `templates/foundation/design/SPEC.md`,
  `templates/foundation/PRD.md` (old shape — superseded by `FOUNDATION.md`).
- Bootstrap no longer copies them (verified). Delete + update any doc that lists
  them (`SANE_REPOSITORY_SETUP.md`, `_legacy/SANE_WORKSTREAM_BOOTSTRAP_PLAN.md`), or
  leave on disk and note "retired, unmapped." Do not leave skill/agent docs
  pointing at them.

## 5. Done checklist
- [ ] `grep -ri "stage" opencode/agents/sane/assistant/*.md opencode/agents/sane/worker/*.md skills/*/SKILL.md` returns
  only worker-historical or explicit "no stages" notes.
- [ ] `grep -ri "coordination\|product assistant\|implementation/briefs\|STAGES_TEMPLATE\|SECTION_SPEC" opencode skills templates docs` returns nothing
  requiring action (or explicit retired notes).
- [ ] `grep -ri "execution/stages\|design/stages\|research/stage-\|research/workstream\|research/BASELINE\|RESEARCH_BASELINE" opencode skills` empty (or explicit retired notes).
- [ ] Installer test green after manifest update.
- [ ] `bun run typecheck && bun run test` green (expect 184 + your new/updated tests).
- [ ] One pilot workstream bootstraps with new agents (try `--type issue`).
