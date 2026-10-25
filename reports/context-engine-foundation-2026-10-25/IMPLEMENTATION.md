# Prompt-context engine foundation

Status: implemented as an inactive foundation; focused static checks passed.
The authorized behavioral-test follow-up found and then fixed one defect;
the focused rerun passes all 361 tests. See [TESTING.md](TESTING.md).
Production delivery integration remains unperformed.

The later isolated [mock engine-path demonstration](../context-engine-demo-2026-10-25/README.md)
also passes its seven scenarios and two corrupt-replay variants. It combines the
real stores/engine/dispatch/journal path with simulated transport, not App wiring.

Scope: implement the shared message engine and its validation/evidence foundation
without replacing current Claude Code or OpenCode delivery. Work takes place in
the `experiment/user-context-delivery` worktree. Implementation status and exact
exports are recorded below as the workstreams finish.

## Workstreams and ownership

1. **Composition:** internal message contract, selected package content, stable
   encoding, authored-body access, structural/trusted validation, pure comparison.
2. **Execution validation:** separate execution-only reads from full activation
   pairing while keeping the old paired API and its callers operational.
3. **Preparation and evidence:** guarded preparation, trusted currentness checks,
   serializable evidence correlated to existing submission/dispatch records, and
   conservative read-only restart/branch projections.
4. **Integration review:** check module boundaries and static compatibility;
   document exact future insertion points rather than switching delivery now.

The initial implementation scope did not authorize tests, live-model calls,
benchmarks, browser checks, or skill/context edits. Static checks are separate
from tests. A later explicitly authorized focused-test follow-up is documented in
[TESTING.md](TESTING.md); a subsequent authorized fix changes only the evidence
decorator. Previously captured PoC
artifacts are retained unchanged.

## Structural direction

### Separate selection, composition, execution, and transport

Lifecycle callers choose activation, ordinary input, selected update/sharing, and
branch inheritance. Composition is a pure operation over selected trusted data;
the engine must not infer inclusion from a process restart, package revision,
`resume` flag, or text markers. Harness adapters eventually receive final bytes.

The authored body and transport text are separate values. Display/title consumers
must use a validated body accessor or the explicit body, not independent regular
expressions that strip apparent context tags supplied by a user.

Existing package assets, pinned resource paths, role identity, procedure indexing,
Session/assignment producers, and integrity checks remain the source materials.
The new engine must not import experimental runners or load every procedure into
ordinary messages. Main-role ownership is explicit; native-child execution policy
is independent.

### Reuse dispatch evidence, not a second delivery ledger

The current dispatch lifecycle already distinguishes intent, submitted transport,
native acceptance, definite withholding, and uncertainty. Context metadata must
be linked to the particular message and its exact source/dispatch identity.
Prepared context alone is not activation evidence. Neither a completed run nor
user-reproducible text markers can establish submission or model consumption.

The run journal is the existing broad persistence boundary. New evidence records
must have strict decoding even though historical `submission.data` and
`context.data` accept arbitrary JSON. Restart state is a projection of persisted
facts, not an additional activation database or an in-memory acknowledgment map.

Current bridge journal emission is asynchronous. It cannot be fire-and-forgotten
inside `beforeNative`: dispatch boundary hooks require synchronous durable intent.
Future wiring must use the owning journal/claim persistence contract and preserve
its sequencing; the foundation must not introduce a competing writer.

### Separate ordinary execution validation from context loading

`validateCanonicalActivation` currently verifies paired context and execution.
Keep that full operation for activation and existing callers. Expose a narrow
execution-only validation path for already-established new-model activations.
It cannot independently prove role-text/context pairing.

The active bridge will intentionally continue using its paired validation until
cutover. Therefore this stage does not claim that ordinary CC/OC runs have already
eliminated context reads or injection overhead.

## Comparison without dual delivery

Comparison is explicit and read-only: give old and new preparation the same
pinned inputs and inspect their selected content, body, provenance, and bytes.
Differences in role ownership and selective placement are expected, not automatic
parity failures. A comparison result must not become actual submission evidence.

No startup/config delivery mode, automatic per-run shadow composition, duplicate
native send, synthetic message, hook, or instruction-entry channel is added.
The current system stays active; plugging in the engine later is a separately
authorized integration change.

## Later insertion points and hazards

- `bridge.ts`: authoritative package/Session input collection, placement selection,
  main-role ownership, and ordinary execution provider choice.
- `claude-run-service.ts`: initial submission and background `sendInput` are
  distinct message paths. Message IDs must distinguish multiple inputs in one run.
- `opencode-run-service.ts`: normal/queued prompt and compact paths are distinct.
  Queue acceptance/uncertainty and no-replay remain authoritative; no compact-time
  prefix is implied.
