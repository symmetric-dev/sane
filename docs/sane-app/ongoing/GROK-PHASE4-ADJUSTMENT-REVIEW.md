# Grok Phase 4 adjustment review

Review date: 2026-10-27. Branch: `experiment/user-context-delivery`.
This follows up on `GROK-PHASE4-REVIEW.md`, which is not changed here. It
checks whether that review's required adjustments were made in the current
working tree on top of `eb6c2cf`. It does not authorize a live trial, a receipt
bump, a push, or Phase 5.

## How this review was done, and its limits

- **Static reading only.** Shell commands were refused in this session: the
  shell wrapper adds an environment export that needs approval, and nothing
  could approve it. So none of the focused tests ran, and neither did `tsc`
  or `git diff`.
- **The "71 pass, 0 fail" claim was not run.** Counting `test(` declarations
  across the eight named files gives 71: adapter 19, send 17, capture 12,
  harness 7, executable 6, storage 5, fallthrough 3, admission 2. So the
  count matches. Whether the tests pass is unverified.
- **Not done:** no grok process was run, PATH was not searched, the bridge was
  not booted, and `/Users/beto/sane` was not touched.
- **Files read:** the earlier review, `grok-adapter.ts`, `grok-send.ts`,
  `grok-capture.ts`, `admission.ts` (`beginGrokCreate`, `rejectGrokCreate`,
  `refuseGrokRepository`), the Grok descriptor in `harness-capabilities.ts`,
  `agent-profiles-contract.ts` `builtinProfiles`, `app-store.ts`
  `validateAgentProfiles`/`loadAgentProfiles`, the Grok-related parts of
  `app-config.ts`, the Grok-related lines of `bridge.ts`, and the relevant
  tests in `grok-send.test.ts` and `grok-adapter.test.ts`.
- **Not read in full:** the plan and evidence documents were not re-read
  beyond what the earlier review already summarises.

## 1. The seven adjustments: present, incomplete, or wrong

| # | Adjustment | Verdict |
| --- | --- | --- |
| 1 | Child env is the pinned `GROK_HOME` plus the trial isolation flags, with no PATH, HOME, or caller envelope. Provenance choice (a). | **Present for env.** **Incomplete for binding the pin** (see 1b). |
| 2 | Wait for close, record the signal, timeout kills only the child. A missing executable is an eligibility refusal. | **Mostly present.** The timeout path and the ordering of the executable check are incomplete. |
| 3 | Stop before spawn does not begin or spawn. After any kill, the session is blocked. | **Present only on the test path.** **Wrong in production** (see 3a). The block is not durable (see 3b). |
| 4 | One capture file per App session. A failed save blocks the session. | **File: present.** **Block: in memory only** (see 3b). |
| 5 | A repository workspace is refused. | **Present.** |
| 6 | Registry `prompt` and `cancelOwnedRun` are unsupported. `base:gk` is hidden on a new seed. Existing `agents.json` is not rewritten. | **Present.** |
| 7 | The send route stays closed, prepared admission refuses Grok, no receipt bump, no live trial. | **Present.** |

### 1. Env and provenance

- **`grok-adapter.ts` `childEnv(homeRoot)`.** It returns exactly:
  - `GROK_HOME`
  - `GROK_MEMORY=0`
  - `GROK_MANAGED_MCPS_ENABLED=false`
  - `GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED=false`
  - all ten `GROK_{CLAUDE,CURSOR}_{AGENTS,RULES,HOOKS,MCPS,SKILLS}_ENABLED=false`

  This matches the trial overrides in
  `experiments/user-owned-context/grok.ts:31-32`.
- **No forwarding.** `PATH`, `HOME`, `SANE_*`, and `OPENCODE_*` are not
  forwarded. There is no `env` option left to override them.
- **`defaultSpawn`** passes `env` explicitly, so the child does not inherit
  `process.env`.
- **Comment fixed.** The inverted comment is gone. The new one records
  provenance choice (a).
- **Test.** `grok-adapter.test.ts` "child env is the isolation set and the
  pinned home…" now asserts the exact key set, and that `PATH`, `HOME`, and an
  injected `GROK_HOME` are absent.

**1a. Residual risk in choice (a), recorded rather than called a defect.**
Leaving `PATH` unset is not the same as leaving `sane` out of reach:

- With no `PATH`, libc `execvp` falls back to a compiled default (on macOS,
  `/usr/bin:/bin`).
