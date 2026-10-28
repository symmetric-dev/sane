# Grok Phase 4 review

Review date: 2026-10-27. Branch: `experiment/user-context-delivery`.
Scope: commits `906d426` and `eb6c2cf`, plus the uncommitted Grok work on top.
This is a review, not a plan change. It does not authorize a live trial, a
profile, a receipt change, a push, or Phase 5.

## How this review was done, and its limits

- Shell commands could not run in this session. A shell wrapper adds an
  environment export, which needs approval, and nothing could approve it.
  So `git log`, `git status`, `git show --stat`, `git diff`, and the focused
  tests were **not** run.
- The split between committed and uncommitted work below comes from the
  session's start-of-session git-status snapshot, plus a reading of the
  current working-tree files. For `bridge.ts`, `admission.ts`, and
  `app-config.ts`, which are modified rather than new, I could not see the
  diff. Where I say which lines are uncommitted, that is an inference from
  the handoff and from which symbols the new files call. It was not read
  from a diff.
- The claim of "39 pass across six Grok test files" was not run. By static
  count there are 39 `test(` declarations across `grok-adapter` (11),
  `grok-capture` (7), `grok-harness` (6), `grok-send` (6), `grok-executable`
  (6) and `grok-fallthrough` (3). There is no `skip`, `only`, or `todo`. The
  count matches. Whether they pass is unverified. Several of those tests
  lock in defects listed below.
- No grok process was run, PATH was not searched, the bridge was not
  booted, and `/Users/beto/sane` was not read or touched.

## 1. What is actually done

### Committed (`906d426`, `eb6c2cf`; tracked and unmodified in the tree)

- **Storage.** Core schema v6 is current (`sane-core/src/schema.ts:2`).
  `repository.ts:336` refuses any other version with "requires an explicit
  local sane upgrade". Open does not migrate.
- **Source pin.** `app-store.ts` `publishGrokSourcePin` writes sources v2
  with `cc` and `oc` copied and `gk: grokSourceRecord(homeRoot)`. It is an
  explicit publication, and no production code calls it.
- **Admissions v2.** `validateStoredAdmissions` admits create-only `gk`
  rows with a UUID native id, a `local-home` descriptor, and a pinned `gk`
  authority. `validateAppStore` requires every admission to match its store
  pin, including `gk`.
- **Registry.** `harness-capabilities.ts` has a third descriptor:
  `grok` / `gk` / "GK". It advertises `prompt` and `cancelOwnedRun` as
  supported, and every other operation as unsupported.
- **Profile.** `BASE_PROFILE_IDS.grok = "base:gk"`. `builtinProfiles` seeds
  "Base · Grok", which is visible. `loadAgentProfiles` merges it into any
  existing `agents.json` on load. `defaultId` stays `base:cc`.
- **Adapter.** `grok-adapter.ts` `createGrokDispatchAdapter`: readiness,
  `execute` (spawn, prompt file, stream watch, tool-boundary kill), a
  spawn-uncertain latch, `successfulSettlement` that always denies,
  `stopGrokDispatch`, and `grokDispatchObservation`.
- **Bridge refusals.** These are in `bridge.ts`, but whether each one is
  committed or uncommitted is unverified. Every `dispatchHarness` grok arm
  throws 501. Prepared admission, queues, workers, handoffs, live input,
  question delivery, history checks, browser pairing, and repository
  sources refuse Grok explicitly.
- **Tests.** `grok-storage`, `grok-adapter`, `grok-harness`,
  `grok-fallthrough`.

### Uncommitted

- `app-config.ts`: config v2 `native.grok.executable`,
  `explicitGrokExecutable`, and `publishGrokExecutable`. The executable must
  be absolute and is never resolved against PATH or the config directory.
