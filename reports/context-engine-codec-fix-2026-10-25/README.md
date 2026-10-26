# Canonical prepared-input codec fixes

Implemented on the merged `experiment/user-context-delivery` baseline. This fixes
the codec blocker recorded in the earlier sync report; it does not wire the new
message engine into the App or change native delivery/journal ownership.

## Corrected contract

- New canonical assistant preparation captures immutable `canonicalActivation`
  resolver output: the paired execution/context snapshot and optional qualified
  policy model plus its variant. It is not accepted from raw user request fields.
- Only a new assistant creation or a genuine Base→assistant activation can contain
  that capture. Existing assistant/worker/archival resumes preserve their prior
  configuration exactly, without resolving today's canonical files or models.
- Canonical upgrades now include `agentKind`, the correct native-selection flag,
  and the `package.activation: "upgrade"` marker during preparation. The existing
  bridge marker assignment becomes idempotent rather than changing the pair.
- Decoder reconstruction starts with captured prior/request/profile choices and
  the explicit canonical resolver capture, not arbitrary effective configuration.
  Canonical OC creation requires captured `build`; legacy OC creation still
  requires the native role agent. OC creation cannot omit its native launch.
- Policy defaults apply only in OC's absent-model fallback branch. Explicit
  models/variants win; empty upgrade profiles clear Base defaults. CC ignores the
  policy's OC defaults and retains support for requested/profile model aliases.
- Captured policy models must have nonempty provider/model components. A captured
  variant requires its model; it is not an independent CC effort selection.
- Pending-input snapshots explicitly forbid activation captures as well as staged
  upgrades/native launches. Existing exact prior/launch/chain pin comparisons,
  uncertainty, recovery and no-replay rules remain unchanged.

`canonicalActivation` is an additive internal prepared DTO field, not a new
activation ledger or proof of authored provenance. The strict codec checks shape
and consistency; owning admission must still validate the real paired stores.
Established queue records emit no new field and retain their existing v1 shape.
Previously malformed canonical creation/upgrade records are not silently repaired
or reconstructed from current sources.

Changed production files:

- `packages/sane-app/src/user-input-preparation.ts`
- `packages/sane-app/src/prepared-input-codec.ts`
- `packages/sane-app/src/pending-input-codec.ts`

## Verification

With explicit user authorization, added **72 focused regression tests** in
`packages/sane-app/src/prepared-input-codec.test.ts`. Coverage includes CC/OC
creation/upgrades, model/variant precedence, malformed/tampered captures, exact
authored text, raw-field isolation, canonical capture mutation isolation,
native-stopped acknowledgement, legacy/worker/Knowledge resumes, established
upgrade-marker preservation, real pinned-store/factory preparation, and actual
durable pending-store reload with simulated live authority and no dispatch.

The initial 30-case reproduction had 26 failures and four passes, exposing the
creation reconstruction and missing upgrade identity fields. After fixing those,
the audit found an additional malformed model/variant capture gap, which was
tightened and covered before final verification. Final read-only audit: no
remaining concrete issues within the bounded codec scope.

- **494 tests passed**, zero failures, 1,653 assertions across 11 selected files:
  72 new preparation/queue cases plus the existing 422 engine/demo cases.
- **Zero scoped TypeScript diagnostics across 27 entry files**, using cached
  external declarations and worktree workspace sources, not a full-App typecheck.
- Existing mock vertical-slice/replay checks remain passing as part of the focused
  run; they are still simulated transport/acceptance, not native/model proof.
- All 171 Antigravity and 163 Grok historical manifest entries still match.
- No full repository suite, browser verification, native/model calls, dependency
  installs, context/skill edits, or integration cutover.

See `checks.json` for exact commands, hashes, statuses and manifest checks;
`tests.junit.xml` and `*.log` contain raw final output. The verification helper and
original outputs remain under:
`/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-codec-fix.DExeCt/`.

## Next integration boundary

Codec preparation now round-trips correctly. Bridge-owned trusted context/placement
readers, final native identity binding, and synchronous owner-controlled durable
context evidence remain separate integration work. No composed text replaces
`prepared.prompt`, and no injector or acknowledgement gate was removed here.
