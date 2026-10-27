# Harness decoupling and Grok integration

Status: Phases 1–3 remain implemented. Local main `6d5d9f0` is merged as
`bdafad7` and the incoming browser/notebook/verification integrations are
adapted to the existing boundaries. Grok storage v6 is implemented. The
adapter and profile are not.
Baseline: `bdafad7`, after checkpoint `7a3f25a` and the local-main integration.

**Near scope: targeted decoupling, then Grok integration. Gemini follows Grok
and still requires research.** This is not a claim that either new harness is
production-ready, or authorization to run native trials, install runtimes,
migrate stores or change running services.

## Current priority — Grok contract after main reconciliation

Reconciled 2026-10-27. Local `main` `6d5d9f0` (`marimo fixes`, five commits after
merge-base `dd87753`) is merged into `experiment/user-context-delivery` as
`bdafad7`. The main checkout `/Users/beto/sane` was not fetched, reset, or
modified. This remains a local-main observation, not a remote freshness claim.

The source/evidence contract is in
[Grok source, evidence, and storage review](GROK-SOURCE-EVIDENCE-REVIEW.md).
Storage v6 is implemented in this tree. Open does not migrate, and a v5
repository stays closed until explicit `sane upgrade`. Focused offline tests
are `packages/sane-core/tests/grok-storage.test.ts` and
`packages/sane-app/src/grok-storage.test.ts`. Do not start the Base adapter,
enable a profile, or bump receipts. Native trials, provisioning, and service
changes retain their separate authorization gates. Remaining CC/OC
authorization fallthroughs, and what must stay native-specific, are inventoried
in [Harness decoupling status](HARNESS-DECOUPLING-STATUS.md).

### Reconciliation

Conflicts were only in `bridge.ts`, `claude-run-service.ts`, and
`install-sane-agent-context-packages.ts`. Auto-merged overlap in the ongoing
index, App README, `app.tsx`, `browser-pair-dialog.tsx`, and frontend `store.ts`
kept both the admission-recovery ledger and main's group page size plus
checkout-preserving navigation.

Resolutions that matter:

- Claude launch stays on experiment `setupLaunch`. Main's pre-extraction spawn
  path was not restored. Browser MCP is a Claude `--mcp-config` argument after
  the source pin, and only for an explicit `claude-code` non-worker, non-compact
  launch. Tool names are appended only to the synthetic Base allow list. Pinned
  canonical permissions stay unchanged.
- The installer copy list is the union: `native-source-contract.ts` remains, and
  `native-browser.ts` plus main's validation/context modules are added. The
  selected-runtime proof still refuses a global fallback.
- App admission, owner controls, conversation creation, and the extracted
  terminal/workspace routes stay. Host browser routes were inserted beside them.
  Terminal upgrades carry `{ kind: "terminal" }` so the shared socket dispatcher
  does not treat them as browser sockets.
- First-submission naming uses `submitted(user text)` after the journal commit,
  including the context-paired submission path. It does not reconstruct a
  transcript or run inside the journal queue. Science still refuses historical
  version-2 replay; naming text is the version-3 user body.
- Skill, procedure, template, notebook-preview, and validation changes came in
  as committed. They were not redesigned.

Incoming integrations adapted to existing boundaries:

- Grant admission, resource-link discovery, and the OpenCode `/native/browser`
  resolver use `validateHarness` / `toNativeHarness` / `toSessionHarness`. They
  do not treat an unknown harness as the other one. Historical pair-metadata
  omission still uses the existing `sessionHarness` default and does not mint
  grants.
- A host handoff token without a caller is `403 browser-session-unverified`,
  including when exactly one Control grant exists. Session credentials and
  qualified OpenCode callers remain the two transports. Pair writes do not call
  `setGrant`.
- The shared handoff bearer is published only as `native-handoff.json`. The
  extra `browser-mcp.json` copy of that token was not kept. Per-run
  `${runId}.browser-mcp.json` is the Claude stdio config, not that bearer.
- Browser pairing remains metadata. Chromium shutdown stays on the browser
  service, not on conversation Stop or OpenCode interrupt.

### Verification of `bdafad7` plus these focused tests