- `bridge.ts` (inferred): `options.grokExecutable` is threaded from
  `explicitGrokExecutable`. `configuredGrokExecutable()` passes it to
  `dispatchRegistry.register(createGrokDispatchAdapter({ executable }))`.
  No `promptDirectory`, `env`, `model`, or `effort` is passed.
- `admission.ts`: `AdmissionService.beginGrokCreate` writes a create-only,
  `identity_known`, app-only admission and publishes admissions v2.
  `refuseGrokRepository` returns 501 for `createNative`, `register`,
  `ready`, and `enroll` on a `gk` admission.
- New `grok-capture.ts`: a non-receipt `grok-captures.json` v1 journal with
  sealed `nativeAcceptance: "unknown"` and `acceptedMessageId: null`.
- New `grok-send.ts`: `createGrokSendSession` and `runGrokTurn`. A new turn
  allocates a UUID, calls `beginGrokCreate`, then spawns with
  `--session-id`. A continuation spawns with `--resume`.
- New tests: `grok-capture`, `grok-send`, `grok-executable`.

**Nothing calls `runGrokTurn`, `beginGrokCreate`, `publishGrokExecutable`,
`publishGrokConfig`, or `publishGrokSourcePin` outside tests.** The bridge
adapter can never spawn, because `execute` refuses without
`promptDirectory`. Grok is therefore not reachable over HTTP today. That is
what keeps the defects below latent rather than live.

## 2. Where the code matches the plan and the evidence review

| Contract item | Status |
| --- | --- |
| Third source `gk`; session name `grok`; not CC or OC | Matches. `dispatchHarness` has an explicit third arm. `toNativeHarness` refuses Grok (tested). |
| Identity is the home only | Matches **in the hash**. `grokSourceRecord(homeRoot)`. Executable, model, and effort are not in the descriptor. |
| No PATH lookup | Matches. Config, bridge, adapter readiness, and `assertEligible` all refuse a relative or bare `grok`. |
| Missing pin = unconfigured; `authorityId: null` = unresolved | Matches. `beginGrokCreate` returns `grok-unconfigured` vs `grok-unresolved` (tested). |
| Caller-allocated UUID, `--session-id` then `--resume`; UUID is not acceptance | Matches. The admission stays `identity_known`, not `ready`. |
| `msg_0`, exit 0, and `subtype: success` are not acceptance | Matches. `acceptedMessageId: null` by type and on decode. `successfulSettlement` always denies. |
| Receipt v1 not widened; no receipt bump | Matches. `checkSourceFields` is still CC/OC only. The send test asserts that no receipt file is written. |
| Prepared admission refuses Grok; no HTTP send route | Matches. |
| Open does not migrate; v5 needs `sane upgrade` | Matches. |
| Default stays `base:cc`; `base:gk` only for Grok | Matches. `validateProfileIdentity` binds `base:gk` to `harness: "grok"`. |
| No automatic retry or replay | Mostly matches. There is a spawn-uncertain latch, a tool-boundary latch, and duplicate session/native-id refusal. The gaps are listed in §3. |
| Live input, queues, recovery, history, branch, compaction, workers, handoffs, tools, utilities unavailable | Matches in the registry and in the bridge refusals. |
| Admissions v2 only by explicit create | Matches the evidence table. Metadata v2 is not implemented, which is consistent with "no Grok session in metadata v1". |

### Divergences from the documents

- **Authorization drift.** STATUS, PLAN, README, and the evidence review all
  still say that the adapter and the profile are not authorized.
  `eb6c2cf` and the uncommitted work are adapter work, and `base:gk` is a
  visible profile. Either the documents are stale or the work is ahead of
  its authorization. The decision-maker should settle this. This review does
  not edit those documents.