- A POSIX shell started by the child sets its own default `PATH`. Bash's
  default normally includes `/usr/local/bin`.

Choice (a) is sound only if `sane` is not installed in those default
directories. This review did not check where `sane` is installed. The absence
of a caller envelope still means `local` in `cli-command.ts`. So `--deny '*'`,
the kill after a tool-use event, and that install location are the whole
barrier.

**1a, liveness.** The trial passed the inherited `PATH` and `HOME`. If the
`grok` executable is a script with a `#!/usr/bin/env node` (or `bun`) shebang,
`env` will not find the interpreter without `PATH`, and the turn exits at once
(exit 127, or similar). This is safe, but the Phase 4 exit trial could fail for
this reason alone.

**1b. Incomplete: a continuation is not bound to the identity it resumes.**
`grok-send.ts` `requirePinnedHome` re-normalizes the descriptor the caller
passed in, and checks it only against the `authorityId` from that same
request.

- **New turns are protected.** `beginGrokCreate` also checks the stored
  sources v2 `gk` pin.
- **A continuation is checked against nothing else.** It is not compared with
  the admission's `authorityId`, `journal.turns[0].authorityId`, or the stored
  pin.
- **The journal does not catch it.** `grok-capture.ts` `refuseConflict` does
  not compare `authorityId`. So a capture journal can hold two different
  authorities for one native session.

If the `gk` pin is republished to another home, `--resume <uuid>` runs under
a different `GROK_HOME`. The earlier review asked for exactly this check:
"refuse if the result is not equal to the admission's `authorityId`".

Earlier bug 11 also remains: `app-config.ts` `publishGrokConfig` still writes
`native.grok.homeRoot`, and it is never compared with the pin. In practice,
the send path uses the pin, which is right. But the config field is now a
dead second record.

### 2. Lifecycle

**Present:**

- `bindChild` attaches `error` before the pid check, and swallows
  `error` events that arrive before a pid is confirmed.
- `awaitClose` settles on `close`. `exit` only records the code and signal.
- `exitSignal` is on `GrokTurnObservation`.
- `DEFAULT_TIMEOUT_MS = 180_000`.
- `killSpawned` targets only the owned child.
- `assertExecutableFile` uses `stat` and `access(X_OK)` on the absolute path,
  and refuses with `grok-eligibility-refused`.
- A spawn with no pid, or a synchronous ENOENT/EACCES, is classified as
  eligibility, not spawn-uncertain.
- `runId` is a random UUID and `createdAt` is the current time. Prompt files
  are named `<runId>.<nativeSessionId>.<serial>.prompt.txt` and written
  with `wx`.

Earlier bugs 5, 6, 8, and 9 are addressed.

**Incomplete:**

- **The timeout does not wait for close.** The `setTimeout` handler calls
  `onTimeout()`, which sends SIGTERM, and then resolves at once. For a real
  child, this means:
  - `exitCode` and `exitSignal` are still `null` when the observation and
    capture are taken.
  - Late stdout misses the capture.
  - When `stdoutPath` or `stderrPath` are used, the owned streams end before
    those late writes, so earlier bug 5 comes back on this path.

  There is also no SIGKILL escalation, so a child that ignores SIGTERM keeps
  running after the turn resolves. The fake child in the tests emits `exit`
  and `close` synchronously from `kill()`, so the tests cannot see any of
  this.
- **The executable check still runs after admission.** It is inside
  `execute`, which `runGrokTurn` calls after `beginGrokCreate`. The earlier
  review asked for the check before admission. As built, a missing executable
  on a first turn:
  1. writes an `identity_known` row;
  2. rejects that row through `rejectGrokCreate`;
  3. blocks the session in memory.

  The App session id cannot be used again, because `beginGrokCreate` refuses a
  duplicate session id. The code is correct, but a configuration error costs
  the conversation. The same is true when the prompt directory is missing or
  the prompt file write fails.
- **The send tests never run the real check.** `runGrokTurn` sets
  `executableReady: () => {}` whenever a spawn is injected, and every send
  test injects one.

### 3. Stop and blocking

**3a. Wrong in production: stop is lost between creating the adapter and
spawning.**

- **What is right.** `runGrokTurn` checks `stopRequested` before
  `beginGrokCreate`, after it, after re-pinning, and after creating the
  adapter. The "stop before spawn" and "stop during begin" tests are correct.