Not evidence from the pre-merge checkpoint. Focused offline run: **65 tests,
316 assertions, four files, zero failures**. Files:
`browser-broker-auth.test.ts`, `claude-run-service-context.test.ts`,
`native-runtime-selection.test.ts`, `session-naming-submission.test.ts`.
The runtime-selection file still installs the vendored closure in a temp
directory and refuses global fallback. No bridge boot, Chromium, native CLI,
or full suite.

App `tsc --noEmit` adds no diagnostic from this integration. It still reports
the two existing `user-questions-service.ts:26` TS2739 errors and one
pre-existing `workstreams.test-utils.tsx:13` TS2353 (`approvals`), present on
both parents and not introduced here. This is not a clean full-App typecheck
or native acceptance.

### Remaining gaps

- Grant and broker identity checks are not booted-bridge or HTTP tests. The
  broker test plants an in-memory grant and does not start Chromium, so a
  successful qualified-caller tool result is unproven.
- Canonical Claude launches may still receive `--mcp-config` under the existing
  `bypassPermissions` argv. The grant, not the allow list, is the control
  boundary. A role session with a grant can use host browser tools; that is
  main's eligibility, not a new permission engine.
- Pair-metadata identity still defaults an omitted historical harness through
  `sessionHarness`. That default is not used to issue credentials or grants.
- Pre-existing binary harness comparisons outside this integration, including
  code-share and branch admission, were not swept.
- In-progress Job Specs that still use the old Boundaries/Verification sections
  fail planning validation. Completed specs stay on placeholder checks. File
  bytes are not rewritten.
- Grok source/evidence/storage, authentication, policy, and delivery remain
  separate gates. Browser pairing does not imply Grok support.

## Goal

Separate App-owned workflows from Claude Code/OpenCode protocols sufficiently to
add Grok without duplicating orchestration or weakening existing safeguards.
Use the first real Grok integration to validate the boundaries; do not generalize
every optional feature before implementing a third harness.

“Process” has two meanings here: an App lifecycle operation and an actual OS
process. A local child, a remote native command, an App-managed worker, a native
subagent and a utility invocation are not interchangeable lifecycles. A CLI
wrapper exiting does not necessarily mean its underlying work stopped.

## Keep the completed shared path

Reuse rather than rewrite:

- Selective context composition: explicit bootstrap/updates compose once;
  ordinary continuation sends the authored body only.
- The shared submission coordinator and its actual-byte binding, journal,
  publication, preflight and synchronous native-intent ordering.
- The existing admission/coordinator, owner registry, serialized writer,
  metadata publication, durable receipts and no-replay behavior.
- App-owned workflow rules, checkout association, capacities and document state.

Native adapters still own encoding, native configuration, source-specific
observations and physical submission. Do not restore historical activation or
native-history reconstruction as an ordinary-send gate, introduce another
ownership/proof framework, or add blanket validation across all harnesses.

Current behavior is described in the [shared-context guide](../../sane-context/native-context-injection.md)
and [cutover report](../../../reports/context-message-cutover-2026-10-26/README.md).

## Remaining process boundaries