- `PreparedUserInput` and pending-input codecs are strict and currently bind
  `prepared.prompt` to the authored request. Do not silently replace it with a
  composed string or hide new fields inside identity/configuration objects.
- Optional composition serialization must be explicitly validated before any
  future queue/admission integration. Native identity can be finalized only after
  actual session admission; fresh preparation can lack that identity.
- Existing context injection acknowledgment gates must be retired together with
  their sinks at cutover, not removed by this foundation change.

## Implementation status

### Shared composition

`packages/sane-app/src/context-message.ts` implements the pure production
composition boundary; it has no dependency on the PoC runners.

- `composeContextMessage`: explicit `body-only`, `bootstrap`, or `selected`
  placement, independently of message origin. Returns a deeply immutable value.
- `decodeContextMessage` / `validateContextMessage`: strict structured decoding,
  exact transport/body/segment hashes, provenance, and UTF-8 byte ranges.
- `validateTrustedContextMessage`: compares with independently supplied trusted
  package/state/selection inputs. Structural validity alone is not source trust.
- `contextMessageBody`: validated structured extraction or explicit authored-body
  pass-through; no detection/stripping of user-reproducible text markers.
- `compareContextMessage`: opt-in pure comparison with the existing renderer,
  including explanations of selective omissions and opaque native role references.

The v1 context-bearing format has explicit activation/update/sharing/branch-update
semantics, length-described ordered context blocks, and an authored body through
end-of-message. Segment source/revision/reason are visible in the outgoing text,
not merely retained in audit metadata. Ordinary messages have no framing at all.
Lone UTF-16 surrogates are rejected rather than silently altering UTF-8 bytes.
This framing is a prompt convention, not a new authority/security boundary.

Bootstrap owns selected main-role content once, required standing framework,
selective pinned procedure/resource indexing, initial Pickup, applicable worker
procedure/assignment, and Session. Worker assignment fragments exclude procedure
bytes explicitly. Updates/sharing include only ordered selected assets/fragments.
Branch inheritance is a reference requiring independent native-prefix evidence,
not an automatic activation or inherited-delivery assertion.

Bindings use generic dispatch harness IDs and exact non-null native identities,
without widening the existing production CC/OC wire validators. Body-only input
does not accept a context package. A combined focused static check of composition,
the validation seam, and the existing wrapper completed with zero diagnostics.
An independent read-only code review found no actionable issues in these modules.

### Execution-validation seam

`packages/sane-app/src/canonical-activation-validation.ts` provides:

- `validateCanonicalExecution`: execution-reference/hash, trusted role identity,
  policy, native-child/model/permission validation without a context loader.
- `validateCanonicalActivation`: full execution/context pairing, including role
  bytes and pinned identities, for activation and the unchanged current path.
- Small injected loader interfaces and optional guards around asynchronous reads.

`user-input-preparation.ts` keeps its existing paired-validation export as a
wrapper. No bridge caller switches to execution-only validation in this stage.

A focused TypeScript compiler check of the new validator and existing wrapper,
including their imported dependencies, completed with zero diagnostics. The
worktree has no installed dependencies: the check used the existing main
checkout's TypeScript/external declarations through a read-only resolver fallback,
while resolving workspace source from this worktree. No dependency installation,
node_modules links, or repository compiler-config changes were made.

### Known later codec work

The prepared-input codec reconstructs canonical creation configuration without
all canonical fields and expects a role-native OpenCode agent rather than the
canonical `build` selection. These are existing integration risks, not corrected
by this foundation. They must be addressed explicitly before wiring a composed
message through durable prepared/queued inputs; relaxing the decoder would hide
the mismatch rather than establish the correct contract.

### Guarded preparation

`packages/sane-app/src/context-message-engine.ts` provides:

- `prepareContextMessage` and `assertContextMessageCurrent`: compose and compare
  with independently refreshed trusted input, with ownership/source/cancellation
  guards around asynchronous work. This is preparation, not submission proof.
- Separate ordinary and context-bearing preparation dependencies. Ordinary SANE
  input requires execution-only validation plus a caller-owned durable
  activation/pairing check; Base input has no SANE activation requirement. The
  ordinary path has no context provider or paired-validator dependency.
- `canonicalContextMessageExecutionValidator`: connects the execution-only loader
  to that ordinary preparation contract and rechecks trusted execution selection.

Context-bearing validation rechecks selected pinned inputs and their provenance;
it does not derive trusted intent/body/binding from a serialized candidate. No
package load is hidden inside composition. Injected ordinary readers and guards
must uphold the same no-context-asset-I/O contract when production is wired.

### Submission evidence and restart/branch facts

`packages/sane-app/src/context-message-evidence.ts` provides:

