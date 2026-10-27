# Shared user-context integration

Start with the [production cutover report](context-message-cutover-2026-10-26/README.md).
It distinguishes implemented code, offline evidence, and refused/unqualified paths.

## Current contract

Explicit activation composes selected context once. Ordinary Base and SANE input
is the authored body only; preparation does not reconstruct activation from
journals/native history or validate context packages/execution policy. SANE
continuation checks paired lifecycle metadata, ready admission and known
unsupported states, not historical delivery or continuous native retention.
Selected updates retain source-currency checks; native execution policy is loaded
separately for execution configuration. Ownership, cancellation, exact-wire and
durable publication fences remain. See the cutover report for boundaries and the
[operator guide](../packages/sane-app/HUMAN-OPERATOR-GUIDE.md#sane-context-and-message-receipts)
for read-only inspection and receipt recovery.

## Historical milestones

| Milestone | Report | Checkpoint |
| --- | --- | --- |
| Selective composer and guarded engine | [Foundation](context-engine-foundation-2026-10-25/IMPLEMENTATION.md) · [tests](context-engine-foundation-2026-10-25/TESTING.md) | `ba3743a` |
| Real engine/store/journal with simulated transport | [Walkthrough](context-engine-demo-2026-10-25/REPORT.md) | `07fd4db` |
| Main sync and evidence preservation | [Sync audit](context-engine-sync-2026-10-25/README.md) | `5545f18` |
| Canonical preparation/codec fixes | [Codec report](context-engine-codec-fix-2026-10-25/README.md) | `b938d6a` |
| Single bridge journal writer and fsync fences | [Journal report](context-bridge-journal-2026-10-25/README.md) | `e795ef9` |
| Durable metadata and original pending-journal adoption | [Durability report](context-activation-durability-2026-10-25/README.md) | `56354b4` |
| Shared-channel production adapter cutover | [Cutover and current contract](context-message-cutover-2026-10-26/README.md) | Uncommitted at report creation |

The dated reports describe their stage at verification time, not current delivery
configuration. Earlier statements that adapters were unwired remain historical.
The cutover report's captured test counts likewise describe its original dated
verification, not a fresh result for the current working tree.

## Source, evidence, and privacy

- `experiments/` contains reusable source and regression/demo tooling, not active
  production delivery. Keep it tracked.
- `reports/user-context-*/` is ignored, including its narrative summaries, by
  explicit user request. Previously tracked files were untracked in `91e5df3`;
  local originals were preserved. Git history was not rewritten.
- Implementation reports and selected verification artifacts remain tracked or
  available for the next implementation commit. Raw `.log` files are generally
  ignored; dated reports identify retained local output where applicable.
- The [current verifier](context-message-cutover-2026-10-26/verify.ts) is preserved
  in the repository. It uses already-installed dependencies and performs no
  installation, native discovery, browser check, or live model call.
- Old mock/native experiments and short response probes do not establish complete
  native workflows, compaction survival, or model consumption of context.
