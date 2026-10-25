# Context engine: focused behavioral verification

Status: **fix verified: 361 passed, 0 failed** across four files (1,143
assertions). Scoped TypeScript checking passed with zero diagnostics. The initial
run found one defect through two failing tests; that evidence is retained below.
The subsequent explicitly authorized fix does not activate the engine or replace
current CC/OC delivery.

## Work split

| Workstream | Test ownership | Main guarantees |
| --- | --- | --- |
| Composition | `packages/sane-app/src/context-message.test.ts` | Activation/selection, exact body/UTF-8 bytes, immutable output, strict decoding, independent source trust |
| Preparation | `packages/sane-app/src/context-message-engine.test.ts`, `packages/sane-app/src/canonical-activation-validation.test.ts` | Ownership/source/cancellation checks, independent refresh, ordinary isolation, execution-only policy validation |
| Evidence | `packages/sane-app/src/context-message-evidence.test.ts` | Strict records, existing dispatch lifecycle, synchronous durability contract, per-message restart/branch facts |

The test writers own distinct files. Production modules are read-only during test
implementation; a failing regression is retained and reviewed rather than turning
an unsafe behavior into the expected result.

## Verification method

- Use Bun's existing test framework and deterministic local fixtures/callbacks.
  No native adapter, browser, app, model provider, or paid API is involved.
- Exercise the existing dispatch lifecycle through the evidence decorator rather
  than inventing a second delivery state machine in test scaffolding.
- Use controlled asynchronous boundaries instead of timing sleeps for freshness
  and cancellation scenarios.
- Run explicitly named new test files only, followed by a scoped TypeScript check
  of those files, their production entry points, and imported dependencies.
- The worktree has no installed dependencies. A temporary compiler configuration
  resolves `sane-core/*` to this worktree's sources. Static checking reads cached
  external declarations from `/Users/beto/sane`; no dependency installation,
  repository compiler configuration change, or `node_modules` symlink is required.

## Initial results, before the fix

| Test file | Passed | Failed | Assertions |
| --- | ---: | ---: | ---: |
| `context-message.test.ts` | 78 | 0 | 430 |
| `context-message-engine.test.ts` | 82 | 0 | 147 |
| `canonical-activation-validation.test.ts` | 47 | 0 | 76 |
| `context-message-evidence.test.ts` | 151 | 2 | 456 |
| **Total** | **358** | **2** | **1,109** |

All files are under `packages/sane-app/src/`. The parent combined run reproduced
the same two evidence failures after reviewing all four files. No tests are
skipped, disabled, marked TODO, or converted to expected failures. Bun exits 1.

Parent review corrected two test-only readonly/mutable type mismatches at the old
renderer comparison boundary by copying the synthetic package, and corrected
evidence test fixture types (mutable overrides and typed fact cases). No behavior
assertions were weakened. The initial scoped check of all four tests plus the five
production entry files reports zero diagnostics.

Paired validation tests exercise the dedicated full paired validator with injected
loaders. They do not runtime-import the old `user-input-preparation.ts` wrapper;
that wrapper is included in scoped static checking. Synthetic loader results model
already-verified stored bytes, not context-store filesystem integrity guarantees.

At the initial test delivery, the five foundation production files matched their
pre-test SHA-256 baseline. No production code changed in that test-only follow-up.
The separately authorized fix below changes just the evidence decorator.
Previously captured Antigravity
(171 files) and Grok (163 files) manifests also matched when checked in this run.

### Confirmed defect (initial run): uncertified refusal crosses the decorator boundary

Two cases in `context-message-evidence.test.ts` failed in the initial run:

- `actual refusal-class failure fails closed unless original intent certifies`
- `persist-before refusal-class failure fails closed unless original intent certifies`

Both throw a `DispatchPreNativeRefusal` outside the original synchronous owner
intent hook: once in `readActualSubmission`, once in before-native persistence.
The decorator correctly invokes its failure callback, but then rethrows the exact
refusal-class exception (`context-message-evidence.ts:217,237–244`). The enclosing
existing lifecycle sees that class emerging from its decorated `beforeNative`
hook and treats it as a certified local refusal (`dispatch-evidence.ts:64–70`).

Observed versus required result:

```text
                                   observed    required
outer recognizes certified refusal  true        false
outer failure callback called       false       true
decorator failure callback called   true        true
```

This is a classification/composition defect in the inactive engine, not evidence
that current production dispatch has regressed or that a native resend occurred.
The real certified original-hook refusal, normal failures, asynchronous-hook
rejection, and outcome-stage failures pass their respective tests.

**Fix direction identified by the initial run:** keep exact refusal propagation only for the original
synchronous intent hook. Prevent refusal-class exceptions from submission reads,
metadata checks, or persistence from being certified by the enclosing lifecycle.
A narrow option is to wrap those uncertified failures in an ordinary error while
preserving the original as `cause`; ordinary errors and genuine certified refusals
can retain their identity. That option also requires updating the regression
assertions to check original-cause preservation instead of demanding the very
same refusal-class object at those noncertifying boundaries. It must not relax
the failing certification/failure-health guarantees. The next section records the
separately authorized fix and rerun.

### Fix applied and verified

`context-message-evidence.ts` now wraps refusal-class errors at the before-native
boundary unless they are the exact synchronous refusal from the original owner
intent hook. The wrapper is an ordinary `Error`, retains the original as `cause`,
and reaches both decorator and enclosing lifecycle failure callbacks. Other
ordinary errors, outcome-stage errors, and genuinely certified original intent
refusals retain their identities.

The two existing failing cases retain the refusal-class fault injections and
strict no-certification/failure-callback checks. Their error-identity assertions
now require the wrapper and exact original `cause` only at the two noncertifying
sites. A further regression checks that even a failure callback throwing another
refusal cannot replace the wrapper or grant certification.

| Test file | Passed | Failed | Assertions |
| --- | ---: | ---: | ---: |
| `context-message.test.ts` | 78 | 0 | 430 |
| `context-message-engine.test.ts` | 82 | 0 | 147 |
| `canonical-activation-validation.test.ts` | 47 | 0 | 76 |
| `context-message-evidence.test.ts` | 154 | 0 | 490 |
| **Total** | **361** | **0** | **1,143** |

The combined rerun exits 0. The scoped TypeScript check of the same nine entry
files has zero diagnostics. A read-only audit subagent found no actionable issues
in the fix or revised regression assertions. Comparison with the original
production baseline confirms that only `context-message-evidence.ts` changed;
the other four production entry files remain byte-identical.

New raw verification output and JUnit are retained separately under
`/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-fix.gSwbvm/`.
The original failing-run outputs remain unchanged in the earlier directory below.

### Reproduction

With workspace dependencies installed, Bun can resolve `sane-core` normally. In
this dependency-free worktree, the temporary configuration at the path below has
`compilerOptions.baseUrl` set to the worktree root and
`paths: { "sane-core/*": ["packages/sane-core/src/*"] }`.

```sh
bun test \
  --tsconfig-override /private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-tests.lc8peR/tsconfig.json \
  ./packages/sane-app/src/context-message.test.ts \
  ./packages/sane-app/src/context-message-engine.test.ts \
  ./packages/sane-app/src/canonical-activation-validation.test.ts \
  ./packages/sane-app/src/context-message-evidence.test.ts \
  --timeout 10000
```

Parent verification used the existing offline runner's environment sanitization
helper, an explicit four-file allowlist, and JUnit capture. Bun version: 1.4.4.
Raw stdout/stderr, JUnit, command/source-baseline summary, and the scoped compiler
helper are in the same temporary directory. An initial launcher attempt put the
compiler flag before the `test` subcommand and failed without executing tests;
the corrected final command above ran the full focused selection.

## What passing these tests will not establish

- Actual durable journal writes/fsync, atomicity, or crash recovery: the production
  owner-controlled persistence implementation is not connected yet.
- End-to-end CC/OC delivery, native acceptance, permissions/operational-hook
  integration, background-input transport, or actual native branch-prefix proof.
- Real model adherence, compaction preservation, or long-history reliability.
- Grok/Gemini production support. Generic engine bindings are not native adapters.
- Whole-dispatch performance. Ordinary engine dependency isolation is narrower
  than proving zero context reads across a future complete production dispatch.
- Full-app typechecking or regression-suite coverage; checks remain focused.