| Process | Shared App responsibility / remaining native boundary | Sequence |
| --- | --- | --- |
| Routing and capabilities | Finish using the existing registry and checked operation dispatch. Remove consequential binary fallthroughs, not native-specific code merely because it names a harness. | First |
| Runtime discovery and installation | App selects explicit sources and allowed destinations; adapters own executable/profile/service discovery and native config syntax. Never silently use global settings or credentials. | Source boundary first; Grok-specific provisioning later |
| Identity and persistence | Core owns qualified references and immutable bindings; source codecs own native descriptors and ID validation. App, repository, receipt, worker and retirement formats need compatibility decisions. | First; storage extension with Grok |
| Conversation creation/admission | Share creation intent → native identity → App registration/ready → prompt ordering. Native allocation and creation acknowledgement stay adapter-specific. | Before first Grok send |
| Run control and shutdown | Share cancellation bookkeeping and owner release policy; retain owner-bound native cancel, shutdown, drain and observation controls. | First |
| Output, completion and recovery | Share journal writes and reconciliation barriers; adapters interpret streams, acknowledgements, terminal results and recoverability. | Minimal Grok slice; advanced recovery later |
| Queues and live input | Keep App waiting policy. Native inbox submission and writing into an existing execution are separate optional capabilities. | Initially disabled for Grok |
| History and transcript import | App owns stored transcript projection and pagination; adapters own native IDs, ordering, cursors and source checks. | App-owned transcript first; external import/attachment later |
| Profiles, models and UI | Share profile management and capability-driven presentation. Route catalogs/cache by harness and source; preserve native model/effort semantics. | Minimal routing before Grok exposure |
| Execution policy and native children | Preserve pinned authored policies and explicit translation diagnostics. Enforcement, native child definitions and ancestry remain native-specific. | Before enabling dependent SANE roles |
| SANE tools and shell-to-CLI calls | App owns operations and authorization; adapters qualify each native invocation and propagate caller provenance. An unqualified agent must not fall through to local/human authority. | Before tool-enabled SANE use |
| App-managed workers and report-back | Reuse worker reservations, assignments, outboxes and `WorkerExecutor`. Native creation, submission, cancellation and delivery evidence use the selected adapter. | Enable after required tools/protocol are qualified |
| Kickoff, enrollment and handoffs | Keep targeting, approval revisions and idempotency in App/domain code. Isolate recipient creation and native delivery. | Enable with qualified role workflows |
| Native permission/question replies | Share the interaction envelope and source fences, not native request IDs, reply grammar or continuation behavior. | Independently gated; not assumed from prompt support |
| App forms, sharing, science and pairing | Reuse existing form/snapshot/notebook/pairing logic and narrow authorization/send ports. Pairing metadata grants no browser-control permission. | Incremental feature enablement |
| Branching and compaction | Keep existing operation journals and arbitration; adapters own native fork boundaries, compaction identities and retention semantics. | Unsupported for initial Grok slice |
| Bounded utilities | Keep budgets and result validation; tool-free generation, persistence and discovery suppression require separate native qualification. | Later; no automatic ordinary-session substitute |

Base chat, SANE assistant roles, managed workers, native delegation and utilities
need separate eligibility decisions. `prompt: true` must not mean “all SANE
features supported.” Existing CC/OC capabilities and behavior remain unchanged.

## Phase 1 — strict source and compatibility boundaries

Initial extraction implemented in this checkout (2026-10-27):

- Core normalization now has separate CC/OC filesystem codecs and a browser-safe
  closed source-format contract. Descriptor insertion order and authority hashing
  remain unchanged.
- App source-v1 validation/resolution is isolated in
  `packages/sane-app/src/app-sources.ts`; existing `app-store.ts` exports and
  error-class identity are retained. Stored source reads still do not normalize.
- Name conversions explicitly reject unknown harnesses. Admission-to-history and
  science/workstream reference checks use the shared conversion boundary.
- The installer source-copy list includes the new core contract, preserving the
  vendored plugin/MCP runtime closure without provisioning any runtime.
- This slice changes no persisted format, schema, builtin/default, receipt or
  running service, and does not enable Grok. Native-ID validators with different
  historical acceptance sets have not been collapsed into one universal rule.

Static review approved the core and App changes. Scoped TypeScript checks of nine
changed code entry points passed; a bridge integration comparison added no
diagnostics and retained the two pre-existing `user-questions-service.ts:26`
diagnostics. This is not a clean full-App typecheck or runtime qualification.

Focused tests were subsequently authorized and implemented: **171 tests, 781
assertions, six isolated files, zero failures/skips** (including 147 new cases).
Coverage includes exact descriptor/hash compatibility, filesystem normalization,
closed source-v1 validation, unavailable/null pin behavior, public reexports and
error identity, distinct admission/parent ID bounds, strict mappings and consumer
409 errors, and an import of the installer-copied runtime. All six test entry
points pass scoped TypeScript checking; independent test reviews found no blockers.
No production fixes were needed during this test slice. Native trials remain
unrun and require separate authorization. The Grok source representation and
storage extension below remain a separate decision, not completed migration work.

Extract existing CC/OC source codecs and mappings without changing stored bytes,
source hashes, native IDs, builtin profile IDs or defaults. Unknown values must
refuse explicitly; retain only already-authorized historical omission defaults.
The existing registry should remain the routing foundation, not be replaced by
a parallel registry or an opaque native-JSON escape hatch.

Agree the persistence extension before writing it:

- App source records currently have an exact versioned CC/OC shape. A normalized
  in-memory lookup does not itself authorize new persisted fields or sources.
- Source authority IDs hash the normalized descriptor. Preserve existing CC/OC
  serialization and identity algorithms exactly; a cosmetic normalization change
  must not reidentify existing conversations.
