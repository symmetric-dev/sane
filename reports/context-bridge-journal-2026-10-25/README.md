# Bridge-owned journal boundary — implemented, no context cutover

This is the next bounded integration milestone after the codec fixes. Routine
bridge run-log appends now use one synchronous physical writer, while retaining
the existing asynchronous metadata/write scheduling. A synchronous context-evidence
adapter is implemented but **unwired**. Trusted placement readers, pending-activation
adoption, durable activation pairing and actual native context transport remain
unimplemented; this is not full-App or real-harness verification.

## Active bridge changes

- `RunJournalWriter` reserves immutable serialized bytes and sequence exactly once.
  Normal `emit()` still runs through the bridge's existing global serial queue;
  only its physical run-log append becomes synchronous. No live asynchronous append
  can race a synchronous fence on that same journal.
- `flushThrough()` drains all reserved predecessors in order, verifies the protected
  byte prefix, then fsyncs the file and containing directory. Later queued callbacks
  consume their reservations without reappending or republishing.
- Reserved, appended and fsynced positions are distinct process-local facts.
  Normal stdout/stderr drains do **not** fsync every event. Neither a returned
  ordinary `emit()` promise nor `replyJournalThrough` means fsync durability.
- File/root identity, link/symlink safety, exact baseline events, append length,
  mutation times, ownership and durable-prefix hash are guarded. Partial writes
  continue only from a known successful offset. Any uncertain append/fsync or
  mandatory ownership failure permanently fails closed; there is no repair/retry
  or takeover API. Ownership is rechecked after physical I/O before publication.
- Committed projection callbacks remain ordered and once-only. Optional indexing
  runs outside the writer's I/O/publication section. Recorder exceptions retain
  the bridge's fail-closed behavior.
- Startup/deferred repair refuses claimed journals. Startup repair writes are
  synchronous inside the existing queue, avoiding an asynchronous rewrite race.

## Original recovery stays separate

The existing original-claim recovery path retains its directory/manifest/inode,
coordinator association and original-ID proof. It is not replaced with a current
owner lookup, fabricated Run, or another dispatch lifecycle.

Before original pins are captured, an explicit one-way transfer requires no live
owner/admission/reconciliation and no pending writer records **or unconsumed queue
callbacks**. Those journals are then permanently excluded from ordinary appends.
Original-only writes still use their existing serialized, awaited authority path.

Background native-subagent recording now checks per-run append eligibility at
startup, manual refresh and after awaited work. Excluded originals remain readable
but cannot acquire ordinary recorder writes, even after recovery occupancy ends.

## Unwired context-evidence adapter

`createContextMessageJournalPersistence()` must receive the owning bridge writer,
original-owner/source checks, and a separate synchronous metadata-durability
capability. It verifies the adapter's actual composed standard submission already
reserved through the ordinary journal path, then appends only correlated context
observations. Prompt text is stored once. Bare old-format submissions are not
silently rewritten or copied into another submission.

Submission and prior observations require the original process-private writer
reservations; copied, invented or merely decoded historical events cannot supply
attempt proof. Outcome observations require their original attempt except for
definite original-owner withholding. Identical observations may be verified
durably without adding another record; that grants no permission to resend.

**This adapter is not supplied to native dispatch hooks yet.** In particular:

- The bridge's existing metadata `persist()` write/rename is not an fsync proof.
  A journal fence does not flush pending metadata or create that missing proof.
- Existing CC live input has its own UUID/pipe boundary; initial-run hooks cannot
  certify it. No new live-input transport integration is claimed.
- Missing composition history is unknown, not evidence of a fresh activation.
  Pending activation must reuse a verified original journal through a distinct
  adoption path, never reset a history list or create a replacement attempt.
- Existing context providers, native role/configuration behavior, injectors,
  acknowledgment gates and authored `prepared.prompt` semantics are unchanged.
  No shadow composition, dual send, runtime delivery flag or new activation ledger.

## Verification and audit

User explicitly authorized targeted offline regressions. Added **44 tests** across
the writer, context-journal adapter and recorder-eligibility files. They cover
pending-write/fence ordering, once-only append/publication, short/partial writes,
file/directory fsync failure, ownership loss, historical prefix preservation,
unsafe links/replacement/truncation, repair/exclusion gates, queued-callback
transfer, copied/invented evidence, separate metadata proof, and recorder
exclusion during awaited fake I/O.

Combined focused verification:

- **538 tests pass**, zero failures, 1,777 assertions across 14 selected files.
- **Zero scoped diagnostics across 33 entry files**, using worktree source and
  cached external declarations. The scope includes the previous codec/foundation/
  mock-demo checks; the mock demo remains simulated acceptance only.
- Extending the typecheck to `bridge.ts` exposes **two existing diagnostics** in
  unchanged `user-questions-service.ts:26`. A compiler-host substitution of the
  committed HEAD bridge reproduces exactly the same file/offset/code/messages;
  there are no introduced diagnostics in that comparison. No source was reverted
  or reset to establish the baseline. This is not a claim of a clean full-App build.
- Historical Antigravity/Grok manifests: all 171/163 entries still match.
- Targeted read-only audit found and closed the recorder/exclusion interaction
  and unbranded prior-attempt gap; the final correction review found no remaining
  concrete bug in its reviewed scope. The separate queue-callback transfer caveat
  is enforced by the writer, not merely assumed by the caller.

No full repository suite, App/browser boot, live native/model/network call,
dependency installation, context/skill edit or delivery cutover was performed.
Recorder tests use fake native methods; read-only cached SDK aliases permit module
loading without installing dependencies or constructing an actual SDK adapter.

`checks.json`, `tests.junit.xml` and raw `*.log` files contain final commands,
statuses and source hashes. `bridge-typecheck.json` contains the baseline/current
diagnostic comparison. `test-tsconfig.json` records the verification-only aliases;
repository compiler configuration is unchanged. Helpers/original output remain at
`/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-bridge-journal.e1jLfQ/`.

## Remaining acceptance boundary

Next establish owner-controlled durable metadata and pending-activation journal
adoption, then trusted bridge placement/source readers and adapter-owned actual
submission bytes. Only after those contracts are proven should native sinks and
their old injector/ack gates be retired together.

Normal append chunks now run on the event loop rather than the async filesystem
pool. This milestone avoids per-stdout fsync but establishes no throughput/latency
acceptance; no benchmark or full-App workload was run.
