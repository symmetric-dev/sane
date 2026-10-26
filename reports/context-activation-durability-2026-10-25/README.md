# Durable metadata and bounded pending-activation adoption

The previous verified milestones were committed locally before this stage:

- `b938d6a` — canonical activation preparation and codec pins.
- `e795ef9` — shared journal writer and synchronous evidence fences.

Nothing was pushed. Account-identifying raw captures remain excluded from Git.
The implementation described below is a new, uncommitted stage.

## Active changes

### One durable metadata publisher

Both ordinary bridge `persist()` and original-recovery metadata publication now
use `MetadataPublisher` inside the **existing global storage queue**. Routine
persistence still captures serialized bytes at enqueue time. Recovery retains
its existing write-candidate-before-publishing-live-state ordering.

Publication uses an exclusive same-directory temporary file, file fsync, rename,
and directory fsync. Root, manifest/store identity, ownership handles and exact
current file identity/bytes are checked before and after publication. Uncertain
I/O permanently fails closed; there is no rollback, overwrite of unknown external
state, retry queue or synthetic read-disk durability receipt.

A process-private branded receipt proves exact session/run/source/configuration
representation in committed metadata. It checks both its original publication
and the latest committed relevant facts. Unrelated/title/status edits may coexist;
changed source, run, role, context/execution pair or launch pins cannot borrow an
old proof. Legacy queued-followup IDs remain separate from optional dispatch
request IDs. Semantic proof refusal does not itself poison healthy storage.

The outer bridge now supplies fresh installation/data ownership-handle checks,
not only an in-memory ownership boolean. Owner-local `assertMetadataCommitted`
is available for later evidence integration. **It is not connected to context
submission hooks in this stage**, and does not replace live cancellation,
coordinator, execution-policy or native-admission gates. Stop/shutdown alone does
not erase the representation proof needed for original outcome observations.

### Original preparation identity in the existing activation record

Eligible **ordinary new canonical assistant conversations** now create a schema-3
anchor at the existing `activations/<sessionId>/activation.json` path. It records
the original run ID, OpenCode command ID where applicable, store/session/role,
exact canonical pair and intended harness/authority/checkout scope.

The anchor is durably published before one `activation-preparation` context event
is created and fenced through the **same eventual run journal and writer**.
New ancestor directories are also durably published. No prompt text, submission,
acceptance, delivered/activated flag or second activation ledger is added.

An existing schema-2 record is not silently retrofitted. A saved schema-3 anchor
requires its already-present, complete, preparation-only original journal:
missing, empty, torn, foreign, submitted or otherwise uncertain history refuses.
A crash between anchor and journal publication does not authorize recreation.

### Verified first-Run installation

Ordinary admission resolves the anchored IDs **before** constructing dispatch
identity. Immediately before owner installation it rechecks the original lease,
ready native admission, source/checkout, exact pair, no prior Run, immutable
record and protected journal baseline. The actual bridge installation preserves
the original event objects and continues at the next sequence, instead of
resetting the event list to `[]`.

A ready anchored session with no installed Run may adopt that preparation on an
explicit ordinary user request after restart. This is not automatic prompt
replay: no authored prompt is stored in the preparation record, and decoded
restart events do not acquire live submission-reservation branding.

Startup discovers anchors before generic journal repair. Anchored logs are never
silently repaired. Existing actual Runs keep the existing observation/recovery
path; they are not installed or dispatched again through preparation adoption.

Other first-dispatch paths cannot bypass an outstanding anchor with another ID.
Compaction is explicitly blocked before original activation installation, both
in eligibility and final installation. Fresh prompt/compaction installation also
refuses unexpected existing journal files, including empty files and dangling
symlinks. The writer retains the absent namespace before linking or asynchronous
preflight, so a file appearing later must fail exclusive creation rather than
become an adopted empty baseline. A known admission cancellation while waiting in the write queue is a
pre-write refusal, not a global storage failure; actual preparation failures and
unexpected invariant failures still reach the existing fail-closed latch.

## Deliberate scope boundary

- New anchors are wired for ordinary canonical assistant creation and explicit
  ordinary adoption of their anchored, no-Run sessions.
- Worker, handoff, branch, upgrade, science/external-preallocated-ID creation
  paths are **not migrated** to anchored preparation in this stage. Existing
  legacy paths remain in place; they cannot bypass an outstanding new anchor.
- The scope anchor precedes native creation. Final native identity is established
  by the existing exact durable admission, not by inventing a native binding in
  the pre-native record.
- Canonical package/content validation remains independent of physical journal
  adoption and metadata representation proof.
- Metadata durability and preparation history prove **neither native activation
  delivery nor acceptance, context retention, freshness after compaction/reset,
  or inherited branch-prefix correctness**.
- Existing context providers, injectors, native-role policies, acknowledgment
  gates and authored prompt semantics remain in place. No shadow composition,
  dual submission, context transport switch or new dispatch state machine.

## Verification

The user explicitly authorized agents and focused offline regressions. Independent
implementation agents owned the metadata and pending-journal modules; read-only
reviews covered physical evidence and actual bridge integration. Reviews caught
and prompted fixes for compaction bypass, cancellation incorrectly poisoning
storage, queued-followup/request-ID conflation, absence-check/first-append races,
schema downgrade hiding an anchor, and replacement at original anchor close.

The focused combined run passed **673 tests across 17 files**, with **2,246
assertions** and zero failures. Scoped static checking reported **zero diagnostics
across 41 entry files**. Extending checking to `bridge.ts` reproduced exactly the
same two pre-existing `TS2739` diagnostics in unchanged
`packages/sane-app/src/user-questions-service.ts:26` as a compiler-host substitution
of the committed HEAD bridge; no working source was reset for that comparison.
Final targeted correction reviews found no remaining concrete issue in their
reviewed scopes; this is not a full-App or exhaustive correctness claim.

The selected regressions include the previous foundation/codec/journal/mock-demo
scope plus metadata durability, pending journal adoption and the extracted actual
bridge journal-installation seam. They exercise file/directory sync failure,
uncertain publication, receipts and pin drift, missing/torn/foreign histories,
same-process original event retention, restart identity reuse, fresh namespace
refusal, no duplicate installation, queue cancellation and storage-failure
distinction. Harness methods remain offline fakes; no actual App/native/model
workflow, browser session, full repository suite, dependency installation or
throughput/latency benchmark was run.

Historical Antigravity/Grok manifests still match all **171/163** entries.
`checks.json`, `tests.junit.xml`, `bridge-typecheck.json` and raw logs retain
commands, results and source hashes. Verification-only cached SDK aliases do not
change repository compiler configuration. Helpers/original output:
`/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-activation-verified.Kh1z9K/`.

## Next integration boundary

Finish independent trusted placement/source readers and durable **activation
delivery** pairing, accounting explicitly for remaining producer paths. Then
capture adapter-owned actual submission bytes and attach the evidence fence at
the real native boundary (CC initial and live input separately). Retire old
native context sinks and their injection/acknowledgment gates only together in a
bounded, separately verified cutover.

Normal metadata publication now performs synchronous file and directory fsync on
the event loop. This is a durability change, not a performance acceptance claim.
