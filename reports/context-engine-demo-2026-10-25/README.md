# Mock engine-path demonstration — verified

Implemented and run with subagents. This is **not App integration, native harness
acceptance, model behavior, or compaction/crash recovery proof**. Production engine
files and current CC/OC delivery are unchanged by this demonstration.

Start with [the walkthrough report](REPORT.md), or open [the standalone HTML
report](REPORT.html) for authored text and outgoing transport side by side.

## Result

| Scenario | Recovered fact | Scripted mock effects | Context loads during preparation/dispatch |
| --- | --- | ---: | ---: |
| Activation | accepted — simulated only | 1 | 11 |
| Ordinary continuation | accepted — simulated only | 1 | **0** |
| Selected Session root A → B update | accepted — simulated only | 1 | 4 |
| Stale source | no-evidence — not a freshness claim | 0 | 6 |
| Genuine original owner refusal | withheld | 0 | 11 |
| Uncertified refusal-class persistence fault | unknown, partial coverage | 0 | 11 |
| Attempt with unknown outcome | attempt-unresolved | 1 | 11 |
| Torn journal variant | unknown, partial coverage | replay does not send | — |
| Missing journal variant | unknown, partial coverage | replay does not send | — |

Ordinary continuation also measured **2 real execution loads and 4 durable pairing
checks**. Counts cover preparation and dispatch, including indirect loader calls.
Fresh replay independently reads pinned context bytes for integrity auditing;
those audit reads are separate from the ordinary zero-context-load dispatch path.

Both the driver's fresh replay subprocess and an additional independent replay
exited 0, with identical fixture file content/mode inventories before and after.
The unknown-outcome case deliberately performs one mock effect, then reports an
unknown result; it is not a killed native process. Replay performs no retries.

## What is exercised

Real authored source → real pinned context/execution stores → independent trusted
preparation/currentness checks → existing dispatch registry and owner lifecycle →
decorated synchronous evidence hooks → file/directory fsync and integrity-bound
checkpoint → fresh-process strict decoding and restart projection.

Only the adapter, recipient effect, native identity, readiness/settlement, and
acceptance are simulated. Exactly one dispatch lifecycle is created per owner.
There is no second activation ledger, retry machine, App registration, native CLI,
model provider, credential use, or browser invocation.

The fixture is a separate disposable Git checkout and data root. It is not another
source worktree at HEAD, which would omit the uncommitted engine. Explicit fixture
outputs inside the source checkout or through symlink aliases are rejected before
creation. The existing source tree/context/skills are read-only inputs.

## Checks and audit

- **422 focused tests passed**, 0 failed, 1,384 assertions across 10 files:
  the existing 361 foundation tests plus 61 experiment tests.
- Scoped TypeScript check: **0 diagnostics across 23 entry files**, using cached
  external declarations and worktree workspace sources. Not a full-App typecheck.
- Five production foundation files match their pre-demo SHA-256 baseline.
- Journal tests cover file/directory fsync failures, sticky partial coverage,
  exact checkpoint binding, and source-preserving corrupt replay copies.
- An audit found the output-confinement gap; the fix and synthetic alias/path
  regression were included before the final run. Final read-only audit: no findings.
- No exhaustive repository suite, live model/native integration, or browser check.

An initial combined run caught an experiment-only expectation mismatch: replay
expected zero effects for an unresolved attempt while the scenario explicitly
performed one effect before its unknown outcome. The final check requires that
single scripted effect, its earlier durable intent, and an unresolved/no-resend
projection. This changed no production engine behavior. Initial output is retained
in `initial.stdout.log` and `initial-command.json`; its full fixture remains separate.

## Reproduce

From the repository root:

```sh
bun --tsconfig-override experiments/context-engine-demo/tsconfig.json \
  experiments/context-engine-demo/cli.ts run
```

For the retained run's read-only replay:

```sh
bun --tsconfig-override experiments/context-engine-demo/tsconfig.json \
  experiments/context-engine-demo/cli.ts replay \
  --manifest /private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/run.json
```

See [experiment instructions](../../experiments/context-engine-demo/README.md)
for the complete focused-test command. No dependency installation or application
compiler-config change is needed; workspace aliases are experiment-local.

## Evidence files

- `run-manifest.json`: captured scenario instrumentation; root still points at the
  original retained fixture. Do not treat this copy as a relocated replay root.
- `replay.json`: recovered facts, exact message bodies/transport/provenance, checks.
- `verification.json`: driver's fresh-process read-only inventory and command.
- `independent-replay.json`: second fresh read-only replay and matching inventories.
- `checks.json`: exact focused test/compiler commands, exit statuses, source hashes,
  and unchanged foundation baseline result.
- `tests.*.log`, `tests.junit.xml`, `typecheck.*.log`: raw focused verification.
- `command.json`, `stdout.log`, `stderr.log`: final demo invocation and output.

The complete fixture, pins, owner journals, initial run, and temporary verification
helpers remain under:
`/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/`.
These are experiment-owned paths; no broad cleanup or source reset was performed.

## Next boundary

This validates the engine pieces together. It does not complete trusted bridge
selection, production owner-journal wiring, prepared/queued codec correction,
old injector/ack retirement, CC live-input integration, or actual native proof.
Those remain deliberate App-integration work rather than additional demo features.