- `recordContextMessageSubmission`, `decodeContextMessageSubmission`, and
  `contextMessageFromSubmission`: a strict submission codec with one full outgoing
  `text` copy, message identity, composition metadata, hashes/provenance, and UTF-8
  body/segment ranges. Existing optional live-input/queued-follow-up markers are
  retained separately. Text is reconstructed from ranges and validated by the
  shared composer decoder.
- `decorateContextMessageEvidence`: adds per-message metadata to the existing
  owner's evidence hooks. It does not instantiate a second dispatch lifecycle.
  The required synchronous persistence callback must durably commit/verify the
  standard submission and correlated observation under the existing owner's
  authority before returning. No persistence writer is installed by this stage.
- `decodeContextMessageDispatchObservation`: strict existing-identity/outcome
  decoding without widening `DispatchIdentity` or queue evidence shapes.
- `projectContextMessageRestart`: read-only projection from complete/partial/
  unavailable protected history. It distinguishes prepared-only, withheld,
  unresolved attempt, submitted-unconfirmed, explicitly rejected, accepted, and
  unknown facts. None is a model-consumption acknowledgment or resend policy.
- `projectContextMessageBranch`: verifies one explicit completed parent-prefix
  edge, selected ancestor identities/hashes, parent evidence, and no-reset proof.
  It preserves ancestor sources and lineage without fabricating a destination
  submission. It does not infer transitive inheritance or compaction recovery.

CC initial and live-input message IDs remain distinct even when they share a run.
Initial run intent cannot certify a later background input. Missing history is
not fresh-session proof, and uncertainty never requests automatic reinjection.

### Plug-in sequence for a later authorized integration

1. The bridge gathers independently trusted placement/body/binding and selected
   pinned content. Keep ordinary readers separate from full package collection.
2. Prepare using the new engine. For an explicit offline comparison, call the old
   renderer and `compareContextMessage` on the same pinned inputs. Do not persist
   that candidate as actual submission or perform a second native send.
3. At cutover, give the harness adapter `message.transport.text`; give display,
   titles, and classification `contextMessageBody(message)`. The adapter must not
   prefix context independently. Merely selecting this text is not a complete
   cutover: obsolete injector sinks and their acknowledgment gates must also go.
4. Bind the actual adapter message ID/text to `recordContextMessageSubmission`,
   and decorate the existing owner's hooks with a real synchronous durable
   persistence implementation. Preserve exact existing queue/ownership guards.
5. Revalidate after asynchronous admission/journal/queue work and use the owner's
   synchronous final source/ownership/cancellation gate before possible native
   execution. Pre-send validation does not freeze queued execution-time state.
6. Reconstruct restart/branch facts from protected records; the lifecycle owner
   still decides whether current activation/pairing is sufficient to proceed.
   No projection by itself authorizes a resend or replaces native reconciliation.

### Not activated or implemented by this foundation

- No new config/startup mode, automatic shadow comparison, native transport,
  context hook, synthetic message, instruction-entry write, or data reset.
- No changes to current CC/OC prompt bytes, injectors, receipts, operational hooks,
  native execution configuration, queue scheduling, or background-input behavior.
- No new records are emitted by the running app: it does not call this engine.
  The existing asynchronous journal emitter is not upgraded to a synchronous
  durable writer by defining the injected persistence interface.
- No widening of existing prepared-input/pending-input schemas. Their authored
  `prompt` meaning and strict validation remain intact. New serialization is a
  standalone validated seam for deliberate later integration.
- No branch-native prefix verifier, live-input boundary integration, compaction
  preservation policy, or arbitrary session adoption/migration utility.

The initial combined focused TypeScript check of all four new production modules
and the existing wrapper completed with zero diagnostics. At that foundation
delivery no tests were written or run; a typecheck did not establish runtime
safety/performance acceptance. See [TESTING.md](TESTING.md) for the later test run
and its retained failures.
Earlier Antigravity (171 files) and Grok (163 files) evidence manifests were
rechecked with no hash differences.

Final review found and corrected a dormant decorator regression: a certified
`DispatchPreNativeRefusal` from the original synchronous intent hook must preserve
definite withholding without poisoning owner/storage health. The decorator now
rethrows that exact refusal without committing an attempt or calling `failClosed`.
Identity, persistence, asynchronous-hook, and outcome failures remain fail-closed;
the exception is scoped only to the original synchronous `beforeNative` call.

The behavioral-test follow-up then exposed a distinct enclosing-lifecycle issue:
an uncertified refusal-class exception from reads/persistence could borrow that
certification when rethrown through the decorator. The authorized narrow fix wraps
only such before-native failures as ordinary errors with the original cause.
Genuine original intent refusals and other ordinary/outcome failures preserve
their identities. All 361 focused tests and the scoped typecheck now pass; the
full original failure, fix, and verification record is in [TESTING.md](TESTING.md).
