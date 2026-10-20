# Shared context — SANE-owned composition and placement

Authoritative context contract, revised 2026-10-20. See [PLAN.md](PLAN.md) for scope, blank-slate decisions, document navigation, and implementation order.

## 1. Ownership and message contract

SANE decides what context a recipient needs and when to send it. Shared composition produces prompt content; harness adapters only transport/execute it. Grok Build and Antigravity must not need equivalents of CC context hooks or OC instruction entries to participate.

| SANE operation | Context placement |
| --- | --- |
| New activation/bootstrap | Selected role, framework, initial procedure references/content, assignment where applicable, and current session context, composed once. |
| Ordinary follow-up/resume | Message body; no automatic standing or dynamic block. |
| Explicit context update | Selected changed/relevant context with its meaning/provenance; not an unconditional full package resend. |
| Worker launch | Worker activation plus its structured assignment. |
| Handoff/report/exchange | The selected shared context and attributed message; bootstrap only if the recipient actually needs activation. |
| Branch | Respect the selected inherited history/context; add branch-specific content or an explicit activation/update as needed, not a blanket standing prefix. |

This is not a requirement to invent a new public operation API: record these decisions in the existing SANE lifecycle/sharing paths where possible. Compaction preservation/recovery is separate work.

Membership, roots, assignment, branch, and protocol changes are inputs to deliberate context updates when needed. A prompt send, revision change, or restart alone is not a reason to resend standing context.

## 2. Reuse the package model; retire transport channels

- `src/context-package.ts`: reuse `ContextAsset`, `ContextPackage`, package references, `createContextPackage` / `validateContextPackage`, and pinned sources.
- `renderContextDelivery` currently chooses role `standing` vs `native-role-reference`, assembles framework/procedure index/initial/assignment, and always adds a dynamic Session segment. Refactor this into explicit selected prompt composition; do not keep "render all context for every run" as the new API contract.
- Retire channel semantics tied to `--append-system-prompt-file`, `instruction-entry:sane.context`, and context-returning SessionStart/UserPromptSubmit commands.
- Preserve selective procedure/resource loading and pinned references. Removing that policy or inlining every procedure is not required by transport removal.
- Resolve main-role prompt ownership and then remove obsolete `injectRole`/channel forks. Keep native-child role definitions and non-context execution configuration.

## 3. Preserve trust and dispatch guards

`src/context-delivery.ts` `prepareContextDelivery` / `assertContextCurrent` currently fetch a provider, validate trusted composition, check binding, journal delivery, and recheck currency. These are not all hook artifacts.

- Reuse trusted pinned-input recomposition, structural/hash validation, and binding fields (`sessionId`, `harness`, `authorityId`, `nativeSessionId`, `cwd`, revision).
- For a context-bearing message, validate the actual selected composition and recheck its dependencies before sending; do not silently send stale or foreign-bound content.
- Ordinary prompts retain source/binding, ownership, cancellation, and transport guards without automatically loading/reinserting the full context package.
- Define context boundaries and body extraction once. Titles/classification/display use the authored body; the audit retains exact sent bytes. User-supplied lookalike markers are not delivery evidence.
- Adapt provider/emitter interfaces as needed; remove obsolete sink-specific events/stages. Do not delete `assertDispatchState`/`assertSource` or async validation merely because the transport changed.
- After native enqueue, existing uncertainty/ownership semantics still apply; pre-send validation does not freeze context until native execution.

## 4. Producers and integration points

- `src/agent-launch.ts` `saneSessionText` / core `sessionContext`: workstream and roots.
- `src/agent-launch.ts` `workerAssignment` / core `workerContext`: structured assignment.
- `src/branch-context.ts` `branchContextDynamic`: branch-specific context.
- `src/bridge.ts` `explicitProtocolDynamic` and `canonicalComposition`: protocol, selected package, binding, and trusted inputs.
- Reuse these as pure content producers when SANE selects a bootstrap/update/sharing payload. A producer being called today on every run is not a requirement to preserve that cadence.
- The shared boundary composes once; bridge callers decide placement and harness run services transport final bytes. Do not have both layers independently prefix the same package.

## 5. Evidence, not native delivery rituals

Retire new `configured`/`stored-readback`/`hook-accepted` context receipts with their sinks. Replace them with composition evidence tied to the actual message: operation kind, package revision/provenance, selected content hashes, and complete outgoing-text hash as appropriate. Reuse existing durable submission/admission evidence rather than creating a second transport state machine.

Composition proves constructed bytes, pipe/HTTP submission proves its documented transport stage, and native acknowledgment proves its documented admission stage. Keep uncertainty explicit; do not combine these into a fabricated model-consumption acknowledgment. Define enough durable evidence to distinguish bootstrap from later ordinary messages across restart; do not use an in-memory-only ack map or repeated full prefixes as the solution.

See [consumers.md](consumers.md) for journal/review readers and [tests.md](tests.md) for coverage. The ordinary-message work budget is defined in [performance.md](performance.md).

## 6. Execution and operational hooks stay

- `src/canonical-agent-operations.ts` `claudeExecutionConfiguration`: CC selected execution agent has an empty main prompt; children have their actual role prompts. Put selected main-role content in SANE activation without duplicating it in native configuration.
- `configureCanonicalExecution` / `openCodeExecutionConfiguration` and CC `--agents` / `--agent` / permission settings retain execution-policy, model, child, and permission duties. The native context-entry sink is what goes away.
- Forwarding, authentication, process ownership, turn/background-job observations, and native-worker/handoff transports remain. Operational hook failure is not automatically harmless merely because context hooks were removed.
