# Sessions audit: web-redesign (context/handoff mechanics only)

Scope: 86 sessions, 341 runs (81 oc / 5 cc), 64 handoffs, 15/15 jobs, execution pending.
Review issues: 85 session-block-missing (error), 94 launch-artifact-missing (info),
7 run-interrupted + 5 worker-outcome + 4 worker-state (warning), 1 run-failed (429).

## Context delivery (sizes, repetition)
- `session-start.md`: 13 files, ALL byte-identical (md5 match, 2973 B). Same framework
  re-sent per OpenCode run, not once. Covers 13 runs; native-cc runs get context inline.
- `sane-session.md`: 284 files; 263 cluster at 161–197 B (bare workstream pointer),
  21 at 548 B (adds branch-continuation paragraph), 1 outlier at 61 KB.
- `canonical-context.md`: 175 files; clusters at 6574 B (60), 6810 B (40), 9737 B (72)
  = role-template variants; 1 outlier at 1.4 MB (full conversation dump leak).
- `.delivered` flags: 181 present, inconsistently (sampled session-start: absent;
  sane-session: present). Flag protocol is unreliable as a delivery signal.

## Handoff payload patterns
- 64/64 completed. Input sizes 1.3–6.4 KB; largest = kickoff (keys: requestId, to,
  message, createNew, kickoff). All 64 messages distinct (no repeated blobs);
  key sets vary across 5 shapes — payloads are per-handoff composed, good.
- `evidence` field is a FIXED 124-char string on all 64 handoffs ("Correlated native
  delivery-run success in App run 99618b2d…; not task completion or user approval").
  Evidence carries zero per-handoff information — dead weight / misleading schema.

## Useless / repeated context
1. Identical 2973 B framework block rewritten per run (13× same bytes).
2. 124-char evidence placeholder ×64 — pure noise, never varies.
3. 94 `launch.agentFile` refs point at deleted paths (info-level rot).
4. 85 sessions missing Session block (39/40 runs in design S2) — context delivered
   but unattributed; audit cannot verify what the agent actually saw.

## Gaps behind the 5-approval loop (design, 21:47→23:58, ~2 h)
- 5 distinct snapshot_hashes → doc really changed each round, not rubber-stamping.
- `user_reference` lengths are 2 chars on all 5 design approvals — no recorded
  rationale for what was wrong each round; next assistant got the new doc but not
  the delta/rejection reason.
- Human audit ops: only `conversation_registered` (74) + `phase_approved` (8).
  Zero correction/reject operations — rework signal exists only as full-doc diffs.
- Cause hypothesis: rejection reasons lived in chat, never entered context docs,
  so each design run re-derived constraints instead of receiving a compact delta.

## Proposals
1. Send framework once per session (hash + `framework_version`), per-run files carry
   only the session pointer + delta. Kills 2973 B × N duplication.
2. Make `evidence` a real per-handoff summary (or drop the column); forbid constant
   strings at write time with a length-variance check.
3. Record approval rejections: append `rejected_hash + reason (1–2 lines)` to the
   phase doc on each failed approval; feed that list (not the whole chat) to the
   next run. Directly addresses the 5-round loop.
4. Fix `.delivered` flag discipline (write atomically with file) andcap
   `canonical-context.md` (the 1.4 MB dump suggests unbounded history inclusion —
   enforce a byte budget with truncation notice).
5. Repair/purge stale `launch.agentFile` paths; 94 dangling refs erode trust in
   launch provenance.
