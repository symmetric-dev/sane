# Audit: foundation-naive-e2e — Foundation: naive end-to-end implementation (NHL data → local transforms → API → frontend)

- Repo: `/Users/beto/silly-goose-stats` | Workstream dir: `.sane/workstreams/foundation-naive-e2e`
- Type: foundation | Status in DB: **open** (all 4 phases approved) | Created 2026-10-05, last updated 2026-10-08, revision 221
- Audit date: 2026-10-14, read-only (no `.sane/` or App-data writes; this report is the single output)

## Overview

This is the largest and most complete workstream audited in this batch: a from-zero foundation that builds a
manually-run local path NHLE raw + retained MoneyPuck files → Parquet → Postgres → Hono API → React web app +
viz library + viz-lab dev tool, verified over 13 jobs and 4 checkpoints. All 13 jobs are `completed`, all 44
handoffs are `completed` (zero failed, zero retries), all 4 phase_states are `approved`, and a FINAL_REPORT exists.
The remaining gate is explicitly owner-side: visual walkthrough + execution approval (workstream still `open`).

Scale of the paper trail: FOUNDATION.md (359 lines), SDD.md (296), 11 solution specs (~5.5k lines), 10 research
REPORTs (~1.4k lines) plus evidence, 13 job specs (~2.6k), 13 job reports, 4 verification specs + 4 test reports,
FINAL_REPORT, 11 experimentation findings + ~200 experimentation evidence files, execution evidence for jobs 11–13
only. DB: 461 audit_events, 130 memberships, 43 research_reports, 5 approvals.

Headline judgment: exemplary verification rigor and handoff reliability; docs are specific (real counts, real run
IDs, real hashes) rather than boilerplate. Main costs: per-workstream template duplication, evidence-file bloat
(matrix JSONs, per-file research registrations), ephemeral test-evidence paths in /tmp, and a thin closeout tail
(owner validation + status flip still pending 6 days after last activity).

## Documents inventory

| Location | Present | Notes |
|---|---|---|
| `FOUNDATION.md` | yes, 359 lines | Thorough: goals/non-goals, NHLE-replaces-Betalytics decision, acquired-data census (1,394 games, 4,247 responses, 163,021 shot events), MoneyPuck gaps (29/42 games), attack-direction rule `(x,y)→(−x,−y)`, analytical populations, config-model gap, acceptance walkthrough |
| `design/SDD.md` | yes, 296 lines | Goals, fixed-stack constraints, lake layers, game-grain facts rationale, SQL-aggregation serving, Zod envelope + view declarations, component table, data/control-flow diagram, cross-cutting contracts, verification approach, 11-row solution-area table |
| `design/solutions/*.md` | 11 files, 5,565 lines | `contracts` 1,268 (largest); `matchup-api` 650; `viz` 621; `analytics-facts` 527; `repository-baseline` 477; `web` 419; `viz-lab` 360; `serving-load` 353; `normalization` 323; `verification` 379; `nhle-acquisition` 188. Each has Objective/Scope + Technical Design scoped to SDD sections; consistently cross-referenced |
| `research/*/REPORT.md` | 10 REPORTs, 1,383 lines | hockey-viz-coverage (135), missing-data-sources-for-viz (132), advanced-stats-derivation-effort (167), hockey-analytics-world-map (222, synthesis), hockey-product-landscape (224, 52-entry catalog), hockey-matchup-recommendations (106, owner-requested companion), semantic-viz-model (99), frontend-viz-packages (98), ui-stack-landscape (116), nhle-source-feasibility (84, decision-grade + live acquisition commands) |
| `research/` evidence | ~33 supporting files | Local CSV audits, MoneyPuck dictionaries, endpoint/coordinate/rights evidence, season-direction-audit.json, visx/sports-package surveys. DB registers 43 research_reports (evidence files registered individually — see Repetition) |
| `experimentation/` findings | 11 findings files (~1.8k lines) | matchup-{data, transform, viz, rink, event-position, anomaly-classification}, moneypuck, nhl-coverage, nhl-export (264, includes owner 8-table narrowing + live export result), sports-data-access, viz-library (345) |
| `experimentation/evidence/` | ~200 files | Heavy matrix artifacts: viz-dynamic viewport/preset/layout JSONs across 7 widths, viz-editor-stress layout/resize JSONs, matchup rink PNGs, NHL coverage SQL/JSON. Real signal mixed with bulk generated JSON |
| `execution/PLAN.md` | yes, 48 lines | 13 jobs + split notes (strict order; 02/03 split; 05 reads existing raw run; 09/13 harness-only; v1-only scope) + 4-checkpoint table |
| `execution/jobs/*.md` | 13/13 | ~2.6k lines total; sampled 02-shared-catalog — precise, with locked decisions, file/record shapes, read-lists |
| `execution/reports/*.md` | 13/13 | Sampled 10-theme-and-viz-library — outcome + changed paths + checkpoint pointer + correction notes; pattern holds |
| `execution/verification/*.md` | 4/4 | checkpoint-1 (65 lines, exact test matrix), checkpoint-2 (164, real run IDs + concrete SQL requirement), checkpoint-3 (130), checkpoint-4 (158) |
| `execution/test-reports/*.md` | 4/4 | checkpoint-1 (135), checkpoint-2 (287, most detailed: 92 cases + 42 listing cases, real load IDs 3/4, 14-table hash table), checkpoint-3 (78, collation correction), checkpoint-4 (253, correction round 1) |
| `execution/evidence/` | partial | Only `11-web-app/` (~27 files: JSONs, PNGs, txt), `12-viz-lab/` (~35), `13-browser-check-harness/` (4). Jobs 01–10 have no evidence dir; their evidence is test logs under /tmp paths cited in reports (durability concern) |
| `execution/FINAL_REPORT.md` | yes | All 13 jobs complete, 4 checkpoints table with commits (6e2da37, 33ed7da, a802c7b, 917fe6e), non-blocking issues, owner-validation + approval as next steps |
| `resources/` | 9 templates | JOB/PLAN/SDD/SOLUTION_SPEC/RESEARCH_REPORT/TEST_REPORT/VERIFICATION_SPEC/EXECUTION_REPORT/EXECUTION_FINAL_REPORT templates; byte-identical across workstreams (see Repetition) |
| No PRD.md | n/a | Correct for foundation-type (FOUNDATION.md instead) |

