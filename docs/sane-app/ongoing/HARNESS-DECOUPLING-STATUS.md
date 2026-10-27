# Harness decoupling status after the local-main merge

Status date: 2026-10-27. Branch: `experiment/user-context-delivery`.
This is a working status report, not a new plan and not authorization to
implement Grok, migrate stores, or run native trials.

The decisions and the Grok sequence stay in
[HARNESS-DECOUPLING-PLAN.md](HARNESS-DECOUPLING-PLAN.md). This note records what
the merge actually brought in, what was adapted, and which CC/OC couplings are
still left.

## Baseline

| Commit | Role |
| --- | --- |
| `7a3f25a` | Checkpoint of Phases 1–3 before the merge |
| `6d5d9f0` | Local `main` tip that was merged. Checkout `/Users/beto/sane` was not fetched, reset, or modified |
| `bdafad7` | Merge commit. Parents are `7a3f25a` and `6d5d9f0` |
| `6168d57` | Focused tests and the reconciled plan section |

`6d5d9f0` is five commits after merge-base `dd87753`: UI/skills/naming,
verification-crew updates, a sync commit, browser pairing, and marimo fixes.
That is a local-main observation, not a remote freshness claim. Nothing was
pushed.

## What the merge brought in

Taken as committed, without a redesign:

- Host Chromium browser: workspace contexts, tabs, human/agent lease, CDP
  input, diagnostics, and the App WebSocket. This control plane does not
  select a harness implementation.
- Passive browser and resource pairing. A pair row is metadata. It does not
  start a tab, issue a grant, or submit a prompt.
- Device-local notebook/marimo iframe preview. It does not start a server or
  grant browser control.
- Verification-crew, worker-procedure, skill, and template prose, plus
  planning/execution document validation. In-progress Job Specs that still use
  the old Boundaries/Verification sections fail validation. Completed specs
  stay on placeholder checks. File bytes are not rewritten.
- First-submission session naming from the original user text, before role,
  science, or context expansion. Session and authority IDs are unchanged.

Auto-merged overlap kept both sides: the admission-recovery ledger, and main's
group page size plus checkout-preserving navigation.

## What the decoupling branch kept

The merge did not restore main's pre-extraction Claude spawn path.

- Selective context, exact outgoing-byte/source binding, immutable receipts,
  and no replay after uncertain native creation remain on the experiment path.
- Owner-bound Stop still targets the original local process despite
  launch-metadata drift. OpenCode cancellation stays pinned in the OpenCode
  adapter. Observer shutdown is not native cancellation.
- Conversation creation still admits native identity and ready state before
  owned context-message preparation. Ordinary chats, workers, and new handoff
  recipients share that sequence. Known handoff identities are not created
  again.
- The installer copy list is the union. `native-source-contract.ts` stayed.
  `native-browser.ts` and main's validation/context modules were added. The
  selected-runtime proof still refuses a global fallback.
- No Grok source-record, schema bump, adapter, or profile was added.

## Browser pairing and agent control

These features were built for Claude Code and OpenCode. That is not a missed
shared control plane. Three layers need to stay distinct.

### Already shared

`packages/sane-app/src/browser/` supervises Chromium, isolates a context per
workspace, and brokers human versus agent input. Grant admission, resource-link
restore, and the OpenCode `/native/browser` resolver use `validateHarness`,
`toNativeHarness`, and `toSessionHarness`. An unknown harness is refused. It is
not labeled as the other one.

A host handoff token with no caller is `403 browser-session-unverified`,
including when exactly one Control grant exists. Pair writes do not call
`setGrant`. Unpairing does not revoke a grant. The handoff bearer is published
only as `native-handoff.json`. The extra `browser-mcp.json` copy of that token
was not kept.

### Closed stored identity, not a control fallthrough

`BrowserPairSession.harness` is `"claude-code" | "opencode"`. Resource pairs
reuse that identity. The authority regex and native-ID check are Claude UUID
versus OpenCode `ses_`. The `opencode ? "oc" : "cc"` expression in
`browser-pair-contract.ts` runs only after that closed harness check, so it
encodes the stored record. It does not authorize an unknown harness.

A third harness cannot be linked until the stored-identity extension in the
plan exists. Widening this JSON in place would rewrite a stored CC/OC meaning.
Do not do that as a decoupling cleanup.

Pair metadata still uses `sessionHarness`, which defaults an omitted historical
harness to Claude Code. That default is not used to mint a credential or a
grant.

### Two native tool transports, on purpose

Claude gets a per-run stdio MCP server and a session credential, and only from
`ClaudeRunService.setupLaunch` for an explicit `claude-code` non-worker,
non-compact launch. Tool names are appended only to the synthetic Base allow
list. Pinned canonical permissions stay unchanged. Canonical launches may still
receive `--mcp-config` under the existing `bypassPermissions` argv. The grant,
not the allow list, is the control boundary.

OpenCode registers the same tool names in `opencode/plugins/sane/index.ts`,
calls `qualifyOpenCodeAppCaller`, and posts a caller with the handoff token.
There is no third transport, and an unqualified call does not fall through to
either one.

Grok needs its own transport qualification later. Unifying these launchers
would be the universal framework the plan rejected.

## Verification of this tree

Focused offline run recorded with `6168d57`: **65 tests, 316 assertions, 4
files, 0 failures**.

- `packages/sane-app/src/browser/browser-broker-auth.test.ts`
- `packages/sane-app/src/claude-run-service-context.test.ts`
- `packages/sane-app/src/native-runtime-selection.test.ts`
- `packages/sane-app/src/session-naming-submission.test.ts`

