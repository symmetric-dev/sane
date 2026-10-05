# Conversation notifications — remaining gaps

Status as of **2026-10-05**. This is a checkpoint for ongoing work, not a claim
that native OpenCode reply notifications are enabled or runtime-qualified.

## Current behavior

- Existing OpenCode App-run completion, failure, and interruption alerts remain
  available. Session bells, unread counts, and the shared notification panel are
  not disabled.
- App-owned Claude Code processes can produce independently unread parent replies
  within one run. A later reply is not read merely because an earlier reply or
  the App run was opened.
- Shared durable update ingestion, client-local IndexedDB unread state, exact
  captured acknowledgements, and continuous read-only legacy import are implemented.
- OpenCode preparation includes zero-origin reconstruction, bounded incremental
  replay, an exact durable message-identity ledger, creation-bound registrations,
  guarded commits, certified baselines, and bridge lifecycle wiring.
- **Production native OpenCode reply activation is hard-disabled.** Supplying a
  qualification descriptor alone cannot enable it.

The latest code checkpoint passed **566 focused tests across 18 files**, package
typechecking, and whitespace checks. Runtime qualification fixtures use fake
transports; bridge tests use an isolated App and fake CLI. These results do not
prove real-service or real-browser behavior. This checkpoint extends commit
`9130cbc`; loading the new implementation requires an App restart, not implicit
native activation.

## G1 — Native OpenCode durable replay is unavailable

**Hard activation blocker.** The inspected registered service runs OpenCode
`2.0.21`; the App's generated client is `@opencode/client@2.0.18`.

Read-only checks of enrolled parent conversations returned no durable replay
events despite positive `log.synced` watermarks. Native source explains the
behavior: sequence/projector updates occur regardless of event persistence, Bus
defaults persistence to false, and local CLI server startup does not supply the
`events.persist` option. No supported local CLI flag or service/configuration
setting was found to enable it.

Tagged **`2.0.23` source retains this behavior**. That finding is a source
comparison, not a runtime test of its compiled executable. Upgrading or restarting
solely for this issue is not an evidenced remedy.

Needed: an upstream-supported local startup/configuration path that retains
durable event payloads, followed by explicitly coordinated installation and
activation. Do not patch the installed binary, invent configuration flags, or
silently substitute a live-only observer.

## G2 — Runtime reply qualification is incomplete

Even with retained events, verify actual native traces before enabling alerts:

- Final nonempty parent text and the last eligible stop step precede the correct
  terminal boundary.
- Background-subagent results can produce a new parent reply after the original
  App command completes, without another user submission.
- Child, tool-only, reasoning-only, compaction, and control-only activity does not
  create a reply occurrence.
- Retry, text replacement, unsafe reopen, disconnect, version change, and restart
  behavior preserve occurrence identity and coverage.

Idle or execution success alone is not proof of a useful reply. Global native
events are wakeup hints, not replay checkpoints. The implementation distinguishes
contiguous replay progress, ordinary-log certification, and the pinned historical
fence; a head probe establishes a fence, not reconstructed coverage.

## G3 — Existing histories may lack a reconstructable baseline

Enabling persistence would retain **future events only**. Missing historical
creation IDs, event order, and sequence-zero creation evidence cannot be recovered
by guessing from mutable message snapshots or timestamps.

The current reducer requires matching native creation evidence at sequence zero.
Existing sessions without it need an independently evidenced baseline strategy;
otherwise they remain unsupported. Fresh sessions created after persistence is
enabled are the simplest initial qualification candidates.

Incremental replay removes the former all-or-nothing catch-up limit, but resource
ceilings remain: 256 KiB checkpoint state and a 16 MiB generic update store,
including retained exact identities. Capacity exhaustion must degrade the affected
source without discarding replay evidence or failing primary App execution.

## G4 — Exact App/native terminal correlation remains limited

