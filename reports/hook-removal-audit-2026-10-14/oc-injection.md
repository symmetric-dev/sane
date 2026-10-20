# OC context delivery — removal inventory

Apply the [shared context contract](shared-context.md) under the [plan's blank-slate scope](PLAN.md#scope-and-blank-slate-decision). These are native context-injection channels, not necessarily hooks.

## REMOVE — sinks and delivery-only plumbing

| Source / symbol | Required removal |
| --- | --- |
| `src/opencode.ts` `deliverSaneFramework`; bridge conversation/worker/handoff-recipient creation | Delete the creation-time "SANE framework" `/synthetic` request and its callers. |
| `src/opencode.ts` `deliverSaneSession`; `src/opencode-run-service.ts` `executeNative` | Delete first-run "SANE Session" synthetic delivery and `session-block` emits. |
| `src/opencode.ts` `deliverContextEntry`; run service `executeNative` / `executeNativeCompact` | Delete `sane.context` instruction-entry GET/PUT/readback, storage receipts, and sink-specific preparation. |
| Bridge/run service `FrameworkDelivery` / `frameworkDeliveries` / `takeFrameworkDelivery`, `launchEvidence` | Delete creation-ack plumbing and `framework-delivered` emits/readers. |
| `OpenCodeRunDependencies.saneSession` and bridge wiring | Delete sink-only dependency; reuse pure `saneSessionText` in shared composition. |
| Adapter members and `bindSaneSession` / `boundSaneSession` / `rebindSaneSession` | Delete SANE metadata-context writers/readers and compatibility-only callers. |
| `src/agent-launch.ts` `saneFrameworkMessageId` / `saneSessionMessageId` | Delete unused synthetic-only IDs; retain reusable text builders. |
| `src/opencode.ts` `activity` SANE startup-context-synthetic exclusion | Delete the retired context exception, not unrelated native synthetic/activity behavior. |

## KEEP — execution and observation

- `select`, `assertIdle`, `prompt` / `promptQueuedHandoff`, and `preflightNativeSession`: model routing, prompt transport/admission, and idle/binding gates.
- `snapshot` / `observeCommand` / `compactionSnapshot` / `activity` / `history` / `interactions` / `compact` / `cancel` / `cancelInput`: observation and control.
- `launchEvidence` / `monitorNative` / `monitorNativeCompact` / `finishNative` / `interruptSubmission`: lifecycle skeleton, minus context sinks.
- Canonical activation/reservations, package stores, trusted validation, and `configureCanonicalExecution` permission/model/child configuration. Separate full-context loading from ordinary execution-policy validation as required by [performance.md](performance.md).

## Adapter-specific constraints

- **Queued sends:** remove `allowMutation=false` entry-equality/409 logic with the storage channel. Validate selected prompt/context and binding before enqueue, preserving exact command admission and ambiguous-ack reconciliation. Do not turn a stored-context difference into an automatic prompt prefix. Pre-enqueue validation does not guarantee execution-time freshness.
- **Compaction:** remove context-entry work from `executeNativeCompact`, keeping native transport/lifecycle. `compact(id, requestId, beforeSubmit)` carries a request ID, not context text; do not prefix `/compact`, send extra synthetics, or invent compact-time reinjection.

Dispatch/readers are listed in [consumers.md](consumers.md); coverage dispositions are in [tests.md](tests.md).