DB read-only snapshot (`sqlite3 -readonly`):
- `phase_states`: design/approved, engineering/approved (rev 2), planning/approved, execution/approved
- `jobs`: 13/13 completed (01…13)
- `approvals`: 5 — design `Ok`, engineering `reviewed`, planning `good`, engineering `Ok2`, execution `good-start` (engineering approved twice)
- `handoffs`: 44 total, 44 completed, 0 failed/abandoned; `handoff_attempts`: 44 (exact 1:1, no retries)
- `audit_events` (461): handoff_state_changed 176, conversation_registered 118, handoff_queued 44, research_registered 43, job_progressed 26, phase_assigned 12, handoff_recipient_bound 12, conversation_associated 12, artifact ops 12, phase_approved 5, workstream_created 1
- `memberships`: 130 rows, all with `ended_at IS NULL` (open-ended; no detached sessions)
- `research_reports`: 43 rows (10 REPORTs + individually registered evidence files)
- `workstreams`: `foundation-naive-e2e|foundation|open|2026-10-05|2026-10-08|rev 221`

## What worked

1. **End-to-end completion with evidence.** Every planned job finished; every checkpoint was accepted after
   independent testing + read-only review; FINAL_REPORT ties each scope to its report + commit. Planning's final
   completeness review found no material blocker.
2. **Verification rigor is the best seen in this batch.** Independent Parquet-based expected-values helper (proven
   DB-free via grep), scratch-database lifecycle with OID checks, real-Postgres integration tests (68 pass, 5,725
   assertions at checkpoint 3), deterministic reload hashes across all 14 serving tables, transaction-rollback and
   schema-guard tests, contract parsing of every response, browser checks driving installed Chrome with owned-service
   teardown verified via lsof, explicit negative tests (run-mismatch, stale cache, port collision, SIGTERM).
3. **Correction rounds actually corrected.** Checkpoint 2: test-oracle cell error fixed against the spec's floor
   rule + listing-semantics retest (+42 cases). Checkpoint 3: locale collation → `COLLATE "C"` code-point policy,
   all 4 order failures resolved without weakening assertions. Checkpoint 4: `per per GP` wording + snapshot-lint
   exclusion fixed with 5 new regressions. Each round documents what was *not* rerun and why retained evidence stands.
4. **Handoff reliability.** 44/44 completed, 1 attempt each — no failures, no retry storms. Cross-phase Q&A handoffs
   (spec-gaps, card-capacity ×5, checkpoint lookaheads, collation ×4, startup-guard, playwright-pin ×4) show a
   functioning iteration loop rather than fire-and-forget delegation.
5. **Specific, checkable docs.** FOUNDATION/SDD/solutions cite exact counts (1,394 games; 163,818 shot events; 797
   shootouts; 37 goalie shooters; 63 catalog records/17 families; 58 contracts), exact run IDs
   (`derive-20261008T143109477328Z-cdd84184b3b3`), exact tool versions (Bun 1.4.2, Playwright 1.63.0, Chrome
   154.0.8037.98, pg_trgm 1.6). Reviewers can re-derive rather than trust prose.
