# Recommended next step: isolated engine-path demonstrator

Status: the subsequent authorized implementation completed this mock vertical
slice. All seven scenarios and both corruption variants pass, with 422 focused
tests and a clean scoped typecheck. See the [run report](../context-engine-demo-2026-10-25/README.md).
No source worktree or native/App integration was created. The original plan follows.

## Goal and boundary

Show the new composition/evidence engine working as a complete local vertical
slice before wiring the App bridge or doing exhaustive native integration tests.
Use real composition, trusted validation, dispatch lifecycle, durable records, and
fresh-process replay. Simulate only the transport/recipient behavior and clearly
label its results **simulated harness acceptance**, not actual model/native proof.

This is engine-path end-to-end, **not full-App end-to-end**. Running the current
App with composed text would retain old injection/acknowledgment paths and would
not establish the new delivery model.

## Isolation

- Keep the demo driver in `experiments/context-engine-demo/`, outside application
  imports, with manual `run` and read-only `replay` commands.
- Use the current experiment source worktree plus a disposable fixture repository
  or linked fixture worktree, separate App data/pins, and separate evidence output.
  A new source worktree at HEAD would omit the uncommitted/untracked engine. Do
  not silently commit or transfer that work merely to create an isolated demo.
- Use unique fixture session/run identities and sanitize inherited caller/session
  environment. Do not register anything with the running App or use real native
  sessions, credentials, projects, or workstream state.
- Preserve outputs before cleaning up only the experiment-owned fixture paths.

## Proposed vertical slice

```text
fixture checkout + independent lifecycle intent
  -> real pinned context/execution stores
  -> prepareContextMessage / assertContextMessageCurrent
  -> HarnessDispatchRegistry.start and its existing owner/evidence lifecycle
  -> decorated original hooks + one experiment-owned durable journal
  -> mock-context-demo adapter (one scripted effect per submitted message)
  -> fresh-process replay from durable records
  -> inspectable transcript/report
```

The registry already creates the dispatch lifecycle. Do not create another
`createDispatchEvidence` instance, retry/admission machine, or activation ledger
for the same owner. Supply experiment-owner callbacks where the real bridge's
private callbacks would eventually go.

Use real `ContextPackageStore`, `CanonicalExecutionStore`, and paired validation
for bootstrap; execution-only validation plus a durable owner pairing check for
ordinary continuation. Materialize pins only under fixture data. Read authored
sources unchanged; do not edit skills/context to customize the demonstration.

The mock adapter must independently capture its actual pending message ID/text.
The evidence reader must inspect that capture rather than echo the composition.
Call the existing owner's `beforeNative` immediately before the scripted effect,
then report the scripted outcome through that same owner's evidence methods.

## The small missing implementation worth exercising

Implement one synchronous owner-controlled journal for this experiment using
existing event envelopes. Reuse standard submission text once; attach composition
metadata and message-correlated observations. Boundary callbacks must return only
after durable writes/fsync, or fail closed. Do not use asynchronous bridge `emit`
as if it provided this guarantee.

Replay in a separate process using the existing history decoder and evidence
projections, without sending anything. Coverage must reflect explicit protected
snapshot boundaries; a missing/torn record cannot become complete just because a
decoder can read an earlier prefix. Persist pairing references under the same
owner authority, not in a second acknowledgment store.

## First scenarios

| Scenario | Visible result |
| --- | --- |
| Activation | One mock send; main role once, required framework/index/Pickup/Session, authored body preserved |
| Ordinary continuation | Transport equals authored body, zero context-package reads, execution and pairing still checked |
| Explicit Session/root update | Only selected changed material; no role/framework/Pickup resend |
| Source drift or cancellation | Controlled async/final-gate rejection, zero mock effects |
| Genuine owner refusal vs persistence failure | Certification only for the former; persistence failure prevents the mock effect and fails closed |
| Healthy restart | Same recorded facts reconstructed in a new process without in-memory acknowledgment state |
| Uncertain restart | Partial/torn/missing coverage stays unknown; attempt without confirmed outcome remains unresolved; replay never resends |

Include authored text with SANE-looking markers to show that presentation and
evidence rely on structured metadata, not marker stripping. Worker bootstrap can
be the next scenario. Branching should initially show **unknown without native
prefix proof**, not invent proof from copied fixture flags.

## What the person should see

A CLI walkthrough plus a lightweight read-only report is enough initially:

- Authored body next to exact outgoing transport and selected segments.
- Placement, source/revision/reason, byte lengths, and hashes.
- Guard/hook/persistence/transport ordering and context-reader call counts.
- Explicit real-versus-simulated labels and restart coverage/facts.

Do not use a scripted response's apparent memory as evidence of model retention.
No browser verification or live-model spend is implied by this plan.

## Existing patterns and future steps

Useful current patterns: `tests/fixtures/app-performance.ts` for isolated checkout/
data/catalog setup, `tests/canonical-fixture.ts` for independent trusted sources,
and the new engine/evidence test files for controlled awaits and message binding.
These live under `packages/sane-app/`; their fixtures are patterns, not a ready
new-engine durable runner. In particular, the old renderer's canonical fixture is
not a complete new-engine bootstrap fixture.

After the deterministic demonstration, optionally authorize one bounded real
harness/model run in the same disposable checkout to observe a file-read/tool
action. That requires explicit cost/permission bounds and the new composer; the
earlier response-only probes do not validate tool workflows.

Full-App integration still needs trusted bridge readers/placement, durable owner
journal wiring, codec corrections, final native binding, old sink/ack removal,
queue freshness, and distinct CC initial/live-input boundaries. The demonstrator
should expose these seams, not claim to have completed them.