- Repository schema v5 retains CC/OC authority CHECK constraints. A third
  repository authority needs an explicit schema upgrade. Do not edit frozen
  historical schema definitions or derive them from a changing runtime registry.
- Scope App source-record, metadata, receipt and other format decisions separately;
  do not automatically bump every format or rewrite immutable historical data.
- Unconfigured Grok must neither alter CC/OC defaults nor block their operation.
  No fresh-store replacement, silent adoption, source refresh or replay is allowed.

**Exit:** behavior-preserving CC/OC boundaries and an explicit compatibility
decision for the new source, including upgrade/refusal and recovery expectations.
Storage changes require their own implementation review and authorization.

### Grok storage extension — implemented

The decisions are in
[Grok source, evidence, and storage review](GROK-SOURCE-EVIDENCE-REVIEW.md).
Storage is implemented without a backwards-compatibility requirement: schema v6
is current, and `sane upgrade` is explicit. The notes below are the earlier
proposal. They do not authorize the adapter.

- Keep source-record v1 unchanged for CC/OC-only stores. Introduce a source-record
  v2 only through explicit extension, preserving the existing CC/OC pins and adding
  an optional Grok pin. Absence means unconfigured; `authorityId: null` continues
  to mean a configured source whose identity could not be resolved.
- A repository accepting Grok authorities needs schema v6, with an independently
  reviewed upgrade that preserves referenced authority rows, conversation history
  and protected triggers. Frozen v1–v5 definitions remain unchanged.
- Retain App manifest v1, metadata/admissions v1, public receipts v1 and private
  ledger v2 only where Grok fits their existing field meanings, evidence and size
  guarantees. If not, version the affected format separately. Do not recanonicalize
  historical receipts, pending requests or source descriptors.
- Keep retirement, worker and other unqualified workflows Grok-ineligible; adding
  a namespace must not send them through an existing adapter's fallback path.
- Specify Grok's actual descriptor/hash and native message evidence before fixing
  its persisted representation. Review extension publication/recovery and old-reader
  refusal before implementation; no automatic adoption, downgrade or replay.
  Current App receipt target validation distinguishes Claude UUID message IDs from
  OpenCode command/message equality; a Grok session UUID alone does not establish
  compatible message/acceptance evidence. Decide affected formats individually,
  without rewriting historical receipts or assuming their versions can be retained.

History, admission and receipt validators intentionally differ in native-ID bounds,
UUID case, path/token limits and message correlation. Preserve those acceptance
sets; this extraction does not replace them with a universal validator.

## Phase 2 — owner-bound run controls

Implementation in this checkout (2026-10-27):

- Ordinary prompt, compaction and observation-only recovery owners receive frozen
  controls before publication to the existing coordinator. No second owner registry
  or persisted owner format is introduced.
- Shared cancellation bookkeeping uses an explicit worker/user mode. Each adapter
  declares whether to retain a successful Stop result or coalesce only in-flight
  attempts; this no longer depends on `owner.native`.
- Local process cleanup and remote observer detachment remain distinct. Original
  cleanup/shutdown closures stay usable after launch identity failure, while
  cancellation and ordinary owned operations require the original binding.
- Preparation diagnostics use the installed controls. The private legacy native
  marker remains for existing native-specific protocols, not shared Stop/shutdown
  selection. Stream, process-group and settlement evidence remain native-specific.
- Fixed a cancellation source-redirection hazard: bound OpenCode cancellation now
  pins the original native ID and rechecks its source after submission and at the
  actual interrupt boundary. User Stop also freshly checks ownership/terminal state
  after endpoint discovery. No failed or ambiguous mutation is automatically retried.

Initial focused verification: **403 tests, 2,144 assertions, 12 isolated files, zero
failures/skips**, including the Phase 1 regressions and 110 new owner/service-control
cases. Seven scoped implementation/test entry points have zero TypeScript
diagnostics. Bridge baseline/current comparison retains only the same two existing
`user-questions-service.ts:26` diagnostics. Independent integration and cancellation
reviews approved this slice. This remains offline qualification, not a native
shutdown/crash-recovery trial; no services or installed runtimes were changed.

### Verification-minimality cleanup

A subsequent audit found defensive checks that were correct as assertions but
unnecessary at their call sites. The cleanup separates original resource ownership
from launch identity:

- Keep controls/source immutable at installation, but stop repeatedly inspecting
  property descriptors, frozen state or the shape of internally typed adapters.
- Stop authorizes the original owner/conversation/harness; local process termination
  no longer depends on current source fields or unchanged launch metadata. Launch
  operations still require their original identity and source.
- Leave native interruption checks in the OpenCode adapter after submission and
  immediately before the request. Removing the generic bridge source wrapper does
  not remove the actual mutation-boundary checks or permit retargeting.
- Read optional preparation timings without ownership/launch proofs. Diagnostics
  cannot authorize execution, and their copied output remains bounded.

Cleanup verification: **239 tests, 1,393 assertions, six isolated files, zero
failures/skips**. This includes regressions for stopping the original local child
after metadata drift and refusing a changed remote target. Six scoped static entry
points have zero diagnostics; the bridge comparison adds none beyond its two
existing diagnostics. This is a reduction in unnecessary checks, not a measured
latency improvement. No native calls, service changes, migrations or commits were
part of the cleanup.

**Grok readiness gate after main reconciliation:** agree the concrete Grok
source/evidence contract and explicit storage extension before the Base adapter
implementation below. The
Phase 3 extraction has focused offline coverage; none of these extractions alone
enable Grok or qualify its real adapter.

This can largely proceed alongside Phase 1. Replace shared routing based on the
misleading `owner.native` distinction—which currently means OpenCode—with checked
controls retained by the original admitted run:

- Request cancellation and coalesce in-flight attempts.
- Observe progress/terminal facts and expose existing diagnostics.
- Stop or detach during shutdown, drain owned work, and report uncertainty.

Keep one owner registry and the existing settlement/reconciliation authority.
Do not rediscover a replacement owner or current session configuration to control
an earlier run. Preserve owner/session/source matching checks.

Local process signaling, group termination, stream EOF and native result parsing
remain distinct. OpenCode observer detachment must not become native cancellation.
Extract small local-process helpers only where the Grok implementation actually
needs them; do not lift the entire Claude state machine into a universal manager.

**Exit:** CC/OC cancellation, shutdown and release behavior remains unchanged,
with no shared assumption that all native work is an App-owned process group.

## Phase 3 — pre-prompt conversation admission

Extraction implemented in this checkout (2026-10-27):

- `packages/sane-app/src/conversation-creation.ts` owns the bounded create-only
  begin and identity → caller publication → registration → ready sequence.
- `packages/sane-app/src/native-conversation-creation.ts` supplies separate
  caller-allocated Claude UUID and native-created OpenCode identity strategies.
  OpenCode uses the already-resolved launch and existing response validation;
  no prompt is sent to discover identity, and no model/default re-resolution occurs.
- Ordinary conversations, App-managed workers and newly prepared handoff recipients
  use the shared sequence. Their catalog ordering, activation reservations,
  worker-child linkage, metadata publication, guards and refresh remain caller-owned.
- Known handoff identities do not allocate/create again. Existing metadata is not
  duplicated; already-ready admissions still register but do not repeat `ready()`.
  Uncertain creation remains refused, with no reset, rollback or automatic replay.
- An unresolved caller-allocated intent now refuses explicitly instead of falling
  through to OpenCode creation. This is an unsupported-state refusal, not a new
  retry or migration mechanism.
- Attachment, fork/branch, general admission retry, handoff membership/phase binding,
  worker assignments and prompt submission remain separate existing lifecycles.

Three scoped implementation entry points pass TypeScript checking; bridge
baseline/current comparison retains only its two existing
`user-questions-service.ts:26` diagnostics. Independent sequence-equivalence and
minimality reviews approved the extraction. Initial review was static-only.

Focused tests were subsequently authorized and added in
`conversation-creation.test.ts`, `native-conversation-creation.test.ts` and
`conversation-creation-integration.test.ts`:

- Actual helpers and durable `AdmissionService` records cover unknown-before-native,
  delayed/lost acknowledgements, disk reload and no replay, publication/registration
  failures, known identity reuse, conditional ready and repository parent binding.
- Native factory tests use structural adapter ports, preserving lazy allocation,
  already-resolved launch forwarding, error propagation and no implicit retry.