- **The window.** After those checks, `adapter.execute` still awaits
  `assertExecutableFile` and writes the prompt file before it spawns. The only
  guard for that window is `guardSpawn`, and `guardSpawn` wraps
  `input.spawn` only:
  `...(input.spawn ? { spawn: guardSpawn(input.spawn), ... } : {})`.
- **What happens in production.** There is no injected spawn, so
  `defaultSpawn` runs unguarded. A `stop()` in that window:
  1. reaches `stopGrokDispatch`;
  2. finds no child, and returns `grok-stop-refused` with `not-attempted`;
  3. does not set `session.blocked`.

  The child then spawns and runs to completion. This is earlier bug 1,
  narrowed to a smaller window but still there.
- **A second problem on the test path.** When the guard does fire, it fakes
  an `ENOENT`. So the rejected admission records "Grok executable is missing
  or not executable" as the reason, not "stop requested".

**3b. Incomplete: "blocked" is durable only through the capture journal.**
`createGrokSendSession` rebuilds `blocked` only from
`journal.turns.some(t => t.nativeCancellation === "unproven")`.

- **What reloads correctly.** Stop, timeout, and tool-boundary on a turn whose
  capture was saved do come back blocked. The test "a reloaded session stays
  blocked after an unproven cancel" covers this.
- **What does not.** In each case below, the block is in memory only:
  - **Capture save fails** (adjustment 4). The turn is in `session.journal`
    in memory but not on disk.
  - **Spawn-uncertain or an `error` after the pid.** There is no capture,
    because the submission is not `submitted`.
  - **Stop or refusal after admission.** The session is blocked in memory
    only.
- **Effect after a restart.** On a first turn, `beginGrokCreate`'s
  duplicate-session check still refuses a new turn, so this fails safe. On a
  later turn, the reloaded session has `blocked: false` and the stored
  `nativeSessionId`. A `continuation` is then allowed to `--resume` after a
  turn whose evidence was lost, or whose spawn was uncertain. This is the
  "no automatic retry or replay" gap that the earlier review warned about.

### 4. Capture

**Present:**

- `grok-capture.ts` `grokCaptureFilename` gives
  `grok-capture.<appSessionId>.json`.
- `persistGrokCaptureJournal` decodes, then refuses mixed App session ids. It
  reloads the file on disk and runs `assertAppendOnly` before the temp-file
  rename.
- `createGrokSendSession` loads the existing file, and restores
  `nativeSessionId` and `turnIndex` from it.
- `persistSubmitted` sets `captureAttempted` before writing, so the second
  call in `catch` cannot hit "duplicate turn index". The original error is
  kept.

Earlier bugs 3 and 4 are addressed. The exception is that the block is not
durable (3b).

Each turn still rewrites every earlier turn's stdout, so cost grows
quadratically. That is acceptable for now.

### 5. Repository refusal

**Present.** `admission.ts` `beginGrokCreate` throws
`409 grok-repository-refused` when `workspace.kind === "repository"`, and it
does so before `persist`. The doc comment says it must be called inside the
bridge admission gate. `grok-admission.test.ts` covers both branches.

### 6. Advertisement and profile

**Present:**

- In `harness-capabilities.ts`, Grok `prompt` and `cancelOwnedRun` are
  `unsupported("The bridge cannot perform …")`.
- `builtinProfiles` seeds `base:gk` with `hidden: true`.
- `validateAgentProfiles` drops `base:gk` from the required bases.
- `loadAgentProfiles` leaves `base:gk` out of `missing`, so an existing
  `agents.json` is neither extended nor rewritten for Grok.
- `canAssign` refuses hidden profiles for new conversations.
- `grok-harness.test.ts` was updated.

There is one small gap: a local `agents.json` that the committed `eb6c2cf`
code already loaded may hold a visible `base:gk`. By design, it is not
re-hidden. Nothing was pushed, so this affects local data only.

### 7. Closed route

**Present:**

- Nothing outside tests calls `runGrokTurn`, `beginGrokCreate`, or
  `rejectGrokCreate`.
- `bridge.ts` refuses Grok prepared admission at `:2123`, `:4201`, `:4223`,
  and `:4967`. Every `dispatchHarness` grok arm throws 501.
- `app-admission-contract.ts` `checkSourceFields` still accepts only
  `claude-code` and `opencode`, so receipts were not bumped.