- **The launch differs from the only observed trial.**
  `experiments/user-owned-context/grok.ts:29-33` launched with
  `GROK_MEMORY=0`, managed MCPs off, and
  `GROK_{CLAUDE,CURSOR}_{AGENTS,RULES,HOOKS,MCPS,SKILLS}_ENABLED=false`. It
  passed the inherited env minus `SANE_*`, used an `inspect --json`
  preflight, and had a 180-second external timeout. The adapter keeps the
  argv but drops all of the env overrides, the preflight, and the timeout.
  The plan calls the trial "a starting point". The adapter is weaker than
  that starting point.
- **Capability advertisement.** The plan says "Do not advertise unsupported
  operations." The registry says that `prompt` and `cancelOwnedRun` are
  supported. In the bridge, however, Stop throws 501 (`bindOwnerControls`
  grok arm, `bridge.ts:1259`), and the registered adapter refuses every
  `execute`.

## 3. What is broken, unsafe, or only looks done

### Contract violations (latent: no reachable spawn today)

**V1. The pinned home is never applied at launch.** In
`grok-adapter.ts`, `childEnv` forwards only `PATH` and `HOME`. `GROK_HOME` is
never set anywhere in `grok-adapter.ts` or `grok-send.ts`. `runGrokTurn`
builds the adapter with no `env`, so the real child gets an **empty**
environment.
`beginGrokCreate` checks the `gk` pin for `homeRoot` X and records
`sane-native-v1:gk:<hash of X>`. The process then runs against whatever home
Grok picks by default, or none at all. The authority in the admission and
in the capture journal does not describe the process that ran. "Identity is
the home directory descriptor" holds for the hash, but it is not enforced
for execution. The test `grok-adapter.test.ts` "child env has no SANE caller
variables" asserts `env` equals `{ PATH, HOME }` exactly, so it locks in
this defect.

**V2. An unqualified native call would be classified as local.** `sane-cli`
`cli-command.ts:160` treats a call with no caller envelope as
`actor: { kind: "local" }`, and `:145` lets a local caller run `sane upgrade`.
The adapter deliberately strips the caller variables and forwards `PATH`.
Its comment says "Absence is what keeps the child from looking like a
human/local SANE caller". That is backwards: absence is exactly what a human
terminal looks like.

The only barriers are `--deny '*'` and a kill after a tool-use event is
seen. The kill comes after the tool already ran. The trial notes say
`--deny '*'` "does not remove every tool schema". Dropping the
`GROK_CLAUDE_*_HOOKS`/`MCPS` overrides also lets Grok import Claude hooks
and MCP servers from the user's profile, and those run outside tool
permission. Phase 4 requires "establish safe native-origin classification
first or leave that access unavailable". Neither has been done.

**V3. The profile and capabilities are exposed before Grok exists for the
user.** `loadAgentProfiles` rewrites every existing `agents.json` at
startup to add a visible "Base · Grok", even when Grok is unconfigured. The
registry advertises prompt and Stop that the bridge cannot perform. The
evidence review says unconfigured Grok must not change startup or records.
This is not a CC/OC record or default, and `defaultId` stays `base:cc`, so
it is a soft violation. It is still an unconfigured-Grok startup write, and
it shows users a choice that fails with 501.

### Bugs that make the slice only look done (would block the Phase 4 exit)

1. **Stop before spawn is lost.** In `grok-send.ts` `runGrokTurn`, the
   `owner` is assigned only after `await beginGrokCreate`. A `stop()` during
   that window returns `grok-stop-refused`, and the spawn then goes ahead.
   The test "stop reports cancellation unproven…" asserts this behaviour.
2. **A refusal after admission strands the identity.** `execute`'s
   `refuseBeforeSpawn` handles a missing prompt directory or a failed `wx`
   prompt-file write. It returns normally *after* `beginGrokCreate` has
   persisted `identity_known` and set `session.nativeSessionId`. A later
   `new` turn is refused, while a `continuation` would `--resume` a native
   session that was never created. Prompt file names are
   `run-1.<serial>.prompt.txt` with `runId` fixed and a per-adapter serial,
   so two sessions sharing a directory, or a restart, collide.
