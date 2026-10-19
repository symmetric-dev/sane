# OC Injection-Path Audit — Option A (hook removal) — 2026-10-14 (read-only)

## REMOVE — native-context mutations
1. `opencode.ts:310` `deliverSaneFramework` (synthetic `/synthetic`, desc "SANE framework") — fires ONCE at native creation, before any run. Call sites `bridge.ts:474-479` (def; skips `context.package`), `bridge.ts:1663` (conversation create), `bridge.ts:806` (handoff recipient), `bridge.ts:2033` (worker). Journaled via `frameworkDeliveries` map (`bridge.ts:473`, `bridge.ts:1356` `takeFrameworkDelivery`) → consumed `opencode-run-service.ts:311-312` in `launchEvidence`, emits `framework-delivered` context event.
2. `opencode.ts:315` `deliverSaneSession` (synthetic, desc "SANE Session") — fires EVERY non-queue run at startup: `opencode-run-service.ts:585-594` (`executeNative`; gated `!resume && !session.saneContext?.package`), uses `deps.saneSession` + `saneSessionMessageId` (`agent-launch.ts:53`), emits `session-block` context event (`:592`). Canonical pkg sessions skip; resume runs skip.
3. `opencode.ts:321` `deliverContextEntry` (PUT instruction-entry `sane.context` + readback) — fires EVERY run AND EVERY compaction: `opencode-run-service.ts:597-603` (`executeNative`, `allowMutation=!queued`; queued runs throw 409 on change), `opencode-run-service.ts:484-490` (`executeNativeCompact`, `allowMutation=true`). Paired with `prepareContextDelivery`/`assertContextCurrent`/`contextReceipt` (`stored-readback`, key `instruction-entry:sane.context`).
4. `opencode-run-service.ts:27` adapter surface `Partial<Pick<...>>` — injection-only members become dead: `deliverSaneSession`, `deliverContextEntry`, `bindSaneSession`, `boundSaneSession` (no prod call sites; tests forbid at `opencode-run-service.test.ts:108-109`, `opencode-native-queue.test.ts:24-25`). `configureCanonicalExecution`, `preflightNativeSession`, `promptQueuedHandoff`, `history`/`observeCommand`/`cancelInput` are NOT pure injection (see KEEP/open questions).
5. `opencode.ts:366-379` `bindSaneSession`/`boundSaneSession`/`rebindSaneSession` (legacy native metadata binding) — zero production call sites; delete or leave dead. Only exercised by `opencode-native-queue.test.ts:129-131` (read-only observe test).
6. `bridge.ts:377` `saneSession` dep (`saneSessionText`, `agent-launch.ts:57`) + `bridge.ts:1358,729` wiring into `OpenCodeRunDependencies.saneSession` (`opencode-run-service.ts:49`) — exists only to feed item 2. Remove with it.
7. `bridge.ts:473-479,1356` + `opencode-run-service.ts:41,57,311-312` `FrameworkDelivery`/`frameworkDeliveries`/`takeFrameworkDelivery` plumbing + `framework-delivered` journal event — exists only to journal item 1. Remove with it.
8. `agent-launch.ts:45-55` `saneContextText`/`saneFrameworkMessageId`/`saneSessionMessageId` — stable IDs making retried creation idempotent; dead after 1+2 unless reused by user-authored composition.

## KEEP — not delivery (reason)
K1. `select` (`opencode.ts:280`; calls `run-service.ts:583`, tests `:107`) — model/variant routing, not context. KEEP.
K2. `assertIdle` (`opencode.ts:406`; calls `:482,:497,:581,:620`, `bridge.ts:1319,1690,2198,2299,2416,3202`) — pure read gate (`activity` `:396-405`; startup synthetics excluded from pending). KEEP.
K3. `prompt` / `promptQueuedHandoff` (`opencode.ts:287,294`; calls `:637`) — user-prompt transport + durable command ID. KEEP.
K4. `snapshot`/`observeCommand`/`compactionSnapshot`/`activity`/`history`/`interactions`/`compact`/`cancel`/`cancelInput` — observation + compaction transport + interrupt. KEEP.
K5. `preflightNativeSession` (`opencode.ts:304`; calls `run-service.ts:623`, `bridge.ts:1676`) — read-only identity/checkout pin, no mutation. KEEP (reclassify, not injection).
K6. `launchEvidence`/`monitorNative`/`monitorNativeCompact`/`finishNative`/`interruptSubmission` skeleton — lifecycle/observation; strip only the context-delivery lines inside. KEEP minus items 1-3.
K7. `canonicalActivation`/`validateCanonicalActivation`/`prepareCanonicalExecution` (`bridge.ts:47,401,423,737,1649,3128-3130`, `user-input-preparation.ts`) — pre-dispatch validation + reservation, no native write. KEEP (feeds user-authored composition under Option A).
K8. `canonicalContext` provider + `validateContextComposition` (`bridge.ts:463-470`, `context-package.ts:81`) — trusted-composition validator; under Option A it validates user-authored text rather than delivering it. KEEP validator, remove only the `deliverContextEntry` sink.

## Test pins to update
T1. `opencode-run-service.test.ts:9-56` (6+ tests: authored-parent-once, unvalidated-withhold, kind×mode receipt-before-submission, fault withhold) — pin `deliverContextEntry` + `configureCanonicalExecution` + `canonical-context` receipts. Rewrite or delete under Option A.
T2. `opencode-run-service.test.ts:436-451` framework-delivered journaling (compact true/false) via `takeFrameworkDelivery` — delete with item 7.
T3. `opencode-run-service.test.ts:108-109,125,130,157` fixture forbids bind/read-legacy, `takeFrameworkDelivery:()=>undefined`, `saneSession:()=>null` — simplifies after removal.
T4. `native-context-entry.test.ts:27-49` (5 tests: exact-bytes, 409-on-change, readback, guard-cancel) — directly pins `deliverContextEntry` semantics. Delete or repurpose as composition-validator tests.
T5. `opencode-native-queue.test.ts:24-25,54,129-131,372,444,538-540,670-679` — pins `bindSaneSession`/`boundSaneSession` forbidden-or-observe, `preflightNativeSession` binding-read, `deliverSaneSession` zero-effect under unknown policy. Keep preflight pins, delete delivery pins.
T6. `opencode-retry-projection.test.ts` (5 tests) — zero injection pins (pure retry normalization/journal/transcript). NO CHANGE.

## Open questions
Q1. `configureCanonicalExecution` (`opencode.ts:339`, `run-service.ts:84-100`, `bridge.ts:411-423`): native agent-role registration via RPC — is this "SANE context injection" (remove) or execution plumbing (keep)? Tests `run-service.test.ts:15-19` pin it.
Q2. Under Option A, who composes `saneContextText` output — kept `agent-launch.ts:45` as a pure string builder for prompt prefixing, or fully re-authored by callers?
Q3. `activity()` startup-synthetic exclusion (`opencode.ts:404` `saneStartupContext`) — dead after synthetics removal, or retained for pre-removal native histories?
Q4. Queued-delivery 409 path (`deliverContextEntry` `allowMutation=false`, `run-service.ts:600`) currently withholds prompts on context drift — what replaces the staleness gate when context is prompt text?
