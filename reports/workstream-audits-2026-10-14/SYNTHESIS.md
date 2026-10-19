# SANE Workflow-Process Synthesis — 8 workstreams (2026-10-14)

Process/workflow only. No implementation content.

## 1. Useful patterns to keep/replicate

- **Verification-spec → test-report pairing per checkpoint** (foundation-naive-e2e, shared-demo-tenants): scoped spec written before testing, independent oracle, exit-code tables, retained-vs-rerun accounting, named correction rounds. Best "done" evidence bar seen.
- **Re-approval as normalized correction** (shared-demo-tenants eng v2 + planning replan; foundation eng Ok→Ok2): mid-course spec/plan amendments go through planning↔execution↔engineering handoffs with rationale, not silent edits.
- **Experimentation before design approval to de-risk** (landing-flow-demo casting-animation; moneypuck multi-pass dirs): genuine iterative passes with review+implementation notes per pass; correlates with zero downstream phase rework.
- **Plan split notes with file-ownership + parallel/sequential rules** (shared-demo-tenants; foundation-naive-e2e PLAN): prevents collisions, enables safe parallelism.
- **Research that grades its own confidence and propagates the caveat** (shared-demo-tenants CloudFront 307 report → SDD → test report → operator check): research→design→verification chain actually functioned.
- **FINAL_REPORT honesty about residual risk** (shared-demo-tenants, foundation-naive-e2e): pending checks, out-of-scope hotfixes, non-goals named with owners.
- **Clean failure recovery, no retry storms** (moneypuck 2 session-start failures stalled ~4h then resumed via next handoff; shared-demo-tenants cp2 failed handoff followed by lookahead/amendment): stall without queue poisoning.
- **Decision-dense kickoff pattern** (prospect-agency-demo kickoff: baseline commit, confirmed decisions, out-of-scope list, file-level findings, costed deferred tracks): highest-quality kickoff in set — keep as template even though its execution never started.

## 2. Problematic patterns with frequency (affected workstreams)

- **Stale/misleading phase or workstream status (7/8):** web-redesign execution=pending with FINAL_REPORT + 5 checkpoints done; foundation-naive-e2e all-approved yet open, 6 days idle; shared-demo-tenants open despite deploy; prospect-agency-demo open/pending 5 days silent; moneypuck 2 running jobs ~1 day stale; nfl-core-stats completed eng handoffs coexist with engineering=pending; auth-infra planning work staged while planning=pending.
- **Approval semantics unclear — both directions (6/8):** invisible rework rationale: web-redesign 5 design approvals, auth-infra 4 in <4h, no rejection trace; vs. gate bypass: landing-flow-demo jobs 7→9→11 (+57%) mid-execution with no planning re-approval; vs. thin gate: nfl-core-stats single terse approval ~100min after kickoff, no rework loop.
- **Handoff `completed` ≠ delivered (3/8 explicit):** prospect-agency-demo no-op delivery (identical hashes) marked completed — status means runner-exit, not artifact delta; moneypuck 2 terminal session-start failures across harnesses (systemic start fragility); shared-demo-tenants 1 infra (App-run) failure in handoff path.
- **Pre-gate WIP invisible to DB (2/8 structural, all staged-ahead cases):** auth-infra 8 substantive job specs + PLAN + 4 verification specs on disk, 0 jobs rows (FK requires planning_approval_id); verify-before-execute staleness risk; blank FINAL_REPORT on disk during pending execution (moneypuck) invites premature reads.
- **Per-workstream template duplication (8/8):** 8–9 identical templates vendored per workstream (byte-identical md5 confirmed); every template fix must fan out by hand; plus dead scaffold (landing-flow-demo empty research/; 9 template copies on demo scope).
- **Registration/evidence bloat (4/8):** foundation 43 research rows for ~10 topics; web-redesign 14 registered reports across 8 dirs (~1.75× inflation); shared-demo-tenants 63 test-report files/1MB with byte-identical before/after diff pairs + retained superseded logs; moneypuck 370-file/37MB experimentation evidence (navigability); ephemeral /tmp log citations (foundation jobs 01–10) that may not survive.
- **Human steering visible only as approvals (6/8):** audit footprints are conversation_registered + phase_approved almost exclusively; rework shows as re-approvals rather than tracked edits/rationale; mid-phase redirect ops absent.

## 3. Ranked top 5 SANE improvement opportunities

**1. Gate `completed`/status on artifact delta + close the closeout tail.**
Problem: status lies — done work reads pending, empty work reads completed, shipped work reads open. Evidence: prospect no-op `completed` (hash-identical); web-redesign FINAL_REPORT with execution=pending; foundation + shared `open` after all-approved/deploy. Change: `completed` (or separate `delivered` signal) requires artifact hash change or phase transition; add owner-waiting/closeout-checklist transition so approved+reported flips status. Effect: downstream consumers trust phase state; zombie/stall cases surface immediately.

**2. Make scope-change re-approval and approval rationale mandatory.**
Problem: gates are advisory or opaque — silent absorption one way, unexplained re-approval loops the other. Evidence: landing +57% jobs no re-approval; web 5× / auth 4× approvals no rejection trace; nfl single terse ~100min approval. Change: any job-count/spec change post-planning-approval requires planning re-approval; every approval/re-approval records rationale (polish vs defect vs scope steer). Effect: rework reasons auditable; gate-bypass precedent closed; reviewer cycles priced visibly.

**3. Centralize templates; generate closeout artifacts only at close; prune scaffold to scope.**
Problem: per-workstream template copies + premature/empty scaffolds tax every workstream. Evidence: 8/8 duplication (byte-identical); moneypuck blank FINAL_REPORT during pending; landing empty research/ + full ceremony on demo scope. Change: single versioned template source (per-workstream only genuine deviations); FINAL_REPORT generated at execution-close or marked DRAFT; kickoff prunes unused scaffolds. Effect: removes drift/fan-out cost and premature-done misreads.

**4. Make pre-gate WIP and staleness visible (draft registration + heartbeats + nudges).**
Problem: real work is DB-invisible until gates pass, and stalls are silent. Evidence: auth 8 specs/0 rows by FK design; moneypuck running jobs ~1 day stale; prospect 5-day silent stall; foundation 6-day owner tail. Change: draft/unapproved job registration; running-job heartbeat or checkpoint handoffs; nudge on open assignment with no artifact delta > N days. Effect: loss/divergence window closed; stalled-agent vs stalled-human distinguishable.

**5. Split report-vs-evidence registration; enforce durable, deduplicated evidence.**
Problem: indexes conflate synthesis with fragments and store redundant bulk. Evidence: foundation 43 rows/10 topics; shared identical before/after diff pairs + stacked superseded logs; foundation /tmp citations; moneypuck 370-file evidence without manifest. Change: `research_reports` (one per topic) vs `research_evidence` (fragments); keep final + reconciliation log, drop identical pairs; require in-workstream evidence (or explicit log-loss acceptance); manifest + generator reference for matrix JSON. Effect: usable indexes, smaller durable footprint, future auditors can re-inspect.