3. **The capture journal overwrites evidence.** `createGrokSendSession`
   always starts an empty journal, and `persistGrokCaptureJournal`
   rename-replaces `grok-captures.json`. A second session or a restart in
   the same capture directory erases earlier turns. Each turn also rewrites
   every prior stdout, so cost grows quadratically.
4. **A capture failure masks the error and does not latch.** If
   `persistTurn` throws in the `try` block after appending, the `catch`
   calls `persistTurn()` again. That hits "duplicate turn index" and throws
   in place of the original error. `session.blocked` stays false, so the
   caller can send again after a submitted turn whose evidence was lost.
5. **The exit is read before stdio drains.** `waitForExit` resolves on
   `"exit"`, not `"close"`. Node may still deliver stdout after `exit`.
   Final lines, including the `result` event or a late tool-use event, can
   be missed by both capture and the tool boundary. Owned file streams are
   ended before late writes arrive, which gives write-after-end errors. The
   fakes write synchronously before emitting `exit`, so the tests cannot see
   this.
6. **A spawn failure can crash the process and is misclassified.** If the
   executable is missing or not executable, real `child_process.spawn`
   returns a child with no `pid` and emits `"error"` asynchronously. The
   no-pid branch throws without attaching an `"error"` listener, so the
   unhandled `error` event takes down the process. It also latches the
   session as `grok-spawn-uncertain` with outcome `unknown`. Phase 4 asks
   to separate expected unavailability from ambiguous native mutation.
7. **Continuation is allowed after an unproven cancel.** After
   `stopGrokDispatch` or the tool-boundary kill, `nativeCancellation` is
   `"unproven"`, but only spawn-uncertain and tool-boundary latch the
   session. After a plain Stop, a `--resume` continuation can start while
   native work may still be running. `exit.signal` is discarded.
8. **No timeout.** The trial used 180 s. The adapter waits forever.
9. **Fixture values in production.** In `ownerFor`, `runId: "run-1"` and
   `createdAt: "2026-10-27T00:00:00.000Z"` are hard-coded.
10. **The admission binding is weaker than CC/OC.** `beginGrokCreate`
    writes `domain: app-only` and `checkoutPin: null` without inspecting a
    repository workspace, so checkout drift is not detected. It is also
    called from `runGrokTurn` outside the bridge's serialized admission
    gate. That is fine offline, but it must not be wired that way.
