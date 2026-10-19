# Sessions audit: landing-flow-demo (PROMPT/CONTEXT mechanics only)

Scope: 62 sessions, 190 runs, 22 handoffs (all completed), 11 jobs, 4 approvals (1/phase).
Audit actors: human=59 (all `conversation_registered`, incl. worker spawns) / native=58 / system=108.
Review flags: 110 error (88 hook-timeout, 18 session-block-missing, 1 stale, 1 run-failed/429), 10 warning, 104 info.

## Context delivery (measured)

- `sane-session.md` sidecar: identical 197 B / 3-line header on all 103 present runs; 87 runs (CC harness) have no sidecar. Zero refresh across jobs 7→11 and all steers.
- `session-start.md` (~3 KB): only on createNew runs — 4/190. Continuing runs get none. No `canonical-context.*`, no `.delivered` flags for this workstream.
- Framework payloads: 31 distinct sizes, 2149–5001 chars. Same sha re-delivered verbatim per worker (e.g. 2380 B scout sha `fb8d31…` ×12, 3383 B reviewer sha ×5).
- Worker assignments are pointer-style and lean: implementer subs 558–1200 chars ("Implement Job NN exactly as spec describes"). Mean submission 2002 chars; outliers are curation (47 KB) / engineering / planning, not execution workers.
- Phase-start handoffs are near-empty (57–60 B + createNew); real context arrives via artifact `provide`. Correct pattern.

## Handoff payload patterns (input bytes from store)

- kickoff 4254 · feasibility 6795 · findings-reply 4771 · phase-starts ~155 · cp reviews 1016–3115 · planning replies 1616–3004 · revisions 2710–3485 · curation 2651.
- Checkpoint reviews shrink over time (cp1 2133 → cp4 1016, cp5 1167) while job specs stay 5–11 KB and reports 2–14 KB: per-job ceremony overhead is flat-to-shrinking. Good.
- Revisions handoffs carry genuinely new content (verbatim user list + plan delta), not re-sent blobs. No input duplication found in handoff bodies.
- `jobs_registered` re-broadcasts the full job array each time (7 → 9 → 11). 1:1 job↔report mirroring; 52 md files in workstream dir.

## Useless / repeated context

- Identical framework shas re-delivered to every worker run; identical 197 B session block rewritten per run instead of once-per-session + version pointer.
- SDD `provide` ran 4× (one per phase start) then never again — despite 4 added jobs and copy/ownership renames that invalidated solution specs.
- 88 hook-timeout errors (SessionStart/CwdChanged/PostToolUse) are pure noise in review output.
- 18 `session-block-missing` (worker scout/reviewer/curation sessions launched with no Session block).

## Gaps

- Jobs 08–11 added under the single original planning approval `56015bfa` (approved 00:49 for 7 jobs). `jobs_registered` expansions at 14:10 (→9) and 14:46 (→11) had no new `phase_approved`; only 4 approvals exist total. Revisions went execution→planning→execution, but planning replies were native-session replies, not human gate re-entry.
- Steers absorbed with zero context change: "shortlist bar belongs to casting scene" correction and Job-11 "clarified instruction 1" went straight into specs/assignments. No audit op for steer/rename exists (`workstream_updated`/`retitle` absent from op set); SDD/solution-spec pointers never re-provided.
- Solution-spec reconciliation deferred as "pending with the user" in both revisions handoffs and never resolved in-workstream; drift explicitly grew.

## Concrete proposals

1. Gate re-entry on scope growth: any `jobs_registered` extending the list post-planning-approval must require a new human `phase_approved` (or auto-reset planning to `in_progress`). One approval id covering 7→11 jobs voids the gate.
2. Content-addressed context dedup: per session, deliver identical framework sha / session block once; later runs carry version pointer only. Kills ~12× redundant 2–3 KB worker payloads.
3. Auditable steers: add a lightweight `steer_recorded` audit op (or route corrections through a handoff) so renames/corrections are visible; re-provide SDD pointers when post-approval specs change.
4. Fix `session-block-missing` ×18: attach minimal Session block at worker `conversation_registered`.
5. Keep what works: near-empty phase-start handoffs + artifact provide, pointer-style worker assignments, shrinking checkpoint bodies. Codify as the template; cap curation-style mega-submissions (47 KB outlier).
