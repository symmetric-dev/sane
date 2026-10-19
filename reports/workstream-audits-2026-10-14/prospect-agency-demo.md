# Audit: prospect-agency-demo — Prospect-ready agency demo for Mexican talent agencies

Repo: `/Users/beto/aws-hackaton-talent-agency` · Workstream dir: `.sane/workstreams/prospect-agency-demo`
Type: feature · Status: **open** · Created: 2026-10-09T01:17:30Z · Last update: 2026-10-09T01:18:19Z (≈2 min lifespan, stalled 5 days to audit date 2026-10-14)
Method: read-only (files + `sqlite3 -readonly` on `.sane/sane.db`). No App data modified.

## Overview

`prospect-agency-demo` is the third workstream in a demo-delivery sequence (`shared-demo-tenants` 09-30 → `landing-flow-demo` 10-04 → this one 10-09). Goal: a Mexican talent agency opens a directly-shared link, creates its own Cue agency, loads a 20-actor Mexican sample roster with one click, and gets convincing casting results in Spanish — with no judge/demo wording anywhere on the path.

**Bottom line: this workstream never started.** A single design-session handoff was queued, accepted, run, and marked `completed` within ~4 minutes of workstream creation, but the "delivery" wrote back byte-identical blank templates: `PRD.md` and `design/SDD.md` still contain only guidance comments. All four `phase_states` are `pending`; there are no approvals, jobs, research reports, solution specs, PLAN, or experimentation output. The design `phase_assignment` is still open (`ended_at IS NULL`). The most significant finding is process-level: **SANE recorded the handoff as `completed` despite zero artifact content change** — completion means "native delivery-run success," not task completion or user approval (the state-change evidence string says exactly this).

## Documents inventory

| Path | State |
|---|---|
| `PRD.md` | Blank template (11 H2s, guidance comments only) |
| `design/SDD.md` | Blank template (6 H2s, guidance comments only) |
| `design/solutions/` | Absent (vs 6 specs in landing-flow-demo, 7 in shared-demo-tenants) |
| `research/` | Empty dir, no reports; `research_reports` table: 0 rows |
| `execution/` (`jobs/`, `reports/`, `PLAN.md`, `verification/`, `test-reports/`, `FINAL_REPORT.md`) | Absent entirely; `jobs` table: 0 rows |
| `experimentation/` | Absent (required by kickoff — never handed off) |
| `resources/*_TEMPLATE.md` (9 files) | Present, identical scaffolding as sibling workstreams |

DB summary (`workstream_id='prospect-agency-demo'`): 1 workstream row (rev 3), 1 membership (`c7eea7ca…`, still open), 1 conversation (`ses_ee1c359d…`, oc harness), 1 open `design` phase_assignment, 1 handoff (`076fcdbf…`, `completed`), 1 handoff_attempt, 13 audit_events (all within 2026-10-09T01:17:30–01:19:21Z), 0 approvals, 0 jobs, 0 research_reports. Proof of no-op delivery: the `artifact_operation_completed` manifest hashes equal the creation manifest hashes (`PRD.md 8f33f265…`, `SDD.md ab26ba29…` unchanged).

## What worked

- **Kickoff quality is the best artifact in the workstream.** The design handoff input (~6.7 KB) is specific, verified, and decision-rich: repo baseline pinned to branch/commit (`docs/agency-paths` @ `cc9d46d` vs `main` @ `b7dd4c4`), 4 numbered confirmed user decisions (sales-led CTAs, founder sample-load/clear buttons, Mexico-only Spanish-only 20-actor fixture, search + casting-screen Spanish polish), explicit out-of-scope list (6 items), file-level technical findings (`demo_actors.py` uuid5-per-agency collision, CLI-only seeder, case-sensitive exact-match filters in `actor_search.py`, 32-actor English fixture mismatch with the Mexico City landing example, `scripts/dev/` 4-stage generation pipeline with the CUDA-on-Mac headshot caveat), and 6 framed open questions for Design.
- **Clean layering on `shared-demo-tenants`, not reinvention.** The kickoff names what the foundation workstream delivered (founder signup, invitations, join pages), what it did not (no staff roster screen), and states the freeze-supersession explicitly (landing-page CTA freeze from FOUNDATION is overridden for the buttons). This is cross-workstream learning done right.
- **Costed experimentation brief embedded in kickoff.** Headshot model comparison (Nova Canvas ~$0.04 vs Imagen 4 Fast ~$0.02 vs FLUX.1 schnell ~$0.003, total <$1, AWS-default reasoning) plus Haiku 4.5 bios pointer — concrete enough to execute standalone.

## What didn't

