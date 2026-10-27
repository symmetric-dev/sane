# Shared user-message cutover

## Outcome and scope

Production bridge prompt execution uses the shared composer, submission
coordinator and exact-byte evidence path for Claude Code and OpenCode. Old
App-managed context delivery sinks were retired together, not retained as a
fallback or shadow/double-send mode.
This stage is uncommitted at report creation; nothing was pushed.

The prior verified durability/adoption stage was committed as `56354b4` and the
requested raw-report cleanup as `91e5df3`. Raw `reports/user-context-*/` files
remain local and ignored. Experiment source and implementation reports remain.

**This is a conservative code cutover, not qualification of every historical or
native workflow.** Unsupported legacy SANE, inherited branch prefixes, and SANE
compaction/retention paths refuse explicitly rather than guessing activation or
repeating role/Pickup. The original dated offline checks below do not qualify
complete browser/native workflows or the current working tree.

## Implemented path

### Independent bridge selection

- Base ordinary input is byte-for-byte authored body only.
- SANE ordinary continuation checks paired lifecycle metadata, its original ready
  admission and known unsupported legacy/branch/compaction states once at owned
  preparation. It does not reconstruct historical journal/native delivery,
  re-read Session-root provenance, or establish continuous context retention.
  The generic message engine loads neither context packages nor execution policy;
  execution-policy loading remains separate native execution configuration.
- New ordinary canonical assistants use their original anchored preparation IDs;
  explicit assistant upgrades, original worker launches, and handoff-created
  recipient activations supply explicit bootstrap intent. `resume`, origin,
  missing evidence and package revision never independently mean activation.
- Bootstrap uses independently loaded pinned package files and authoritative
  Session roots. Worker assignment is produced structurally without embedding
  its procedure; the composer selects the procedure exactly once. Explicit
  worker-protocol asset/state selections are ordered before Session.
- Bootstrap validates the pinned context/execution pair once during explicit
  preparation. Explicit selected context is composed once; retained
  `assertSelectionCurrent` checks guard mutable intent/source, binding and body
  currency without recomposing it. Owner and cancellation fences remain active.
- Captured private file pins and Session/domain roots have synchronous final
  source guards after asynchronous preparation/discovery.
- Session root/membership changes require an explicit selected update; ordinary
  input does not silently re-render Session or standing context. The backend
  endpoint is `POST /api/sessions/:id/context-update`, accepting an authored
  nonempty `prompt` and optional `nativeStopped`. It selects current authoritative
  Session roots only, not arbitrary caller-supplied context. It cannot enter an
  ordinary durable-input chain. No new UI control was added.
- Science intent v3 preserves frozen backend snapshot provenance and exact
  shared-composer wire text. The comment is authored body; snapshots are selected
  sharing fragments. Existing v1/v2 receipts remain immutable/readable and cannot
  be rewritten or replayed into v3.

### Same owner, same journal, actual adapter bytes

The existing dispatch lifecycle owns native admission and initial outcome state.
An immutable owner message capability prepares shared messages and late-binds
decoration of the **original** lifecycle evidence hooks. It never wraps an
already-created dispatch evidence object as a new owner.

Both adapters construct immutable encoded native payloads and read those payloads
back independently of the candidate composer object. One actual standard
submission stores text plus composition metadata. An activation association is
reserved **after** that standard submission in the same existing run journal;
later observations contain correlated identity/hashes, not repeated prompt text.

The synchronous boundary fence drains prior journal reservations and fsyncs the
same file/directory. It cannot flush the metadata queue or authorize replay.
Normal queued callbacks later consume their reservations without double append.

Claude initial intent is durable **before spawn**; the same retained JSON line
is written to stdin. Pipe flush proves submitted, with native acceptance unknown.
Claude live input has its own native UUID and `message` boundary immediately
before write/flush, with a synchronous retained-source check. It never re-enters
the initial run/queue-claim intent hook.

OpenCode serializes its actual HTTP body once before the final boundary callback,
checks that exact body after connection discovery, and sends it unchanged. Exact
command acknowledgement is required for acceptance; ambiguous responses remain
unknown. Required existing evidence capabilities and synchronous owner guards
cannot be replaced or bypassed by a context capability alone.

### Read-only historical evidence, not ordinary admission