- Caller wiring executes complete, unedited AST-selected bridge closures with
  offline ports. It covers ordinary continuation exclusion and guard boundaries,
  handoff metadata/reservation reuse and fresh Claude activation, and worker
  child-link → metadata → association/registration/ready → assignment ordering.
  This is executable source-wiring coverage, not a booted bridge or HTTP test;
  admissions/catalog/domain/worker-store/executor are doubled in that file, and
  publication uses the real publisher without the bridge write queue. Separate
  tests exercise actual admission persistence and repository registration.

Final focused verification: **221 tests, 1,250 assertions, eight isolated files,
zero failures/skips**, including **55 new Phase 3 cases**. The three new test
entries and five adjacent regression entries pass scoped TypeScript checking;
the implementation check remains clean and bridge baseline/current comparison
adds no diagnostics beyond the two known errors above. Independent test reviews
approved the coverage after correcting test-only typing and temporary-directory
portability issues. Local evidence is retained under
`/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/phase3-admission-regressions-c4jfryvy/`.

These are offline boundaries, not native acceptance, run installation, process
crash/power-loss, router-discovery or full bridge qualification. No production
fixes, persisted formats, runtimes or running services changed during the test
slice. Grok source/storage proposals remain unapproved; after the main integration
checkpoint above, resume their bounded contract review rather than more general
decoupling or premature feature enablement.

Extract the repeated create/admit orchestration used by ordinary conversations,
workers and handoff recipients:

1. Persist the original creation intent and source/checkout binding.
2. Establish native identity through the selected adapter.
3. Persist/register the App conversation and make its admission ready.
4. Enter the existing context/submission pipeline.

The adapter owns native-ID validation, allocation and creation acknowledgement.
Caller-allocated UUIDs and native-created session IDs are different strategies.
Creation uncertainty remains durable and non-replayable.

**Exit:** native identity and ready admission exist before owned context-message
preparation and dispatch. Initial `PreparedUserInput` preflight may still precede
native creation; it is not an outgoing native prompt or admission acknowledgement.
Do not send a first model prompt merely to discover an identity and then pretend
it was bound before dispatch. Resume remains distinct from activation.

## Phase 4 — Grok Base vertical slice: near scope

Add a thin Grok adapter using the committed App pipeline, not the experimental
prompt wrappers. The prior UUID, verbatim prompt-file and explicit-resume trial
is a starting point, not current runtime qualification.

The first useful slice includes:

- Explicit runtime/source configuration and the reviewed persistence extension.
- One deliberately enabled Base profile; native model/default/effort handling.
- New conversation, exact outgoing input, continuation, streaming output and
  persisted App transcript, with truthful submission/acceptance distinctions.
- Stop, terminal settlement, App shutdown and retained uncertainty. Qualify whether
  the selected CLI route owns execution or delegates work elsewhere; wrapper exit
  alone cannot prove native cancellation.
- Registry-driven UI availability and model routing, without a layout redesign.
  Catalog caches must not mix different harnesses or native sources.
- Base is not a provenance bypass: if its shell tools can reach the SANE CLI,
  establish safe native-origin classification first or leave that access
  unavailable. An unqualified native call must never be interpreted as human/local.
- Expected eligibility/unavailability refusals distinguished from ambiguous native
  mutation and genuine storage/invariant failure. No automatic retries or replay.

For Grok, keep native queues, live input, restart recovery, external-history attachment,
branching, compaction, native delegation, workers and utilities unavailable until
their individual contracts are qualified. Do not advertise unsupported operations
merely because the harness can produce a response.

**Exit:** an authorized, bounded new-conversation → continuation → Stop/shutdown
workflow passes using the real Grok adapter, with no regressions to CC/OC.

## Phase 5 — Grok SANE-role enablement: near scope

SANE roles and required managed-worker workflows remain part of the intended Grok
scope, not an indefinite follow-on requiring full CC/OC feature parity. Select the
first intended workflow and its required capabilities during the Grok contract
review; qualify native authentication, policy enforcement and delivery before
enabling it. The shared App orchestration is reused rather than reimplemented.

After the Base slice, qualify an explicitly selected initial role/workflow scope:

- Separate logical SANE tools from native per-call caller qualification. Bearer
  possession or Claude-like payload fields are not sufficient caller identity.
- Propagate native origin through shell-to-CLI calls. Missing or unqualified
  native provenance must not acquire local/human privileges. Resolve this before
  exposing tool-enabled SANE workflows, not after enabling shell access to them.
