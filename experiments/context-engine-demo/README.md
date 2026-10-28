# Mock context-engine demonstrator

An experiment-only engine-path walkthrough. **Not full-App integration, native
harness acceptance, model retention, or a production delivery switch.**

## Run

From the repository root:

```sh
bun --tsconfig-override experiments/context-engine-demo/tsconfig.json \
  experiments/context-engine-demo/cli.ts run
```

The command creates a new disposable fixture repository and separate pinned/data/
journal directories under the approved temporary root. No existing App/project
state is used. It prints the fixture path and writes `REPORT.md`, `REPORT.html`,
`run.json`, `replay.json`, and `verification.json` there. Nothing is deleted
automatically. An explicit `--output /absolute/new-directory` is also supported;
an existing directory is refused rather than overwritten.
Explicit output must also be outside the source checkout; source descendants and
symlink aliases are rejected before creating fixture files.

The local `tsconfig.json` only resolves workspace imports for this experiment;
it changes neither production compiler configuration nor installed dependencies.
No dependencies, native CLIs, credentials, model providers, or browser are needed.

## Read-only replay

```sh
bun --tsconfig-override experiments/context-engine-demo/tsconfig.json \
  experiments/context-engine-demo/cli.ts replay \
  --manifest /absolute/path/from/run/run.json
```

Add `--json` or `--html` to print the corresponding format to stdout. Replay does
not start fixture/scenario code, submit anything, repair logs, or write reports.
The initial `run` command launches this replay in a **fresh process** and verifies
that the fixture file contents/modes are unchanged before writing report outputs.

## Real versus simulated

**Real:** pinned package/execution stores, selective composition, explicit bootstrap
validation, execution-policy loading, the existing dispatch registry/owner
lifecycle, strict submission/evidence codecs, synchronous durable local journal
writes, restart projections, and fresh-process decoding.

**Simulated:** the `mock-context-demo` adapter, recipient effects, native identity,
readiness/settlement, and acceptance. A recorded `accepted` fact in this demo means
**simulated harness acceptance**, not a real model or native runtime acknowledgment.

The experiment owns one journal authority and uses the existing dispatch lifecycle;
it does not introduce another production activation ledger, acknowledgment map,
retry scheduler, or runtime mode. No App imports this directory.

## Walkthrough

1. Bootstrap activation sends role/framework/index/Pickup/Session once.
2. Ordinary preparation preserves the authored body exactly without context-package
   loads or historical pairing checks. Simulated execution setup separately loads
   the pinned policy; read-only replay separately inspects historical pairing.
3. A selected Session/root update does not repeat standing context.
4. Source drift rejects preparation without a mock send.
5. A genuine original-hook refusal is withheld without poisoning health.
6. Persistence failure fails closed before the mock effect; its records cannot
   certify a clean owner refusal.
7. An attempted send with unknown outcome stays unresolved, never auto-resends.
8. Torn/missing journal variants replay as unknown with incomplete coverage.

The report displays authored text versus exact outgoing bytes, selection
provenance, counters, trace ordering, coverage, and pass/fail checks. Scripted mock
effects are not used as evidence that an actual model followed instructions.
Loader counters cover preparation/dispatch for each scenario. Read-only replay
separately reads pinned context files to audit their integrity; those audit reads
are not claimed to be part of the ordinary zero-context-load path.

## Focused checks

```sh
bun test --tsconfig-override experiments/context-engine-demo/tsconfig.json \
  ./experiments/context-engine-demo/cli.test.ts \
  ./experiments/context-engine-demo/journal.test.ts \
  ./experiments/context-engine-demo/replay.test.ts \
  ./experiments/context-engine-demo/report.test.ts \
  ./experiments/context-engine-demo/paths.test.ts \
  ./experiments/context-engine-demo/demo.test.ts
```

The final test runs the complete mock walkthrough with a fresh replay subprocess.
Do not run the full repository suite merely to execute this demonstration.

## Limits

The local fixture is a controlled trust root, not an attacker-resistant provenance
service. File/directory fsync and integrity checkpoints exercise the real disk
path, but no power-loss/native-crash guarantee is established. The unknown-outcome
scenario is scripted, not a killed real native process. Instrumentation counters
describe this mock engine path, not production App dispatch performance.

App wiring, queue integration and old injector/ack retirement have since moved to
the [production cutover](../../reports/context-message-cutover-2026-10-26/README.md);
this demo does not qualify them. Actual native branch/compaction retention and
real tool/model workflows remain outside this demonstration's coverage. The
[demo plan](../../reports/context-engine-foundation-2026-10-25/DEMO_PLAN.md) records
its original stage, not the current production backlog.
