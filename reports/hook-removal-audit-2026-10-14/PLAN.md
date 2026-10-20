# Implementation plan — SANE-owned context through prompts

Revised 2026-10-20; supersedes the original "complete hook removal" proposal. Paths throughout these reports are relative to `packages/sane-app/` unless qualified. Source references use symbols rather than audit-era line numbers.

## Reading guide

| Document | Owns |
| --- | --- |
| [shared-context.md](shared-context.md) | Authoritative context placement, composition, validation, and evidence contract. |
| [cc-injection.md](cc-injection.md) | Claude context mechanisms to remove and operational infrastructure to retain. |
| [oc-injection.md](oc-injection.md) | OpenCode context mechanisms to remove and adapter-specific constraints. |
| [consumers.md](consumers.md) | Call sites, presentation/evidence readers, retained hook consumers, and follow-on documentation. |
| [tests.md](tests.md) | Coverage to rewrite, retain, and delete. |
| [performance.md](performance.md) | Performance evidence, acceptance criteria, remaining costs, and measurement plan. |

## Scope and blank-slate decision

Replace harness-specific context delivery with SANE-owned prompt composition under the [shared contract](shared-context.md). Keep process/activity/background-job hooks and execution safeguards. This prepares the context layer for Grok Build and Antigravity; their adapters, compaction preservation/recovery, and skill/procedure policy changes are separate work.

- Start with fresh SANE data **and fresh native sessions**, without active old runs. Old OC instruction entries and CC hook/system context are not adopted by reattaching to old sessions.
- Breaking context schema/API/config changes are allowed. No migration, backward compatibility, legacy context readers, dual modes, rollout flags, historical imports/parity tooling, or in-flight executor transfer.
- Delete retired writers and context-only readers rather than building sidecar GC, native-entry cleanup, or adoption utilities.
- Resume, restart, branches, queue uncertainty, and no-replay guarantees still apply to new-model sessions. Blank-slate deployment does not remove future recovery obligations.

## Phase 0 — Pin the prompt contract

1. Finalize implementation-facing message kinds from the placement table in `shared-context.md`; do not invent a parallel public operation API without need.
2. Define exact block boundaries and ordering, plus a shared body-extraction helper for titles/classification. Keep authored message bodies distinguishable from composed transport text.
3. Decide how SANE records a submitted activation/update and its package/binding. Do not use hook acknowledgments, an in-memory-only marker, or text scanning as the new source of truth. Reuse existing durable run/submission evidence where possible; do not add a parallel delivery state machine without need.
4. Pin how existing run/submission evidence represents bootstrap and inherited branch context across resume/restart.
5. Separate retained lifecycle hook configuration from context injectors. No replacement of `stoppedTurns`/`turnHooks` is required by this work.

Done: encoding, placement inputs, and durable activation/update evidence are specified before runtime changes.

## Phase 1 — Shared composition and evidence

1. Implement the shared composition boundary and message/body extraction contract.
2. Reuse `ContextAsset`, `ContextPackage`, hashes, trusted pinned inputs, and the pure dynamic producers (`saneSessionText`, `workerContext`, `branchContextDynamic`, `explicitProtocolDynamic`). Adapt delivery-channel types without discarding their integrity guarantees.
3. Keep binding, source, cancellation, and ownership checks at dispatch. Validate/recheck selected context for context-bearing messages; do not require full context recomposition/reinjection merely to send ordinary input.
   - Check indirect paths too: execution-policy validation currently loads paired context through `validateCanonicalActivation`. Separate that repeated context work from ordinary dispatch without weakening execution-policy/binding checks. Removing the context sink alone is insufficient.
4. Implement composition evidence linked to existing submission/admission records, following `shared-context.md`.
5. Resolve main-role prompt ownership so activation contains the selected role once. Preserve native-child role definitions and execution-policy configuration. Retire `injectRole` only after remaining callers are accounted for.

Done: harnesses share the same composition contract and ordinary-message fast path; selective procedure loading is unchanged.

## Phase 2 — Claude context-only removal

1. Wire composed text into the ordinary prompt path in `src/claude-run-service.ts`.
2. Remove the mechanisms in [cc-injection.md](cc-injection.md), jointly removing their acknowledgment/failure gates.
3. Retain the listed operational hooks, settings/permissions, result integrity, and process/queue handling.

Done: no SANE context is returned by hooks or appended as a system-prompt file; operational hooks still function.

## Phase 3 — OpenCode context-channel removal

1. Wire composed text into `prompt` / `promptQueuedHandoff`.
2. Remove the sinks, receipt plumbing, and legacy metadata helpers in [oc-injection.md](oc-injection.md), including context-entry work in the compact path.
3. Replace queued entry-equality checks with selected-message/binding validation. Preserve exact admission, ownership, cancellation, and uncertain-submission reconciliation.
4. Retain execution configuration, observation, interruption, and compact transport; do not add compact-time context injection.

Done: no SANE synthetic context messages or instruction-entry writes are needed for the prompt-based path.

## Phase 4 — Callers and consumers

1. Update dispatch callers, body/display extraction, and journals using [consumers.md](consumers.md).
2. Replace review/context-report checks for the new contract only; remove context-only readers without deleting operational hook evidence.
3. Preserve native-worker/handoff routes and authenticated operational hook ingestion.
4. Update the follow-on documentation listed in `consumers.md` when implementation lands; skill/context edits remain separately authorized.

## Phase 5 — Delete obsolete modes and validate the new model

- Remove the `contextDelivery` startup/canonical selector from config, CLI, banner, and context dispatch. Do not add a third `composed` mode. Preserve canonical execution/pinning independently of the deleted transport switch.
- Remove migration-only package activation markers, append-file upgrade workarounds, old context schemas/receipts/readers, and compatibility-only tests. Keep only state required by the new model and operational hooks.
- Apply [tests.md](tests.md) to the new-model scenarios and retained lifecycle-hook behavior.
- Apply [performance.md](performance.md) to the complete dispatch path, including indirect package loads through execution validation. Keep bootstrap/update costs separate from ordinary messages and retained operational costs.

Done: one prompt-based context path works on fresh sessions without context hooks, synthetic context messages, native instruction entries, or legacy-mode branches. Process/background hooks remain intact. The context layer has no CC/OC-specific delivery requirement for future harnesses.

## Status and work boundary

Documentation only: no runtime, test, skill/context, process, or data changes were made. No tests, benchmarks, or browser checks were run. Runtime implementation and test/benchmark execution require requested work; tests must remain focused. An actual blank-slate reset must name its target directories/native sessions, not delete broad paths.