Unique command-bounded assistant-message evidence can attribute a native reply to
an App `runId`. It does **not** establish a one-to-one terminal `legacyRunId` alias.
Native terminal events do not directly carry an App command or final-message ID.

Unsupported mappings remain unset. Preserve run-specific App fallback until an
exact alias proves replacement; source readiness or shared `runId` alone must not
suppress it. Never transfer one run's read state to all same-run replies or
rewrite incarnationless historical occurrences into a new native incarnation.

Before activation, verify real correlation cases and accept or resolve the
remaining overlap between unmapped native attention and authoritative App alerts.

## G5 — Real-browser verification remains outstanding

Controlled tests cover transactions and races, but do not establish actual
cross-tab IndexedDB behavior. Verify:

- Two tabs committing pages and exact reads concurrently.
- Reload/recovery, late legacy-tab writes, storage failure, and source rebinding.
- A reply arriving during navigation/acknowledgement remains unread unless it was
  in the captured set.
- First reply opened, later same-run reply independently unread.
- Cross-workspace navigation, session grouping, mobile controls, and the shared
  animated/counting icon.

Start with currently available Claude reply and OpenCode App-run behavior.
Native OpenCode cases follow only after G1–G3 are satisfied. Coordinate browser
verification explicitly; do not equate automated fixtures with browser acceptance.

## Intentional scope boundaries

- Reliable observation of external Claude Code processes is not supported.
- Sounds, OS notifications, permission prompts, Web Push, and delivery while the
  PWA is closed are outside this phase. Backend replay is not OS delivery.
- Unread state remains client-local; there is no backend read ledger.

## Recommended next focus

1. **For native OpenCode notifications: resolve G1 upstream before more activation
   work.** Obtain a supported durable-replay path, then qualify fresh sessions and
   address historical baselines and terminal correlation. Do not enable the gate
   from version information alone.
2. **While that prerequisite is blocked: prioritize G5 for the behavior already
   available.** Real-browser acceptance has more immediate value than extending
   an observer that cannot obtain authoritative replay.
3. After qualification and acceptance, make activation an explicit reviewed
   change. An App restart loads preparation code but does not enable native alerts;
   any native-service restart or upgrade is separately coordinated.

## Reference locations

- [`opencode-reply-integration.ts`](../../../packages/sane-app/src/opencode-reply-integration.ts)
  — production gate, admission, coverage, and conservative correlation.
- [`opencode-reply-observer.ts`](../../../packages/sane-app/src/opencode-reply-observer.ts)
  — qualification requirements, replay slices, checkpoints, and cancellation.
- [`oc-reply-reducer.ts`](../../../packages/sane-app/shared/conversation/oc-reply-reducer.ts)
  — native boundary reconstruction and exclusions.
- [`notification-source.ts`](../../../packages/sane-app/frontend/notification-source.ts)
  and [`notifications.ts`](../../../packages/sane-app/frontend/notifications.ts)
  — source identity, fallback, and exact client reads.

For future OpenCode versions:

- [Official CLI npm metadata](https://registry.npmjs.org/@opencode%2fcli)
- [V2 comparison: 2.0.21 to 2.0.23](https://github.com/anomalyco/opencode/compare/v2.0.21...v2.0.23)
- [2.0.23 Bus persistence default](https://github.com/anomalyco/opencode/blob/v2.0.23/packages/core/src/bus.ts#L203)
- [2.0.23 CLI startup options](https://github.com/anomalyco/opencode/blob/v2.0.23/packages/cli/src/server-process.ts#L93-L138)
- [2.0.23 server persistence option](https://github.com/anomalyco/opencode/blob/v2.0.23/packages/server/src/options.ts#L21-L25)

No published `v2.0.23` GitHub release entry, working `/v2/changelog` page, or
installed CLI changelog was found during the audit. Prefer official **V2 tags**
and compare persistence defaults, server wiring, CLI forwarding, documented
configuration, and protocol contracts independently.
