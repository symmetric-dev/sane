# Session/Context Audit: app-moneypuck-integration (2026-10-14)

Scope: PROMPT/CONTEXT mechanics only. 113 sessions, 399 runs, 39 handoffs, 14 jobs.
Review issues: session-block-missing x107, framework-missing x72, handoff-failed x2.

## Context delivery
- File counts in `.data-fresh`: session-start 13, canonical-context 175, sane-session 285, `.delivered` flags 182 (0 bytes each).
- Samples: eng kickoff `0091b15b` session-start 2973B / sane-session 195B; failed run `79fc87cf` NO session-start, canonical 8618B; job02-window runs canonical 6574-9737B, jsonl 49-314KB.
- Dedupe: 72/175 canonical-context files are byte-identical (md5 `a044bd...`); top 4 hashes cover 172/175. Same blob redelivered per handoff, including 3x within the 11-min job02 loop.
- Failed run `79fc87cf` HAS canonical-context on disk yet review reports "Canonical dynamic context delivery was not confirmed" + framework-not-in-transcript. Delivery artifacts do not equal transcript confirmation.

## Handoff payload patterns (incl. failure retry)
- Input sizes are bimodal: session-start intents 217-225B (`eng-planning-start`, `planning-execution-start`); clarification replies 1-10KB (max 10413B `eng-planning-contract-clarifications-reply-01`).
- The 2 FAILED handoffs (`-02` cc-harness 10-12 23:44, `-03` oc-harness 10-13 02:47): both `input_len=217`, byte-equivalent minimal starter. Retry did NOT resend full input; it resent the same trimmed starter on a different harness.
- Recovery was by reference, not resend: next handoff `planning-engineering-contract-clarifications-01` (3651B) opens "Following initial handoff 2b1a1fbb...". Job02 loop (13 handoffs, 05:04-05:15, inputs 873-5219B) likewise chains by handoff-id, not payload. Delta-by-reference is the de facto pattern.
- Worker prompts (101 scoped, plen 17-9763, median 719): experiment stages split scope (V3 9763B monolith -> stages 3239/4967/8316B) with 3x `.md` path refs and zero embedded prior-result quotes. Delta-by-path, not cumulative resend.

## Useless/repeated context
- `sane-session.md` 195B stub (3 header lines, roots only) x285: zero per-delivery signal; `.delivered` flags are 0-byte existence bits.
- 72x identical canonical-context resends; job02 loop re-sent 9737B unchanged across planning<->execution round-trips minutes apart.
- 107 sessions lack Session blocks and 72 runs lack framework evidence, so much delivered context is unattributable in transcripts.

## Gaps
- Execution run `00c9d6ef` (the job02 gap question): NO session-start/sane-session/canonical-context/settings files, only 59KB jsonl, yet its handoff completed. Completion evidence without any context-delivery evidence.
- Delta-by-path depends on evidence-dir navigability (370 files); no manifest/pointer file per pass, so each worker re-discovers paths.
- Job02's blocking question (coverage-table exhaustiveness for a non-exhaustive status table) was resolved only by a same-hour user ruling: seeding is ephemeral, drop-and-report. No doc structure held that policy beforehand.

## Concrete proposals
1. Send canonical-context by content-hash reference after first delivery per session; resend bytes only on hash change. Kills the 72x identical resend and the per-round-trip 9737B in tight loops.
2. Make retry-after-failure resend the failed handoff's full input (or link it), never a fresh 217B starter; record harness switches (`cc`->`oc`) in the retry evidence so the two failures read as one incident.
3. Replace the 195B `sane-session.md` stub + 0-byte `.delivered` with a single delivery receipt (hashes of session-start/canonical-context + transcript confirmation boolean). Fixes the "artifact present, confirmation absent" gap behind framework-missing x72.