11. **There are two records of the home.** `config.native.grok.homeRoot`
    (written by `publishGrokConfig`, not realpath'd) and the sources v2
    `gk` pin (realpath'd) are never compared. Nothing says which one would
    drive `GROK_HOME`.
12. **The adapter is cached per session.** `session.adapter` keeps the
    first `executable`. A later change is ignored silently.
13. **There is no persisted App transcript or streaming to the UI.** There
    is no metadata v2 session row. The capture journal is non-receipt
    evidence and is not the App transcript Phase 4 requires.

Items 1–13 are unfinished-Phase-4 or correctness defects, not contract
violations. Items 2, 4, and 7 come close to "no automatic retry or replay",
because they leave a path where a caller can send again on uncertain
native state.

## 4. Adjust before any more implementation

Keep these inside `grok-adapter.ts`, `grok-send.ts`, `grok-capture.ts`,
`admission.ts`, the registry and profile seeding, and their focused tests.
No bridge send wiring until these land.

1. **Bind launch to the pin (V1).** Derive `GROK_HOME` from the sources v2
   `gk` descriptor. Re-run `normalizeNativeSource` immediately before spawn
   and refuse if the result is not equal to the admission's `authorityId`.
   Pass that env from `runGrokTurn`. Make the pin the single source of
   truth, and drop `native.grok.homeRoot` from config or refuse on mismatch.
   Change the env test to assert `GROK_HOME` equals the pin.
2. **Close the provenance hole (V2).** Port the trial's overrides
   (`GROK_MEMORY=0`, managed MCPs off, all `GROK_CLAUDE_*` and
   `GROK_CURSOR_*` false). Then pick one of two options and record it:
   (a) remove `sane` from reach by passing a fixed minimal `PATH` or none,
   since the executable is absolute; or (b) set an explicit
   unqualified-native marker that `cli-command.ts` refuses, rather than
   letting absence mean `local`. Either way, fix the inverted comment in
   `childEnv`. Treat this as Base-slice safety, not Phase 5 qualification.
3. **Process lifecycle (bugs 5, 6, 8).** Settle on `"close"`. Attach the
   `"error"` listener before the pid check. Check the executable with
   `stat` and `access(X_OK)` before admission and refuse with
   `grok-eligibility-refused`; that is not a PATH lookup. Add a bounded
   timeout that kills only the owned child and records `unproven`. Record
   `exit.signal`.
4. **Ordering (bugs 2, 9).** Do every fallible pre-spawn step before
   `beginGrokCreate`: the prompt directory, and a prompt file uniquely named
   from the App session id and turn index. Replace the fixed `runId` and
   `createdAt`. If anything still refuses after admission, block the
   session. Do not leave a resumable identity that was never created.
5. **Stop (bugs 1, 7).** Honour a pending stop before spawn: the turn ends
   `not-submitted`, with no spawn. After any kill (Stop, timeout, or tool
   boundary), latch the session as blocked until there is an explicit
   operator decision. Never auto-continue.
6. **Capture (bugs 3, 4).** Use one file per App session, or load and merge
   on create and refuse if the on-disk journal differs from memory. A
   capture failure after submission must latch `session.blocked` and keep
   the original error.
7. **Advertisement (V3).** Until the bridge actually performs them, mark
   Grok `prompt` and `cancelOwnedRun` unsupported in the registry. Either
   do not merge `base:gk` into existing `agents.json`, or seed it `hidden`
   until a `gk` pin exists. Update `grok-harness.test.ts` to match.
8. **Admission (bug 10).** Decide explicitly whether Grok is app-only even
   in a repository workspace. If it is, refuse repository workspaces rather
   than silently recording `app-only`. Document that `beginGrokCreate` must
   be called inside the bridge admission gate.
9. **Authorization record.** Have the plan owner confirm in writing that
   the adapter and profile work is authorized, since the current documents
   say it is not. This review does not change those documents.

For each change, write focused offline tests only, and only when asked
(per AGENTS.md). Run only the six Grok files plus `grok-storage`.

## 5. Best next step

**If the slice were sound:** wire the offline Base send through the bridge
for an app-only `base:gk` conversation. That means metadata v2 for the Grok
session row, the App transcript from the captured stream, the
`bindOwnerControls` grok arm calling `stopGrokDispatch`, and a
`promptDirectory` under the App data directory. Cover it with focused
offline tests and a CC/OC regression subset. Then ask for authorization of
the Phase 4 exit trial. That trial is an authorized new conversation, a
continuation, then Stop or shutdown through the real adapter, with no CC/OC
regressions. It is **not** authorized by this review.

**Since the slice is not sound:** first do items 1–6 of §4, in the adapter,
send, and capture modules only. Correct the tests that currently lock in the
defects (the env equality, stop-before-spawn, and the registry
"prompt and owned cancel are supported"), and run only those focused files.
Then re-review before any bridge wiring.

## Decision

**Adjust first.** Storage, identity hashing, receipt refusal, and the bridge
refusals are sound and match the contract. The send slice is not ready to
build on. It never applies the pinned home at launch, it would let an
unqualified Grok child reach the `sane` CLI as `local`, and its Stop,
capture, and exit handling have defects that would make the Phase 4 exit
evidence untrustworthy. None of this is reachable over HTTP today, so there
is no reason to stop or revert. Fix §4 items 1–7, then continue.
