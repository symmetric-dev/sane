# auth-infra session/context audit (PROMPT/CONTEXT mechanics only)

Scope: 28 sessions, 121 runs, 11 handoffs (all completed), 0 jobs. Review: 60 err (framework-missing 27, session-block-missing 25, not-in-transcript 2, hook/api/transport 4), 3 warn (interrupted).

## Context delivery (sizes, dataDir `.data-fresh`)
- `session-start.md`: ABSENT for every auth-infra run (0 files). The SessionStart channel carries nothing on disk.
- `sane-session.md`: 176 B stub on 5 delivery runs only (fd2abaad, 5c2451d3, 897fe34d, f6c9f31a, f59590e5) — headers (workstream/root/impl-root) with NO slot/phase/role keys. `delivered` flag present on those 5.
- `canonical-context.md`: 6574–6810 B, only on the same 5 delivery runs (design 6810, engineering 6574 — delta is just the role prompt).
- All worker runs (research/scout/grounders/critics, ~20 sessions) + all mid-conversation assistant runs: `.jsonl` ONLY, zero context files. Their context arrives solely via the submission prompt text.
- Review consequence: framework-missing x27 + session-block-missing x25 = workers/assistants never got synthetic framework msg or Session block; the 2 cc-native creation runs additionally lack transcript `hook_additional_context` (x2).

## Handoff payload patterns (full `input` in sqlite `handoffs`, submission lens)
- Fixed envelope ~1.2 KB on ALL 11: ID/RequestID/Repo/Workstream/Destination/From/Sender-slots/Recipient + 2 boilerplate paragraphs (~1.1 KB: "mandatory Pickup…", "delivery run may only establish Pickup readiness…"). Key sets identical across all 11.
- Phase-kickoff stubs are ~95% boilerplate: design->eng 1272 B (body 53 B: "Start Engineering session…"), eng->planning 1277 B (body 50 B). ~2.4 KB spent to say ~100 B.
- Content handoffs: kickoff 9736 B, research Q 4088/3584 B, research replies 4086/4167 B, eng->design 6683 B, design reply 3180 B, planning->eng 5652 B, eng reply 6927 B.
- Research replies ≈ question length (echo + "user approved…"), i.e. no new findings in the envelope — findings travel via files the agent must re-read.

## 4x design approval as context question (22:10, 00:49, 01:02, 01:53 + eng 03:18)
- Approvals 1->2->3: ZERO handoffs queued between 17:50 and 01:08. Rounds 2-3 iterated on identical handoff context; new context was in-chat only (design runs 00:41/00:44 before approval 2; 00:58 before approval 3).
- Approval 4 (01:53) is the only one with a genuine handoff delta: eng->design 6683 B at 01:50, delivered via run 897fe34d 01:51.
- So 3 of 4 design approvals re-approved evolving in-conversation state with no new delivered context; the approval snapshot hash is the only durable record of what changed.

## Spec-before-registration (8 jobs ~84 KB + PLAN 3 KB on disk, 0 jobs rows)
- Planning->eng handoff (5652 B) is PATH-REFERENCING, not inlining: 3 `.md` path refs, 0 code fences, summaries + "affected 01/05/06/07" pointers. Good: no duplication (specs ~10 KB each >> handoff).
- Cost: recipient must resolve ~6 files from disk; any path drift breaks the link. DB `jobs` table empty so no canonical registry to join against.

## Pre-staged verification (4 checkpoints ~25 KB, job 01 not run)
- INERT files: all 11 handoffs target design/engineering/planning/research — zero handoffs to execution/verification. No consumer, no context carried pre-execution.
- Risk: verification specs ground claims about jobs that don't exist yet in DB; first execution handoff will need to carry or re-derive their relevance.

## Gaps
1. No `session-start.md` anywhere; `sane-session.md` is a phaseless stub — Pickup identity comes only from canonical-context + envelope.
2. Worker context is prompt-text-only and leaves no framework/Session-block evidence (52 of 60 errors).
3. Kickoff stubs pay full envelope for ~50 B bodies; reply envelopes restate scope the recipient already holds.

## Concrete proposals
1. Put slot+phase+requestId into `sane-session.md` (and emit `session-start.md` or drop the channel) so the 176 B stub is self-identifying; fixes Pickup-without-context ambiguity.
2. Add a minimal-handoff template for phase kickoffs (body-only + envelope by reference) — saves ~1.1 KB x N and removes the "delivery != approval" paragraph where it is noise.
3. Register job rows at PLAN acceptance (even as `pending`) so verification/handoff references join to IDs, not bare paths; makes pre-staged specs addressable before execution.
4. Record per-approval context delta (handoff IDs + doc hashes since last approval) in the approval record — distinguishes "re-approval of same context" (rounds 2-3) from "new-context approval" (round 4).
5. Deliver worker framework/Session block as prompt-text evidence the reviewer accepts (or write the synthetic message), eliminating the 52 framework/session-block errors at the source.