- Provide a supported Grok execution-policy translation. Preserve pinned policy
  compatibility and report unsupported enforcement rather than silently dropping
  permissions or relying on role prose as an enforcement mechanism.
- Provision only the selected runtime's required hooks/MCP configuration. Do not
  duplicate SANE context into a second system/hook/instruction-entry channel.
- Enable required handoffs, managed workers and exact report-back only when their
  tools, invocation identity, relationship authorization and delivery evidence are
  qualified. Worker profiles may initially remain on existing qualified harnesses;
  cross-harness parent/report delivery still needs qualification.
- Keep native children separate from App-managed workers. Enable forms, sharing,
  science, pairing and utilities only as the chosen workflow requires.

**Exit:** the agreed initial Grok SANE workflow works with the existing App
orchestration and explicit capability limits. Full CC/OC feature parity is not
assumed. Review the completed Grok scope before starting the Gemini follow-on.

## After Grok — Gemini research, then a separate integration decision

Gemini is a follow-on research item, not a parallel adapter implementation or a
promised production capability. First identify the actual target harness:
the existing experiment used **Antigravity CLI (`agy`) with a Gemini model**;
it is not evidence that Gemini CLI or another Gemini-backed harness has the same
contracts.

Research must resolve:

1. Native source/profile isolation, discovery and identity allocation before the
   first prompt. Captured Antigravity help advertises streaming stdin, but its
   initialization/identity-before-input handshake was not exercised.
2. Exact input transport, native message/history correlation and terminal facts.
   Opaque SQLite/protobuf byte inclusion is not an admission acknowledgement or
   proof of model consumption.
3. Actual execution ownership, cancellation, background work and restart behavior.
4. Enforceable permissions, ambient configuration, MCP/tool caller authentication
   and shell-to-CLI provenance. The earlier Antigravity trial found no
   disable-all-tools switch; response-only instructions were not a sandbox.
5. Native model/effort reporting and feature-by-feature support. Requested or
   reported model labels are not independent backend verification.

Start this work after the agreed Grok scope is completed and reviewed, unless the
user explicitly changes the sequence. Its findings determine the adapter and
whether any further shared boundary is genuinely needed. Do not weaken the current
admission order to accommodate an assumed late-ID protocol.

## Validation and non-goals

Plan focused offline regressions for each changed boundary: unchanged CC/OC source
identities and records, unknown-value refusal, native creation uncertainty, exact
wire/source binding, cancellation/shutdown ordering, and truthful capability gates.
Existing snapshots, receipts and historical native evidence remain immutable.

Native/model trials, migration, installation, browser verification and service
restarts require explicit authorization and bounded scope. A passing offline test
run is not full native, crash/recovery or long-history qualification.

No broad UI redesign, new global scheduler/owner registry, recurring historical
context proof, universal permission engine or universal plugin framework is part
of this plan. Optional feature parity must not indefinitely delay the first useful
Grok slice.

## Source map and existing evidence

- [Registry/capabilities](../../../packages/sane-app/shared/conversation/harness-capabilities.ts),
  [checked operation dispatch](../../../packages/sane-app/src/harness-operations.ts)
  and [shared submission coordinator](../../../packages/sane-app/src/run-submission-preparation.ts).
- [Core identities](../../../packages/sane-core/src/contracts.ts),
  [source normalization](../../../packages/sane-core/src/native-source.ts),
  [repository schema](../../../packages/sane-core/src/schema.ts),
  [App storage](../../../packages/sane-app/src/app-store.ts) and
  [receipt codecs](../../../packages/sane-app/shared/conversation/app-admission-contract.ts).
- [Claude lifecycle](../../../packages/sane-app/src/claude-run-service.ts),
  [OpenCode lifecycle](../../../packages/sane-app/src/opencode-run-service.ts),
  [policy translation](../../../packages/sane-app/src/canonical-agent-operations.ts)
  and [App worker orchestration](../../../packages/sane-app/src/workers.ts).
- [Grok experiment notes](../../../experiments/user-owned-context/GROK.md) and
  [shared probes / Antigravity experiment notes](../../../experiments/user-owned-context/README.md).
  These are standalone five-turn experiments, not production adapters or tests of
  the current submission pipeline. Detailed reports/captures under
  `reports/user-context-*` remain local and ignored; do not publish or rewrite them.