6. **Owner decisions captured in writing.** PLAN split notes + FINAL_REPORT record v1-only scope, 24-card cap,
   code-point ordering, Playwright pin — constraints a later reader can audit against the code.

## What didn't

1. **Closeout tail.** All phases approved + FINAL_REPORT written, yet workstream status is still `open` and execution
   approval is pending. Owner visual walkthrough (both themes) and live acquisition pilot were still outstanding at
   FINAL_REPORT time; no activity since 2026-10-08. Six days stale at audit time.
2. **Live acquisition never exercised.** `acquire` was verified offline/replay only; the one thing needing network
   (live pilot) is explicitly owner-run and unscheduled. The pipeline's riskiest external dependency is the least tested.
3. **Known a11y defect deferred.** Duplicate accessible names (`League F` ×2, `Inspect game` ×2) reproduced in static
   and live checks, accepted as non-blocking with region/article scoping as mitigation. Reasonable call, but it is a
   real product defect carried into the foundation's shared components.
4. **Coverage limits openly listed but unresolved.** Exhaustive lab preset/mode/edge permutations not exercised (only
   default snapshot generated); fuzzy-search ordering and trigram-threshold fallback not independently established;
   several harness signal/runner paths inspected-not-exercised; analytical checks prove consistency, not physical
   coordinate accuracy or provider agreement.
5. **Ephemeral evidence paths.** Test reports cite detailed logs under `/private/var/folders/.../T/opencode/` — temp
   dirs that may not survive. Durable artifacts are the tests + reports themselves, but a future auditor cannot
   re-inspect the cited command logs. `execution/evidence/` covers only jobs 11–13.
6. **Double engineering approval.** Engineering was approved (`reviewed`) then re-approved (`Ok2`) after spec-gap
   iterations. Harmless, but the pattern suggests the first approval preceded fully-baked specs (see mid-course notes).

## Repetition/duplication

1. **resources/ templates are verbatim copies per workstream.** `SDD_TEMPLATE.md` md5-identical across all 5
   workstreams in the repo (`a8d0b760…`); the other 8 templates follow the same pattern. 9 files × N workstreams of
   duplication that could live once globally (or by reference). Not harmful to content, but every template fix must
   be fanned out by hand.
2. **Research registration granularity inflates the record.** 43 `research_reports` rows for ~10 topics: each evidence
   sub-file (e.g. `hockey-product-core-evidence`, `stats-xg-evidence`, `ui-stack-react-solid`) is registered as its
   own report. Accurate as an evidence ledger, noisy as a report index; topic-level vs evidence-level distinction would help.
3. **Synthesis-on-synthesis research.** `hockey-analytics-world-map` reclassifies the prior coverage/missing/derivation
   reports (explicitly "not new empirical discovery"); `hockey-matchup-recommendations` is a discussion-led companion
   to the landscape report. Both are labeled as such — good practice — but ~330 lines restate prior conclusions for
   the Design handoff. Consider whether a findings memo suffices for discussion-led outputs.
4. **Experimentation evidence bloat.** Dozens of near-identical matrix JSONs (7 viewport widths × fixtures/presets/
   layouts/resizes for viz-dynamic and viz-editor-stress). Machine-generated and probably necessary for the checks they
   support, but they dominate file counts (~200) and will age poorly as documentation. A manifest + generator script
   reference would compress this.
5. **Cross-spec restatement by design.** The 11 solution specs deliberately re-derive from SDD sections (each cites its
   parent section). Some paragraphs (game-grain rationale, honest-slicing rules, unavailable states) recur in 3–4 specs.
   This is traceability, not waste — but SDD ↔ solutions ↔ PLAN ↔ jobs drift risk is real if any layer is amended
   without the others (the collation and capacity amendments touched specs + verification but relied on reviewers to
   propagate; they did, this time).

## User mid-course corrections

The owner intervened substantively at least 7 times, and each intervention improved the outcome:

1. **NHLE replaces Betalytics** (FOUNDATION §Starting Point). Source replacement, explicitly *not* field-for-field
   migration; legacy parity dropped as a goal. This is the workstream's single biggest scope correction and it stuck —
   research, SDD, and pipeline all follow it.
2. **Facts v1 only; version-swap walkthrough dropped** (PLAN split notes + FINAL_REPORT). Owner removed the
   second-serving-version exercise; version selection stays covered by configuration tests. Reduced execution scope with
   reasoning recorded.
3. **24 unique card-request cap** (Engineering amendment, checkpoint-1 retest). A real product constraint
   (`toStatParams`-deduplicated total ≤ 24) added mid-stream and regression-tested (exact-24 passes, 25 rejected).
4. **Code-point name ordering** (checkpoint-3). Locale-sensitive SQL vs independent helper disagreement resolved by
   owner-adopted `COLLATE "C"` policy + numeric ID tie-break; 4 failures → 68/68 pass.