App `tsc --noEmit` adds no diagnostic from the integration. It still reports
the two existing `user-questions-service.ts:26` TS2739 errors and one
pre-existing `workstreams.test-utils.tsx:13` TS2353 (`approvals`), present on
both parents.

This is not a booted bridge, Chromium, native CLI, or full-suite result. The
broker test plants an in-memory grant and does not prove a successful
qualified-caller tool result.

## What is left

Do not treat every remaining Claude or OpenCode name as unfinished decoupling.
Three buckets are different work.

### 1. Leave native protocols native

These name a harness because the protocol is different. Keep them until a
third harness has its own adapter. Do not lift them into a shared manager.

- Claude stream-json launch, hooks, and settings versus OpenCode HTTP/session
  commands.
- Compaction evidence, context-usage reducers, and native subagent projection.
- OpenCode reply bindings and observer detachment.
- Code-share and user-question tool names, wrapper versus tool-call ID, and
  continuation grammar.
- Model, effort, and variant semantics.
- Claude UUID versus OpenCode `ses_` native IDs, where a closed check already
  happened and the branch only selects the matching ID shape.

`dispatchHarness` is still a two-arm switch because the registered set is
still two harnesses. Adding Grok means a third explicit arm, not a new
registry.

### 2. Replace authorization fallthroughs

These are the remaining decoupling defects. A value that is not OpenCode is
treated as Claude, or the reverse, without a prior closed check. An unknown
harness can be admitted, matched, or hashed as the other one.

`toNativeHarness` / `toSessionHarness` already exist for this. The replacement
is a call that throws, not a new framework. Historical omission may keep the
existing `sessionHarness` default only where that omission is already the
stored contract. New authorization must not use that default.

Closed on the shared conversation path. An unknown harness refuses, and the
existing Claude Code and OpenCode identities still match. Focused offline run:
**16 tests, 67 expect() calls, 3 files, 0 failures**.

- `bridge.ts`: branch admission, branch destination begin, both context-source
  checks, activation-journal admission, worker-child harness, and attach begin.
- `handoff.ts`: queued recipient identity.
- `execution-preparation-service.ts`: canonical-execution admission check.

Production sites still in `packages/sane-app/src/bridge.ts`:

| Approx. line | Site | Hazard |
| --- | --- | --- |
| 446 | `authorityCurrent` for retirement | Non-OpenCode reads `store.sources.cc` |
| 962 | `nativeHandoff` enqueue sender match | Non-OpenCode is compared as `cc` |
| 2402 | `codeShareSession` | Non-`cc` caller is OpenCode |
| 2625 | User-question form versus session | Non-`cc` form is OpenCode |
| 3807 | Question-delivery evidence source | Non-`cc` form is OpenCode |

Same class outside the bridge. Some of these run only after a closed
`["claude-code", "opencode"]` or `["cc", "oc"]` check, so they encode the
current union rather than admitting an unknown value. They still must not be
copied forward as the Grok branch.

- `history.ts` metadata authority regex. The harness allowlist is closed; the
  regex then treats anything else as `cc`.
- `session-retirement.ts` approval source lookup (`sources[opencode ? "oc" : "cc"]`). The identity parser above it is closed; this lookup is not.
- `session-run-preview.ts` authority regex.
- `pending-activation-journal.ts` authority regex, after a closed harness check.
- `prepared-input-codec.ts` native namespace selection, after a closed harness check.
- `pending-input-codec.ts` admission harness reconstruction. The native allowlist is closed; the reconstruction then treats anything else as OpenCode.
- `user-questions-delivery.ts` form harness mapping.
- `frontend/user-questions-client.ts` form/scope harness compare.

Test fixtures that build `sane-native-v1:${opencode ? "oc" : "cc"}` are not
production fallthroughs. Update them only when the production site they cover
changes.

Do not sweep native-specific `=== "claude-code"` checks that are inside an
adapter. One focused offline test per replaced check: unknown harness refuses,
and the two existing harnesses still match their current IDs.

### 3. Wait for the Grok storage decision

These are closed CC/OC formats. Replacing the ternary without a reviewed
extension would either reject current records or reidentify them.

- App source-record v1 and `store.sources.cc` / `store.sources.oc`.
- Repository schema v5 authority checks. Frozen v1–v5 definitions stay frozen.
- Authority ID algorithm `sane-native-v1:cc|oc:` and the existing hash inputs.
- Admission, receipt, and history native-ID bounds. They intentionally differ.
  Do not collapse them into one validator.
- Browser-pair and resource-pair JSON. Pairing metadata grants no control, and
  it also grants no Grok support.

The next concrete Grok step is still the bounded source/evidence contract and
the explicit storage-extension review in the plan. Do not start the Base
adapter, or implement source-record v2 / schema v6, in order to clean these
branches.

## Not in this leftover list

- No recurring historical-context reconstruction.
- No second owner registry.
- No universal permission engine or plugin framework.
- No browser-control authority derived from a pair row.
- No change to pinned CC/OC cancellation, local-process Stop, or
  admission-before-dispatch.
- Gemini remains research after the agreed Grok scope.

## Suggested next slice

Not the Grok adapter. The shared admission path no longer labels an unknown
harness as Claude or OpenCode, but Grok still has no source, evidence, hash,
or storage extension.

Write and review the bounded source/evidence contract and the explicit storage
extension in the plan. Do not implement source-record v2, schema v6, a profile,
or the Base adapter during that review.

The remaining bucket-2 sites are not a reason to delay that review. Retirement,
native handoff enqueue, code-share, and user questions are outside the first
Grok slice. Codec and history validators that already reject an unknown harness
before the ternary are closed-format encoding; change them only when the
storage extension says what a Grok record is. Do not copy those ternaries into
new Grok code.
