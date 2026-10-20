# Performance — worker dispatch and context-channel removal

Recorded 2026-10-20 from static code inspection: identified work and implementation targets, not measured bottlenecks or promised speedups. Scope is in [PLAN.md](PLAN.md); placement and safety rules are in [shared-context.md](shared-context.md).

## Goal

Make ordinary worker messages cheap by removing repeated context preparation and harness-specific delivery, not merely by replacing hook subprocesses with equally expensive prompt construction on every send.

This document owns the work budget for that shared contract, plus candidates that remain outside context-channel removal.

## Work the cleanup can remove

| Current work | Source / evidence | Expected change |
| --- | --- | --- |
| Repeated package loading and asset verification | `src/context-delivery.ts` `prepareContextDelivery` and `assertContextCurrent` each call the provider and its validator. In `src/bridge.ts`, both independently call `canonicalComposition`, which calls `contextPackages.load`. The successful preparation + freshness path therefore performs four context-package loads, before other execution-policy/activation work. | Remove this pipeline from ordinary messages. Validate selected bootstrap/update content when SANE actually sends context, not on every dispatch. |
| Filesystem/hash work inside each load | `src/context-package-store.ts` `load`: read/validate manifest, resolve/check paths, open/read/hash each asset. | Avoid repeated context asset I/O on the ordinary worker-message path. Removing only the sink while keeping these reads would miss a major opportunity. |
| Serialized native context requests | `src/opencode.ts` `deliverContextEntry`: GET if bytes already match; otherwise GET → PUT → GET. Queued dispatch also reads the entry. | Zero instruction-entry requests. The selected message goes through normal prompt transport. Legacy creation-time SANE synthetic requests also disappear, though canonical package sessions already skip those synthetics. |
| Context injector subprocesses and sidecars | `src/claude-run-service.ts`, `hooks/session-start.ts`, `hooks/session-context.ts`: write context files, run injector commands, read those files, create `.delivered`; canonical standing context also gets an append-file. | No context injector subprocesses, context sidecar/marker I/O, or append-file delivery. Framework startup injection applies to legacy sessions; canonical dynamic injection applies on ordinary canonical launches. |
| Duplicated context journaling/serialization | `src/context-delivery.ts`: full prepared delivery event, cloning, structural/hash validation, and later receipts; run services add native-delivery acknowledgment stages. | Record selected composition/provenance with the actual bootstrap/update message and reuse submission evidence. No full-context delivery ritual on ordinary messages. Retain exact sent bytes and required durability. |
| Context acknowledgment dependencies | CC dynamic/framework hook gates and OC stored-readback acceptance. | Fewer pre-execution dependencies and context-specific failure paths. Preserve actual transport/admission uncertainty; do not replace them with another acknowledgment protocol. |

Worker fan-out multiplies per-worker work, and continuations multiply per-message work. Removing those operations should reduce SANE-side preparation, I/O, and contention; the wall-clock benefit depends on which costs dominate. Bootstrap still needs its selected content. No model-speed, token-cache, throughput, or percentage speedup is established by this inspection.

## Acceptance criteria for the ordinary worker-message path

For an already-active worker receiving ordinary input, with no selected context update:

- **Zero context-asset reads**, including indirect reads through paired context/execution validation. Preserve execution-policy validation without dragging the full context package back into each send.
- **Zero context sidecar or delivery-marker writes.** Permission/operational settings and required run/journal writes are not context sidecars and may remain.
- **Zero context-injection subprocesses.** Operational forwarding subprocesses remain and must be counted separately.
- **Zero instruction-entry requests or SANE synthetic-context delivery requests.**
- **No standing/dynamic context reinsertion or duplicate full-context preparation event.** Normal body composition, message hashing, and submission journaling are allowed.
- Fresh native identity/checkout, ownership, cancellation, permissions, durable command identity, and ambiguous-ack no-replay guarantees remain intact.

Check the complete dispatch path, not just the new composer. `src/user-input-preparation.ts` `validateCanonicalActivation` currently loads context alongside execution; `canonicalExecution` calls it. Leaving that coupling untouched could retain package reads even after removing `prepareContextDelivery`.

Apply the same no-automatic-context rule to reports/exchanges and existing-recipient handoffs. If SANE explicitly selects additional shared context for an operation, account for that selected work separately rather than calling it ordinary pass-through.

## Costs that remain — separate optimization candidates

1. **Operational hook forwarding:** `hooks/forward.ts` still starts for registered events, reads input, awaits local HTTP forwarding, and waits for authenticated ingestion/journaling. Removing context injectors does not remove per-tool/activity forwarding overhead. Reducing event volume or changing transport needs a separate review of process/background-job and authentication consumers.
2. **Activation/package materialization:** package creation, asset validation, durable publication, and repeated execution/context validation during worker launch remain candidates. Consider safely reusing verified content-addressed work only with an explicit integrity/invalidation model; do not casually cache mutable binding or permission decisions. Caching is not an assumed benefit of hook removal.
3. **Execution configuration:** `src/opencode-run-service.ts` `configureExecution` loads policy, constructs/journals configuration, and calls the native execution RPC on each relevant run. CC launch also performs policy/version/settings work. This cleanup does not automatically eliminate those costs.
4. **Native startup:** session creation, CLI process startup, model admission, queue waiting, and inference remain. Native children and SANE-managed workers have different execution paths; do not assume equal gains.
5. **Worker invocation-evidence retries:** `src/bridge.ts` worker caller validation has 150 ms retry sleeps when evidence is not yet visible. Those waits are conditional, not a fixed cost of every call; retain evidence/authentication guarantees.
6. **Observation and durable state:** polling, journal processing, catalog/admission work, and persistence can still dominate. Removing unrelated durable writes or ownership checks is not a safe shortcut.

## Measurement plan for requested implementation work

Separate SANE preparation from native/model latency. Use monotonic durations correlated to the existing worker/request/run/command identity; do not log prompt contents or add a durable write for every timing marker.

Capture these boundaries where available:

- Worker request received → launch admitted/reserved.
- Launch preparation: package/policy work, native creation, assignment composition, and ready-to-dispatch.
- Ready-to-dispatch → transport submission → exact native admission, where the harness exposes it. CC pipe completion is submission evidence, not native acceptance; report unsupported stages as unavailable.
- Submission/admission → first output → completion observed / parent notification.

Count context-package loads and asset reads, context-file writes, injector processes, instruction-entry/synthetic-context requests, context journal bytes, and retained operational hook calls separately. Compare bootstrap vs ordinary continuation vs explicit update, by harness, both singly and at representative worker fan-out. Report latency distributions and failures, not just an average; avoid attributing model/queue variability to SANE preparation.

Use these observations to confirm eliminated work and prioritize the remaining candidates. Work-count regression coverage is described in [tests.md](tests.md); timing instrumentation and benchmarks are separate implementation work.
