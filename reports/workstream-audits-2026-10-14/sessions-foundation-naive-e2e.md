# Sessions audit: foundation-naive-e2e (PROMPT/CONTEXT mechanics only)

Scope: 131 sessions, 470 runs, 44 handoffs, 13 jobs, 4/4 phases approved. Review codes: session-block-missing x130, launch-artifact-missing x104 (stale agent path), hook-error x31 (timeouts), run-interrupted x10, framework-missing x1.

## Context delivery

- Canonical context is static templates, repeated per run. dataDir holds 175 `*.canonical-context.md` in only 6 distinct md5s (sizes 6574/6810/8618/9737 B). Sections: `# SANE Context` (SANE/Context/Lifecycle/State/Statuses/Worker Discipline) + `# SANE private procedures` + phase pickup. Per-run injection of ~7-10KB identical bytes; ~470 runs => ~3-4MB re-sent framework with zero per-run information.
- `*.session-start.md`: 13 files, 1 md5, 2973 B (same framework essay). `*.sane-session.md`: 285 files, ~190 B each (keys: workstream, workstream-root, implementation-root). Only 182 `.delivered` flags for ~298 delivery candidates — partial/unchecked delivery.
- session-block-missing in 130/131 sessions, yet workstream completed 13/13 jobs. The small per-session pointer never reached native context; agents worked from handoff `message` + repo files. Delivery channel is effectively handoffs, not session plumbing.

## Handoff payload patterns

- Envelope keys (all 44): `requestId, to, message, target`. `message` dominates: top-5 inputs 8441/7155/5455/4945/4902 B total, message body 4573-8136 B. Routing: planning 13, execution 9, design 8, engineering 7, research 4, experimentation 3.
- Consecutive-handoff blob repetition is LOW (SequenceMatcher ratio mostly <0.10; one pair at 0.32). No copy-paste chains — each handoff is freshly composed. Good.
- Reference-by-path, not inline: 205 `.md` refs across 44 handoffs (~4.7 each). Largest handoff lists 9 paths (4 experimentation findings + FOUNDATION.md x3 + README + verification note) with inline verdict summary only. Research handoffs are small (~1.7KB, 2 path refs + topic + owner-delegation paragraph).
- 29/44 handoffs (66%) mention Owner — authority/delegation prose ("owner is in control...", "Owner-authorized Support Reply", "Owner worked directly...") is the single most repeated handoff ingredient.

## Useless / repeated context

1. Static framework (~7-10KB) re-injected per run: ~6 unique blobs x hundreds of runs. Should be sent once per native session (or hashed/cached), not per run.
2. session-start essay (2973 B, identical) adds nothing over canonical-context; sane-session pointer (~190 B) is the only per-session-varying piece and it mostly never arrived.
3. Owner-delegation boilerplate in 66% of handoffs: same authority paragraph re-composed per handoff. Templatize to one line + envelope flag.
4. Research registration: 43 rows for ~10 real topics = 10 `REPORT.md` + 33 `*-evidence.md` fragments, each a full topic row (PK workstream,topic) + audit event. Fragments are file-level, not decisions; they inflate the topic namespace 4x and force readers to list dirs to find the 10 real reports.

## Gaps behind owner interventions

- Audit: human ops = 118 conversation_registered + 5 phase_approved only. Real interventions ride side-channels: 10 owner Stops (run-interrupted), 2 worker interruptions (S19 implementer, S59 reviewer), and owner prose inside 29 handoffs.
- Cluster A (secrets/topology): largest handoff carries RDS host/region, restore lineage, passwords-supplied-by-owner, network-access cleanup. Necessarily outside docs — but no `ENVIRONMENT.md`/secrets-pointer convention exists, so each redirect costs a bespoke 8KB handoff + owner session time.
- Cluster B (supersede/authority): "older 22-table proposal retained but superseded", "original held-export wording is superseded", owner-review outcome pasted at top of report (S19). Supersede state lives in owner sentences, not in a machine-readable doc header — agents can't see staleness without being told.

## Concrete proposals

1. Per-run static dedup: cache canonical-context by hash per native session; per-run injection only if hash changed. Kills ~3-4MB/run-set of framework resends.
2. Fix or drop the Session block: 130/131 missing with zero completion impact means it is dead weight as specified. Either deliver the ~190 B pointer reliably and strip equivalent bytes from handoffs, or remove it and bless handoff+files as the channel.
3. Research registration tiers: `REPORT.md` (decision record, registered topic) vs `*-evidence.md` (attachment, unregistered, listed from report). Cuts topic rows ~43->~10.
4. Handoff envelope: move owner-authority boilerplate to a `delegatedBy: owner` flag + one-line template; reserve `message` for delta (verdicts, paths, decisions). Target p50 message <1.5KB (today's tail reaches 8KB).
5. Staleness headers: `Status: current|superseded-by <path>` + `Secrets: see <pointer, never values>` front-matter convention on findings docs, so owner corrections become file edits, not 8KB bespoke handoffs. Add `.delivered` accounting or delete it — 182/298 unchecked flags are noise.