5. **Playwright exactly 1.63.0, no age-rule exception** (FINAL_REPORT constraints). Owner pinned the version rather
   than granting a policy exception — supply-chain discipline.
6. **MoneyPuck 8-table narrowing** (nhl-export-findings). Owner cut a 22-table proposal to 8 historical tables and
   approved the live export; smoke + full export passed without retries.
7. **Matchup recommendations preserved for Design; coverage/direction proof accepted** (matchup-recommendations REPORT,
   nhle-source-feasibility REPORT). Owner steered research output toward Design consumption and closed the
   source-feasibility question explicitly ("requested delivery to Design").

Process signal: the handoff log shows dense owner-mediated cross-phase Q&A (card-capacity 5 msgs, collation 4,
playwright-pin 4, checkpoint lookaheads 1–4, startup-guard-doc). `branches.json` in sane-app `.data-fresh/` held only
unrelated demo entries — no additional user-hint channel for this workstream. Audit-event ops show no human-actor
overrides outside the handoff/approval flow; all corrections arrived as scoped replies, not mid-job rewrites.

## Gaps / explore-more

1. **Coordinate accuracy.** Attack alignment is community-documented + internally corroborated, not officially
   certified; rink geometry follows the 2026-27 rulebook for 2025-26 data (disclosed, not certified equivalent).
   Verification proves pipeline consistency, not that a plotted shot is where it happened. Worth an independent
   spot-check before any public exposure.
2. **Data reuse rights.** NHL terms restrict automated compilation/derivative use; MoneyPuck free use is
   non-commercial + credit; most commercial sources need agreement clarification (`rights-evidence.md`). Open and
   correctly flagged as low-impact-now — but it gates everything public later.
3. **MoneyPuck gaps as coverage, not fixes.** 29 player-games + 42 team-games missing; `all`/`5on5` overlap handled by
   convention; repeated team snapshot rows; no PP/PK rows. Reporting-as-unavailable is honest but the product will
   have visible holes every April.
4. **On-ice intervals / xG / adjusted impact.** Mapped as future lanes with source candidates (shift charts, NST
   mirror, Evolving Hockey, Sportlogiq…), zero implementation. The matchup section's "descriptive, not predictive"
   boundary needs guarding as NHL Expert requirements arrive — the most likely scope-creep vector.
5. **Generative-UI readiness unvalidated.** The config model "must not preclude" generative UI, but nothing tests
   that claim (no generation round-trip, no schema-driven renderer proof). Either validate early or downgrade to
   aspiration.
6. **Viz-lab combinatorial coverage.** Only the default snapshot generated; preset/mode/edge permutations unexercised.
   The lab is the future iteration workflow — its untested corners become tomorrow's bugs.
7. **Denominator discipline.** Per-team-game vs per-appearance vs TOI rules are enforced by tests + review, not by
   construction (any SQL author can mix them). A type-level or review-checklist guard would harden the highest-risk
   analytical invariant.
8. **Operational closeout.** Owner walkthrough, live pilot, execution approval, status flip, and canonical-docs
   handoff (FOUNDATION promises canonical docs post-workstream) are all still open. A closeout checklist job would
   prevent foundation workstreams from lingering `open`.

## SANE-process observations

- **Handoff success rate 100% (44/44, 1 attempt each)** across design → experimentation → research → engineering →
  planning → execution with heavy back-and-forth. The process handles iterative Q&A well; no stuck/failed handoffs.
- **Phase re-approval happened once** (engineering `reviewed` → `Ok2`). Consider whether spec-gap loops should block
  the first approval or whether re-approval is the intended mechanism — currently ambiguous.
- **Job tracking is clean**: 26 `job_progressed` events for 13 jobs (start + complete each), statuses all `completed`.
  No orphaned `running` jobs.
- **Template fan-out is the clearest process debt**: 9 identical templates copied into every workstream. Move to a
  shared location or content-addressed reference; keep per-workstream only genuine deviations.
- **Research registration conflates reports and evidence.** 43 rows ≈ 10 reports + 33 evidence fragments. Splitting
  `research_reports` (synthesis, one per topic) from `research_evidence` (fragments) would make the index usable.
- **Verification-spec → test-report pairing per checkpoint is excellent** and should be the template for other
  workstreams: scoped spec, independent oracle, retained-vs-rerun accounting, named correction rounds, explicit
  non-goals ("no redundant … sweep was performed for report preparation").
- **Test evidence durability**: convention of citing /tmp logs undermines the otherwise strong evidence culture.
  Require evidence under the workstream dir (as jobs 11–13 do) or accept log loss explicitly.
- **Staleness signal**: last workstream update 2026-10-08, still `open` on 2026-10-14 with only owner-side items
  remaining. A "waiting-on-owner" status or nudge would distinguish stalled-agent from stalled-human situations.