- **The design session produced nothing.** Handoff lifecycle queued → acceptance_unknown → accepted → running → completed in ~3.5 min, yet the provide-manifest hashes prove PRD/SDD were untouched. Either the worker never ran substantive steps or its output was discarded; either way the `completed` status is misleading.
- **No recovery in 5 days.** Open workstream, open design assignment, all phases `pending`, zero follow-up handoffs or audit events after 01:19:21Z. The stall is silent — no blocked status, no user-facing signal.
- **Completion semantics gap (SANE-process issue, surfaced by this workstream).** The `handoff_state_changed` evidence for `completed` reads "Correlated native delivery-run success …; not task completion or user approval." A status that means "the runner exited fine" while artifacts are unchanged invites exactly this kind of zombie workstream.

## Repetition/duplication

- **Almost none — because almost nothing was written.** The only duplication is structural: the 9 `resources/*_TEMPLATE.md` files are byte-identical scaffolding repeated in all three workstreams (by design, harmless).
- **No research/design duplication of `landing-flow-demo`.** Verified fresh technical analysis (fixture-ID namespacing, seeder, filter normalization, generation pipeline) with no overlap against landing's animation/localization work. The kickoff does not copy landing content.
- **One mild cross-workstream miss (omission, not duplication):** `landing-flow-demo` already solved adjacent problems this workstream re-poses as open questions — `design/solutions/demo-content-localization.md` (EN/ES copy keys in `@talent/app-content`, `content:check` parity) bears directly on the prospect kickoff's open questions about `?lang=es` code-carry and stored-English values in the Spanish UI, and the landing CTA work (`landing-integration.md`, hero buttons) touches the same buttons prospect wants to retarget (`/demo/judges` → `/agency/new` + Sign in). The kickoff never references `landing-flow-demo`. Not a conflict yet (different goals: animated guide vs conversion CTAs), but the button change lands on landing-flow-demo's surface with no coordination note.

## User mid-course corrections

- **None observable.** All user decisions arrived pre-packaged in the kickoff message ("agreed with the user in an exploration session"); the DB shows no subsequent human-authored events, no approvals/rejections, no scope edits, no second handoff. With blank PRD/SDD there was nothing to correct.
- The kickoff itself encodes one prior correction worth preserving: the experimentation track (headshot comparison) was explicitly *deferred until the workstream exists* at the user's direction — and then never launched.

## Gaps / explore-more

All of these were framed as Design's job and remain untouched:

1. **Fixture namespacing design** — per-agency actor IDs (agency in uuid5 input) + ownership-scoped delete; kickoff points at a possibly-reusable reset-by-ownership design in `docs/operations.md` — unverified.
2. **Seed/reset endpoint + UI** — CLI-only today; founder "load sample / clear sample" buttons need API + empty-state UX; authZ (founder-only) unspecified.
3. **Search reliability** — city/state/skill normalization + allowed-values-to-agent; no spec of canonical value lists.
4. **Casting-screen Spanish polish** — `casting-profile-dialog.tsx` hardcoded English + duplicated "Skills"; Spanish examples in `casting-examples.ts`.
5. **Open questions** — code-carry (`#code=` + `?lang=es`) from shared link; ethnicity field in Mexican context; English stored values under Spanish UI; estado field; who authorizes the paid embedding run; shared-code forwarding/rotation trade-off (accepted for now).
6. **Experimentation track never launched** — Nova Canvas vs Imagen 4 Fast vs FLUX.1 schnell (+ Haiku 4.5 bios); <$1, no Design dependency, runnable standalone.
7. **Landing-button coordination with `landing-flow-demo`** — CTA retarget touches the animated-demo section's entry points; needs a joint note before execution.
8. **Missing roster screen** — explicitly out of scope here and never delivered by `shared-demo-tenants`; the prospect's staff still has no roster view after loading samples — flag as the likely immediate follow-up workstream.

## SANE-process observations

- **Handoff `completed` ≠ delivered.** This workstream is the cleanest exhibit: identical input/output hashes alongside a `completed` status. Consider gating `completed` (or a separate `delivered` signal) on artifact hash change or phase-state transition.
- **Silent stalls.** An open assignment with zero events for 5 days and status `open`/`pending` everywhere produces no nudge. A staleness signal (e.g., "design assignment open > N days, no artifact delta") would have caught this on 10-10.
- **Kickoff pattern worth keeping.** The exploration-session → detailed-kickoff-message pattern (baseline commit, confirmed decisions, verified file-level findings, costed deferred tracks) is the highest-quality kickoff of the three demo workstreams; `landing-flow-demo`'s kickoff is comparable but less decision-dense. Recommend it as the template.
- **Enforcement note:** audit was read-only (`sqlite3 -readonly`, no file writes under `.sane/`); single output file is this report.