## 2. New defects introduced by the adjustments

1. **Type error in the bridge registration.** `GrokDispatchAdapterOptions`
   now declares `homeRoot: string` as required. `bridge.ts:1914` still calls
   `createGrokDispatchAdapter({ executable: configuredGrokExecutable() })` with
   no `homeRoot`.
   - **Typecheck:** `tsc --noEmit` (the package `typecheck` script) should
     fail with a missing-property error. Bun's test runner does not typecheck,
     which fits "71 pass". This was found by reading; `tsc` was not run.
   - **Runtime:** harmless, because readiness and `execute` refuse a missing
     home.
2. **Spawn-uncertain is recorded as `rejected`.** In the `catch` branch of
   `runGrokTurn`, a `GrokDispatchRefusal("grok-spawn-uncertain")` from a
   spawn throw that is not about availability leaves `submission: "unknown"`.
   That falls into `else if (began) abandon(...)`, which calls
   `rejectGrokCreate`. The admission then says "rejected" for a native create
   that may have happened. The doc comment on `rejectGrokCreate` limits it to
   creates that "did not reach a submitted spawn". An uncertain spawn is not
   that case. It should stay `identity_known`, or move to an explicit
   uncertain state, and be latched.
3. **The stop guard exists only when a spawn is injected** (3a above). This is
   new code that makes the test suite pass while the production path is
   unguarded.
4. **The timeout resolves before close** (§1, item 2). This is new code, and
   it reintroduces the pre-close read and the end-before-write that the close
   change fixed on the normal path.
5. **The send tests skip the executable check.** Injecting `spawn` also
   injects `executableReady: () => {}`, so no send test runs
   `assertExecutableFile`. This is a coverage gap, not a behaviour change.
6. **Minor.** The guard's fake `ENOENT` makes a stop look like a missing
   executable in the rejected admission's `error`. `grok-send.test.ts`
   hard-codes `TEMP = "/private/var/folders/6v/…/T/opencode"`, a path that
   exists only on one machine. Prompt files are never removed after a turn.

## 3. Ready to wire through the bridge?

**No. Adjust first, but the remaining work is small.**

Items 5, 6, and 7 are done. The env, close, signal, executable
classification, capture file, and error preservation are done. The
remaining problems sit in the exact places that wiring would expose:

- Stop is the Phase 4 exit action, and in production it is lost in the
  pre-spawn window (3a).
- A restart can drop a block and allow `--resume` after lost or uncertain
  evidence (3b).
- A continuation is not bound to the authority it resumes (1b).
- An uncertain spawn is recorded as `rejected` (defect 2).
- The bridge file does not typecheck (defect 1).

Wiring now would put each of these on a live path.

## 4. Single best next step

Make one adjustment pass that stays inside `grok-send.ts`, `grok-adapter.ts`,
`grok-capture.ts`, and the one `bridge.ts` registration line. Do not add send
wiring.

1. **Guard every spawn.** Apply `guardSpawn` (or pass a stop check into the
   adapter) on the default spawn too, and give the not-submitted result its
   own stop reason.
2. **Bind a continuation's authority.** Refuse it unless its normalized
   `authorityId` equals `journal.turns[0].authorityId` and the stored `gk`
   pin.
3. **Make "blocked" durable outside the capture write.** For example, write a
   small per-session block marker before any kill or on any non-clean outcome,
   and read it in `createGrokSendSession`. Never `rejectGrokCreate` on
   `submission: "unknown"`.
4. **Fix the timeout.** It should wait for `close` for a bounded grace period
   after SIGTERM, then send SIGKILL to the same pid, and record the code and
   signal before it resolves.
5. **Move the executable check and prompt-file write before
   `beginGrokCreate`**, so that a configuration error does not use up the
   session.
6. **Pass `homeRoot` at `bridge.ts:1914`, or make the bridge registration
   explicitly home-less.** Then run `tsc --noEmit` for `sane-app`.

Add focused tests only when asked (per AGENTS.md). Run only the eight Grok
files and the typecheck. Then re-review.

This review does not authorize a live trial, a receipt bump, a push, or
Phase 5. The Phase 4 exit is still an authorized new conversation, then a
continuation, then Stop or shutdown through the real adapter, with no CC/OC
regressions. That trial is not authorized here.

## Decision

**Adjust first.**
