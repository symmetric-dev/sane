# Tests audit — Option A (complete hook removal, user-composed prompt). 2026-10-14
Scope: context-delivery coverage only. Verdicts: REWRITE = pins hook/injection mechanics; KEEP = validation/binding/identity survives; DELETE = obsolete with no hooks/storage entry.

## claude-run-service.test.ts (978 lines)
- `canonical CC authored parent role…once…` (L9) — role text exactly once in `.canonical-context.md`, absent from `--agents` JSON + segment sha. → REWRITE (~17 lines)
- `canonical CC {assistant,worker}×{new,resume,upgrade,compact} pins static bytes…` (L28, 8 tests) — `--append-system-prompt-file` bytes, snapshot flag, `session-context.ts` in UserPromptSubmit, `.sane-session.md` bytes, receipts `prepared/configured/hook-accepted` + hashes. → REWRITE (~24 lines)
- `canonical CC persisted upgrade disables stale snapshots…` (L53, 2 tests) — snapshot `off` on later resume/compaction. → REWRITE (~13 lines)
- `canonical CC {missing,mismatched,foreign-session} hook never claims…` (L67, 3 tests) — hook-response fidelity fail-closed. → DELETE (~10 lines, no hook to accept)
- `canonical CC {foreign-binding,dynamic-change,cancelled} cannot spawn…` (L79, 3 tests) — binding/currency/cancel withhold before `configured`. → KEEP (~16 lines, validation survives)
- `ordinary Base CC never consults canonical provider…` (L95) — base isolation + no standing files. → REWRITE (~10 lines, 2nd half becomes no-composed-prompt)
- `canonical CC cannot spawn without trusted provider validation` (L106) — unvalidated provider withholds. → KEEP (~7 lines)
- `successful owned launch preserves journal order…` (L199) — journal/flags + `hookEvents` keys + `forward.ts Stop` command. → REWRITE (~15 lines, hook-settings half only)
- `framework indexed supervision requires exact SessionStart delivery…` (L505, 2 tests) + `required framework cannot complete…` (L516) — SessionStart hook_response gates completion. → DELETE (~16 lines)
- `framework rejection is captured as its own exit-zero…` (L560) — `framework-rejected` cause. → REWRITE (~5 lines, re-point to composed-prompt check)
- `terminal DTO setter cannot relabel runtime {5 modes}…` (L765, 5 tests) — settlement proof incl. framework arm. → KEEP (~18 lines)
- `fresh source validation after asynchronous {11 stages}…` (L835, 11 tests) — stages incl. `framework-file/session-file/session-context/settings`. → REWRITE (~19 lines, drop hook/file stages, keep pins)
- Hook-plumbing group: `hook authentication…` (L327), `hook journal errors…` (L345), `hook secret…` (L353), `stream drainage…hook secret…` (L432), `hook credentials cannot be borrowed…` (L961), `legacy new-session hooks…` (L970) — ingestHook auth/secret/lifetime. → DELETE (~65 lines, 6 tests)
- All others (durable intent, spawn/admission, streams, result identity, termination, local proof/idle, source pins) — no delivery pin. → KEEP (untouched, ~750 lines)

## opencode-run-service.test.ts (722 lines)
- `canonical OC authored parent role occurs once…` (L9) — `deliverContextEntry` stored text + `configureCanonicalExecution` excludes role. → REWRITE (~16 lines)
- `canonical OC cannot dispatch a provider missing trusted…` (L26) — unvalidated withholds. → KEEP (~8 lines)
- `canonical OC {assistant,worker}×{new,resume,compact} journals exact storage receipt…` (L36, 6 tests) — stored=`standing+\n\n+dynamic`, `prepared/stored-readback` + hashes, readback-before-prompt. → REWRITE (~23 lines)
- `canonical OC {5 faults} withholds prompt…` (L60, 5 tests) — foreign-binding/dynamic-change/cancelled → KEEP (validation survives); readback-mismatch/lost-write-ack → DELETE (storage readback gone). (~21 lines split 13/8)
- `ordinary Base OC never requests canonical content` (L81) — no provider call, no mutation, no receipt. → KEEP (~9 lines)
- `acknowledged creation framework delivery…(compact=…)` (L436, 2 tests) — `takeFrameworkDelivery` + `framework-delivered` journal before launch. → REWRITE (~16 lines, becomes composed-prompt journal)
- All others (retry/recovery, cancellation, submission evidence, prompt order, compact, interrupts) — no delivery pin. → KEEP (untouched, ~600 lines)

## Other tests referencing delivery keywords
- `branch-context.test.ts` (63 lines, 4 tests): `already-canonical native fork reads inherited entry…` (L22) pins GET-only `deliverContextEntry` + `staticHash/payloadHash` equality → REWRITE (~18 lines); other 3 (migration guidance, standing policy, branch dynamics) → KEEP (pure `renderContextDelivery`, no channel).
- `native-context-entry.test.ts` (51 lines, 5 tests): exact-readback idempotence, `{mismatch,lostAck,duplicate} not a verified receipt`, cancellation-after-read — all pin `deliverContextEntry` GET/PUT/GET storage API → DELETE (API removed under A).
- `opencode-native-queue.test.ts`: `unassociated unknown policy…cannot select, deliver startup…` (L670, 4 tests) pins `deliverSaneSession` never called → REWRITE (~10 lines, withhold survives as no-composed-session); policy-changed/context-absence asserts → KEEP.
- `opencode-completion-service.test.ts:36`, `opencode-native-queue.test.ts:37-38` stub `takeFrameworkDelivery`/`saneSession` only — no pin → KEEP, no action.

## Totals (delivery-pinning subset; rest of both files untouched KEEP)
- REWRITE: ~39 tests, ~190 lines (CC ~25/≈103, OC 9/≈55, other 5/≈28)
- DELETE: ~19 tests, ~150 lines (CC ~12/≈91, OC 2/≈8, native-entry 5/51)
- KEEP (delivery-adjacent, survives as-is or trivial): ~17 tests, ~100 lines (binding/validator/settlement/pure-rendering)