The protected reader never creates, repairs, drains, or brands historical logs as
live reservations. It pins store/root, journal identity and exact snapshot bytes,
permits verified append-only fresh reads, and rejects missing/partial/rewritten
evidence. Later-run ordinals and pending in-memory tails are checked too.

Activation, native-source and protected-reader modules remain available for
explicit read-only inspection. **The earlier cutover's journal/native-history
activation-proof gate is no longer on ordinary preparation's hot path.** Inspection
does not grant dispatch authority, repair evidence or resend context. The App's
**View SANE context** inspector shows recorded outgoing text and outcomes when
retained, not reconstructed current context or proof of current native retention.

Ordinary sends do not continuously detect out-of-band history edits or native
resets. Known recorded reset/compaction states still refuse, but an unobserved
native change is not guaranteed to invalidate continuation. History/model text
markers and successful Run status never prove model consumption.

Current separation is implemented in
[`owned-message-preparation.ts`](../../packages/sane-app/src/owned-message-preparation.ts),
[`context-message-engine.ts`](../../packages/sane-app/src/context-message-engine.ts)
and the lifecycle compatibility check in
[`bridge.ts`](../../packages/sane-app/src/bridge.ts).

### App admission receipts

The immutable browser request is recorded separately from native delivery. Only
the original invocation can publish admission through the existing durable
writer/publication fence. **Message receipts** are normal pending/activity help,
not inherently errors. Exact-request recovery is GET-only and never replays the
request; App admission does not prove native acceptance or model consumption.

### Observation is not launch eligibility

Current launch settings, cancellation and source gates remain mandatory for new
effects. Original outcomes instead retain immutable run/command association and
their receipt from an actual durable metadata publication. Later model/profile
or delivery-policy drift can invalidate admission/settlement without erasing an
original accepted/unknown fact. The outer production lifecycle records outcomes
before its launch-policy failure gate.

Definite not-submitted/not-accepted withholding **before any recorded attempt**
can be journaled before metadata publication without poisoning healthy storage.
It is not metadata proof, native permission or activation qualification. Every
possible-native observation still needs independent metadata association proof.

## Retired delivery versus retained execution

Retired active App sends:

- CC framework/dynamic delivery files and additional-context delivery hooks.
- CC `--append-system-prompt-file` standing delivery and its acknowledgment gates.
- OC framework/Session synthetics, `sane.context` instruction-entry writes, and
  context-binding mutation methods used by the old channel.
- Ordinary/branch SANE role string prefixes and recurring standing rendering.

Retained:

- Authenticated forwarding/telemetry hooks and historical result/receipt readers.
- Canonical model/effort translation, permission rules, explicit worker protocol,
  native-child policy/role definitions and native built-in behavior.
- Process-group supervision, stream drain, UUID correlation, exact-command
  monitoring, cancellation, queue uncertainty, one-shot claims and no-replay rules.
- Dedicated raw/native compact operations for Base sessions, not framed ordinary
  context-message submissions.

Canonical CC resumes explicitly disable restoring an old system-prompt snapshot.
OC reads verify absence of the owned legacy `sane.context` entry; this stage does
not delete arbitrary native instructions or invent a retirement protocol. The
legacy `contextDelivery` configuration value is accepted only as a compatibility
alias and no longer selects an old transport.

## Explicitly unqualified / remaining work

1. **Historical SANE migration:** old metadata/native role or system-entry state
   is not a new-channel activation. It needs an explicit, qualified migration or
   reconciliation procedure; no automatic bootstrap or fallback is provided.
2. **SANE branch inheritance:** exact remapped native prefix and reset evidence
   are not yet persisted in the branch authority. New SANE branch requests and
   inherited continuation refuse. Base branching remains on its existing path.
3. **SANE compaction and reset recovery:** retention/restoration is not qualified.
   Manual SANE compaction and known recorded reset/compaction states refuse.
   Ordinary sends do not continuously verify native history, so out-of-band
   resets may go undetected. No silent standing-context resend is introduced.
4. **Real-native acceptance:** offline fake transports/history do not establish
   runtime model behavior, complete workflows, latency/throughput, or a crash/
   power-loss experiment. Those checks require separate authorization.
