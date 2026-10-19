# Audit: shared-demo-tenants — context + handoff mechanics (PROMPT/CONTEXT only)

Scope: 63 sessions, 259 runs, 37 handoffs (36 completed + 1 FAILED), 14 jobs, 6 checkpoints. All phases approved, deployed.

## Context delivery
- 0/259 runs carry framework/sessionBlock evidence; 61 sessions have no saneContext record (pre-framework workstream, per review coverage note). Absence = era, not failure — but nothing marks it as such.
- Sampled 3 workstream runIds (`d13b5e06`, `79374c1c`, `fd178068`): no `session-start` / `sane-session` / `canonical-context` files, no `.delivered` flags.
- Baseline from other workstreams in `.data-fresh`: `sane-session.md` ~195B stub, `session-start.md` ~3KB, `canonical-context.md` ~9.7KB, each with `.delivered` flag. This workstream ran on native transcripts + handoff messages only.

## Handoff payload patterns
- All 37 inputs are message-only: keys are `requestId/to/message` + (`target` | `createNew` | `kickoff`). No structured context, constraint, or checkout keys anywhere.
- Sizes 59B–4833B; typical 0.5–2KB. Design→engineering handoffs are 62/59B pure pointers ("see SDD") — zero payload, full re-read assumed.
- Verification handoffs use path-refs, never inlined logs: tester→execution messages are single-paragraph, 0 newlines, citing `test-reports/*.md` + raw `.log` alongside. Largest handoff (curation, 4422B/25 lines) cites 9 files by path. Good pattern — keep.

## Useless / repeated context
- `test-reports/`: 63 files / ~1.0MB. Three before/after pairs verified byte-identical (md5 equal): cp5-production, cp3-openapi, cp6-production diffs — likely empty diffs written twice. Never inlined into handoffs, but every agent lists/reads the dir; doubles write + scan cost for zero signal.
- Failed handoff `exec-cp2-verification-conflicts-01` (2113B, 429 rate-limit, 1 attempt, no same-ID retry) was re-sent ~7.5h later inside a *new* requestId (`exec-cp2-lookahead-01`, 1999B). Recovery = resend-not-trim; planning's reply resolved all 3 embedded points. Works, but original stays FAILED and linkage is prose-only ("your earlier request").

## Gaps — the late Google-flow requirement (jobs 12–14, cp5–6 post-"complete")
- The wrong requirement was load-bearing in the *right* artifacts: approved design (`founder-onboarding.md:102–110…`) + Job 03 Locked decisions encoded email-typed Google signup. The correct pattern ("Google supplies verified email; never ask") lived only in reviewer evidence + codebase files, never as a design constraint or checklist item.
- Verification specs confirm the hole structurally: "google" hits cp1=0, cp2=2 (fake-seam + 401 wording only), cp4=3 — none asserting a no-email-prompt rule. First assertion appears in cp5 (20 hits). No negative-requirement ("never ask X on flow Y") section existed to fail closed.
- Kickoff message (4833B) mentions Google 4× but as feature list, not constraint. Nothing in handoff key-sets could have carried a checkable auth-pattern requirement because no such key exists.

## Concrete proposals
1. Add checkable constraint keys to design→planning handoff inputs (e.g. `authPatterns: [...]`), banning prose-pointer handoffs for cross-phase transfers. The 62B design→engineering pointer is the anti-pattern to kill.
2. Verification specs: mandatory negative-requirement section ("never-X-on-flow-Y"), carried forward every checkpoint. The no-email rule would have failed at cp1, not post-complete.
3. Handoff retry semantics: retry same `requestId` with `revision++` instead of new-ID resend; record supersedes-links so FAILED states don't strand content.
4. Evidence hygiene: test harness writes one file + sha (or empty-marker) instead of byte-identical before/after pairs; cap retained raw logs per checkpoint.
5. Mark pre-framework sessions explicitly (era tag) so future audits distinguish "no record by design" from delivery failure.
