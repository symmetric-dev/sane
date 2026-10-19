# Shared context audit — Option A (hook removal, user-authored prompt composition)

## 1. Segment/channel model (`context-package.ts`)
- `ContextSegment.channel` (`context-package.ts:10`): `standing` | `dynamic` | `native-role-reference`.
- `renderContextDelivery` (`:63-98`): role asset → `standing` iff `injectRole=true`, else `native-role-reference` (`:71`); framework/procedure-index/initial/assignment → `standing` (`:72-93`); `session` → sole `dynamic` (`:94`); hashes `staticHash/dynamicHash/payloadHash` (`:96-97`).
- DIES: channel distinction as delivery mechanism; `native-role-reference` vs `standing` fork; `injectRole` flag; procedure-index selective-loading indirection; `--append-system-prompt-file`, `instruction-entry:sane.context`, `SessionStart`/`UserPromptSubmit` hook wires.
- REUSED by composer: `ContextAsset`/`ContextPackage`/`ContextPackageRef` model (`:7-9`), `createContextPackage` (`:20-38`), `contextAsset`+`contextHash` (`:6,:14`), per-segment `sha256` + standing/dynamic/payload hashes.

## 2. Delivery guards (`context-delivery.ts`, `bridge.ts:443-471`)
- `prepareContextDelivery` (`:19-36`): null if no `saneContext.package`; provider fetch → `validateProvided` (structural + `provider.validate` recomposition) → binding check (`run/sessionId, nativeSessionId, authorityId, harness, cwd, packageRevision`) → emits `prepared` full-delivery event → returns delivery.
- `assertContextCurrent` (`:38-51`): re-fetch + revalidate + exact compare (`payloadHash, packageRevision, binding, segments`) else "prompt withheld".
- KEEP guarantees in composition world: trusted-input recomposition (`validateContextComposition`, `context-package.ts:137-144`), exact binding check, pre-dispatch revalidation (recompose-and-compare before user message send).
- HOOK ARTIFACTS (die): `ContextProvider`/`validate` async hook plumbing, `prepared` full-byte event, guard-closure `assertDispatchState`/`assertSource` wrappers, idle-gate coupling.

## 3. Call sites (bridge + run services)
- `bridge.ts:377` `saneSession` dep = `saneSessionText(meta, executionCheckout)` (legacy dynamic fallback).
- `bridge.ts:460-461` `canonicalComposition`: dynamic = `explicitProtocolDynamic(branchContextDynamic(saneSessionText…))`; `injectRole = !!saneExecution || (oc && !nativeAgentSelected)`.
- `bridge.ts:463-471` `canonicalContext` provider + `validate` (recomposition attestation).
- `opencode-run-service.ts:484,489,498` compact: prepare → `deliverContextEntry(standing+\n\n+dynamic)` → `stored-readback` receipt → `assertContextCurrent` pre-dispatch. `:586-590` legacy `saneSession`→`deliverSaneSession` iff no package. `:597-602,625` prompt path mirrors compact.
- `claude-run-service.ts:483-485` prepare + write `${runId}.canonical-context.md` (standing); `:495-497` execution policy snapshot; `:508-514` dynamic = `canonical.dynamic` else legacy `saneSession`, written to `.sane-session.md` + `session-context.ts` hook; `:390` `hook-accepted` receipt on UserPromptSubmit stdout ack; `:543-544` `assertContextCurrent` + `configured` receipt.
- `opencode.ts:339-344` `configureCanonicalExecution` RPC + ack check (transport, not hook).

## 4. Receipt consumers (`canonical-context` events)
- `scripts/context-report/report.py:210,212,232,248,273,279,289,322` + `README.md:45-49` + `test_report.py:30-67,157-160`: offline Word audit; stages `prepared/configured/stored-readback/hook-accepted` ("none proves model-request inclusion").
- Tests only: `bridge-runtime.test.ts:4583-4624` (stage sequences), `opencode-run-service.test.ts:51-52`, `claude-run-service.test.ts:44-45`, `tests/context-foundations.test.ts:76,127`, `canonical-claude-capture.integration.test.ts:182-183`. No UI consumer found (events API surfaces them; grep shows no frontend reader).
- DIES: `hook-accepted` stage entirely; `configured`/`stored-readback` as native-mutation evidence. A composer needs one new receipt: composed-hash + send-ack.

## 5. `injectRole:true` + execution config — survives
- `canonical-agent-operations.ts:293` `claudeExecutionConfiguration` returns `injectRole:true` (comment `:253-256`: role delivered by App standing context exactly once; `:278-281` empty `sane-app-execution` prompt preserves native prompt). Flag itself DIES (no second-channel role injection in composition world — role text is just composed bytes).
- `configureCanonicalExecution` / `openCodeExecutionConfiguration` (`opencode-run-service.ts:84-99`, `opencode.ts:339`, `canonical-agent-operations.ts:127-159`) configures native role/permission/model/children via App RPC (`sane-execution/configure`), NOT via hook or injection channel → survives untouched. CC equivalent (`--agents/--agent/permissions`, `claude-run-service.ts:499-523`) likewise launch-args, not hooks — survives except `--append-system-prompt-file` (`:524`) which dies.

## 6. Dynamic producers (composer reuses)
- `agent-launch.ts:57-59` `saneSessionText` ← `sane-core/sane-context.ts:114` `sessionContext` (workstream/roots). `agent-launch.ts:30-43` `workerAssignment` ← `workerContext` (`sane-context.ts:147`). `branch-context.ts:10` `branchContextDynamic`; `bridge.ts:436-442` `explicitProtocolDynamic` (explicit-v1 suffix). Composer calls these as pure string functions; only their hook file-writes die.

## 7. KEEP (with reason)
- `validateContextPackage/Binding/Delivery/Composition` + `contextHash` + revision/payload hashes: tamper-evidence independent of transport; composer reuses for byte-exactness.
- Package model + `ContextPackageStore`/`CanonicalExecutionStore` pins: trust root for recomposition checks.
- Binding fields (`sessionId/harness/authorityId/nativeSessionId/cwd`): still the pre-send identity gate.
- Execution policy translation (`canonical-agent-operations.ts` permissions/model/children/diagnostics): native launch config, not context injection.