5. **UI affordances:** the explicit Session-update backend exists, but a dedicated
   update control and migration/retention UI were not added. The separate
   read-only **View SANE context** inspector is available.

## Current focused verification

The 2026-10-27 cleanup ran the current `verify.ts` with existing dependencies:
**1,078 tests passed across 32 selected files**, with **4,712 assertions**, no
failures and no skips. Scoped static checking reported zero diagnostics across
107 source/test entry files, including the coordinator, receipt modules,
extracted routes, frontend, native plugin and installer. The extended bridge
comparison still reports the same two pre-existing `TS2739` diagnostics at
`packages/sane-app/src/user-questions-service.ts:26` in both baseline and current
code; this is not a clean full-App typecheck.

All 108 service-context cases were retained. Stale callback-count expectations
were replaced with exact source/hash, lifecycle, single-intent and no-replay
assertions; wire-drift cases now exercise the retained transport handle. A narrow
cleanup fix preserves the original missing-dispatch-evidence refusal instead of
masking it with an absent withholding callback.

Eight real-store intake regressions cover expected catalog/startup refusals and
fatal failures. Only the exact retirement/reservation and startup/closing
eligibility errors are translated into normal request conflicts before intent
is written; they no longer poison unrelated intake. Unknown, storage and
invariant errors still fail closed and remain sticky.

These are selected offline regressions and static checks, not the full suite or
complete browser/native, receipt-recovery, cancellation, crash or retention
qualification. The verifier writes fresh output to a new requested directory;
the original captured evidence below remains unchanged.

## Historical verification and reproducibility

This section records the original 2026-10-26 cutover capture, before the ordinary
preparation simplification described above. `checks.json`, `tests.junit.xml`,
source hashes and `bridge-typecheck.json` are retained unchanged. Their counts
are not current-tree results; some regressions describe the former activation
proof gate. No latest-green or full-App qualification is asserted here.

The user explicitly authorized agents and focused offline tests. Independent
implementation work covered both adapters, owner evidence, durable activation
validation, protected reads, worker structure and science versioning. Read-only
audits reviewed bridge and transport integration; concrete ordering, observation,
cancellation and effective-prefix issues were fixed with targeted regressions.

Exact commands at that checkpoint, selected source hashes, counts and diagnostics
are recorded in `checks.json`, `tests.junit.xml` and `bridge-typecheck.json`. The preserved
`verify.ts` runs only the selected offline regression scope, with live/native
arming variables removed. It never reads ignored raw experiment reports.

Original captured result: **1,088 tests pass**, zero failures/skips, **4,490
assertions across 29 selected files**. Scoped static checking has **zero
diagnostics across 65 entry files**. The extended bridge check matches the
committed baseline's two existing `TS2739` diagnostics in unchanged
`packages/sane-app/src/user-questions-service.ts:26`. Targeted final correction
reviews found no remaining concrete blocker in the reviewed scope, not an
exhaustive or live-native correctness guarantee.

Regressions include original outcome persistence through configuration changes,
metadata publication before observation, production lifecycle capability/policy
guards, cancellation retaining original-command monitoring, sticky/deduplicated
protocol contradictions discovered during cancellation, synchronous live-source
checks, one standard submission, exact encoded payloads, source drift, missing
proof, rewind/compaction refusal, science receipt compatibility and zero ordinary
context-package loads. Native effects and native history in tests are simulated.

Example (use an existing installed dependency checkout; no install is attempted):

```sh
bun reports/context-message-cutover-2026-10-26/verify.ts \
  --dependency-root /absolute/checkout-with-installed-dependencies \
  --output /absolute/new-verification-directory
```

The extended bridge comparison substitutes all changed tracked App sources from
committed HEAD through the compiler host, not just the bridge against incompatible
new service interfaces. No working source is reverted. The known unchanged
question-service diagnostics are reported separately, not hidden as a clean full
App build.

## Current performance boundary

OpenCode prompt setup retains its resolved execution context for launch metadata,
leaving two timed checkout-resolution steps rather than three. Final preflight
still resolves fresh after execution configuration, whose permission/native-binding
effects can change state; compaction keeps its independent lookup fallback. There
is no global resolution cache. `context.freshness.before-native` names a retained
currency check, not historical activation proof. Targeted timing observations are
not a controlled benchmark or SANE workflow qualification.
