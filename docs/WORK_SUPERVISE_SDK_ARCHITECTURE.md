# SDK-backed `work supervise`

## Purpose

This document records the long-term direction for making `work supervise` a
stateful, provider-neutral execution coordinator. The goal is to support both
OpenCode and Cursor Agent through TypeScript SDKs instead of depending on
terminal output parsing and shell prompt piping.

This scope is intentionally limited to the `work supervise` headless batch
execution path. It does **not** cover launching supervision branches from a
parent agent session or replacing OpenCode plugin tools.

## Exploratory PoC status

Before changing `work supervise`, the standalone SDK PoC in
[`docs/AGENT_SDK_POC.md`](./AGENT_SDK_POC.md) has now exercised both providers
without tmux:

- Cursor local execution through `@cursor/sdk/bundled`, including raw streamed
  events, tool activity, cancellation, concurrency, and runtime diagnostics.
- OpenCode synchronous execution through `createOpencodeClient`, including raw
  SSE events, message/part capture, cancellation, and a separate observer.
- OpenCode `session.promptAsync` through a separate async launcher and observer.
  On the tested local OpenCode `1.18.18` server, a delayed task continued after
  the launcher process exited and a later observer saw its terminal idle event.

The PoC is diagnostic evidence, not canonical execution state. Its artifact
manifest, JSONL logs, and `running` async-launch status must not be reused as
the production AgENV state model. The findings and exact commands are in the
PoC package README and `FINDINGS.md`.

The PoC changes the recommended implementation order for this architecture:

1. Keep provider-specific adapters around the observed SDK calls and payloads.
2. Build a durable detached `BatchExecutor` that owns process lifetime,
   cancellation, heartbeats, and provider subscriptions.
3. Map executor transitions and provider IDs into canonical AgENV state.
4. Add compatibility/default switching only after recovery and observability
   tests pass.

The PoC does not prove server-restart recovery, network-failure recovery,
retries, leases, or Cursor local execution after its owning process exits.

## Future work: OpenCode V2 horizon

This section records the V2 position as of August 2026. It is a planning
constraint, not a decision to make V2 the current execution backend.

### V2 options available today

The V2 network client is published as the beta package
`@opencode-ai/client` and connects to an OpenCode server over HTTP. Its shape
is compatible with the executor direction:

- `OpenCode.make({ baseUrl })` creates a typed client;
- sessions are created with a workspace `location.directory`;
- prompts and resource operations are typed;
- event endpoints expose async iterables;
- requests accept `AbortSignal` and custom headers/fetch implementations;
- the Node-only service entrypoint provides `Service.discover()`,
  `Service.ensure()`, `Service.stop()`, and `Service.headers()`.

The V2 client is currently beta. The observed public registry version is a
`0.0.0-beta-*` release, and the documentation warns that method names,
inputs, outputs, and package details may change before a stable release.

V2 also describes an embedded Effect-native runtime through
`@opencode-ai/sdk-next`. It hosts OpenCode in-process, avoids an HTTP listener
and network hop, and uses scoped cleanup. As of this writing it is private to
the OpenCode workspace and is not published for normal external installation.
It should therefore remain a future option rather than a current AgENV
dependency.

### Current V2 limitations and unknowns

Before adopting the V2 client in production, we still need to verify its
installed declarations and live behavior for the operations AgENV requires:

- `promptAsync` acceptance and post-client-disconnect behavior;
- abort and timeout semantics;
- session status and message/history inspection;
- event correlation and terminal-status behavior;
- service registration, version checks, startup, and exact-instance stop;
- server restart and executor recovery;
- compatibility between the beta client and the OpenCode server versions we
  support.

The documentation examples demonstrate the client shape but do not by
themselves establish parity with every V1 operation or the PoC's observed
async/disconnect behavior. No V2 live integration has been accepted into the
AgENV execution path yet.

### Adjustments to the current V1/Cursor plan

The current plan does not need a redesign. It should be made version- and
transport-aware at the provider boundary:

1. **Keep SDK types inside provider adapters.** Implement the current
   OpenCode V1 adapter and a future V2 adapter behind AgENV-owned request,
   result, and event types. Do not expose `createOpencodeClient`,
   `OpenCode.make`, or Effect types to `BatchExecutor` or workstream code.
2. **Separate client transport from server ownership.** The executor should
   receive an existing endpoint today, while a future OpenCode service manager
   may use `Service.discover()`/`ensure()`/`stop()`. This keeps externally
   managed servers and V2-managed servers interchangeable.
3. **Use provider-specific prompt builders.** Keep workspace directory,
   title, model, and prompt as AgENV-owned inputs, but let each adapter map
   them to its SDK shape. This avoids baking V1 `parts` or V2 `text` into the
   runtime contract.
4. **Make asynchronous continuation a capability.** Do not make
   `promptAsync` a universal runtime requirement. OpenCode may support it;
   Cursor local execution still requires its owning process. The executor must
   explicitly record whether a run is terminal, remotely continuing, or still
   owned by a live process.
5. **Keep event cancellation and cleanup explicit.** The adapter boundary
   should support an abortable async event stream and an explicit close path.
   That fits the V2 client today and leaves room for closing an Effect scope if
   the embedded runtime becomes usable later.
6. **Add adapter contract tests rather than SDK-shaped tests.** The same fake
   provider contract should be exercised by V1 and V2 adapters for session-ID
   persistence, event correlation, cancellation, terminal results, and errors.
   V2-specific tests should remain opt-in until the beta API stabilizes.

The canonical AgENV state model, native-ID persistence, provider-specific model
configuration, detached executor direction, and tmux compatibility strategy
do not need to change. V2 affects the adapter and service seams, not the source
of truth or lifecycle concepts.

### Recommended V2 timing

It is reasonable to defer V2 implementation for a few months. The work that
should happen now is the boundary design and fake contract coverage. When V2
is revisited, start with a small isolated client spike that verifies the
operations above, then add `OpenCodeV2HttpAdapter` behind a feature flag. Only
consider an embedded `sdk-next` adapter after it is externally installable,
versioned, and its Effect lifecycle is acceptable for the detached executor.

## Decision summary

- Keep `work supervise` as the public orchestration CLI.
- Introduce a provider-neutral executor/runtime boundary.
- Support OpenCode through `@opencode-ai/sdk` first.
- Add Cursor through `@cursor/sdk` as a local-runtime provider.
- Keep `batch-status` and AgENV runtime state as the canonical source of truth.
- Persist provider-native session and run identifiers when they are created.
- Treat one implementation-agent execution as an atomic attempt. A failed or
  lost attempt is terminal by default; an explicitly listed fallback model may
  create a new provider session/agent. Provider conversation resume is not
  required for the initial SDK backend.
- Make tmux optional for SDK headless execution and retain the current
  CLI/tmux implementation as a compatibility backend and interactive path.
- Keep the manager-facing `work supervise` CLI and its handoff behavior
  unchanged while replacing only the batch worker backend.

The intended end state is:

```text
work supervise
  -> persisted batch run
  -> detached BatchExecutor
  -> OpenCode SDK or Cursor SDK
  -> typed events and native IDs
  -> canonical AgENV batch/thread state
  -> optional tmux observability
```

## Current implementation

The current headless path is:

```text
work supervise
  -> launchHeadlessBatchExecution()
  -> work multi --headless --async
  -> opencode serve
  -> tmux implementation session
  -> shell-wrapped opencode run per thread
  -> /tmp completion/result artifacts
  -> batch-status polling
```

Important repository references:

- `packages/workstreams/src/cli/supervise.ts`
  - Selects launch, wait, recover, or stop.
  - Waits for terminal `batch-status`.
  - Records the supervision handoff.
- `packages/workstreams/src/lib/supervision-helper.ts`
  - Spawns `work multi --headless --async`.
- `packages/workstreams/src/cli/multi.ts`
  - Starts the OpenCode server.
  - Initializes headless batch state.
  - Creates the tmux session and detached batch monitor.
- `packages/workstreams/src/lib/multi-orchestrator.ts`
  - Builds the per-thread runtime command.
- `packages/workstreams/src/lib/opencode.ts`
  - Owns OpenCode server health, shell command construction, retry logic, and
    completion/result artifact paths.
- `packages/workstreams/src/lib/batch-monitor.ts`
  - Derives thread and batch status from persisted state, markers, result files,
    canonical task state, and tmux recovery signals.
- `packages/workstreams/src/lib/multi-finalization.ts`
  - Converts pane/result state into thread session completion records.
- `packages/workstreams/src/lib/tmux.ts`
  - Creates, observes, and terminates implementation sessions.

The current design is reliable enough to preserve as a compatibility path, but
it has provider-specific assumptions:

- per-thread commands are hard-coded to `opencode run`;
- prompts are passed through shell quoting and stdin;
- model configuration assumes OpenCode `provider/model` identifiers;
- retry behavior is implemented in shell scripts;
- native OpenCode session IDs are not necessarily available when a worker
  starts;
- timeout currently stops waiting but does not necessarily abort the agent;
- tmux and temporary files participate in liveness and completion recovery.

The first SDK backend deliberately preserves the existing manager semantics:
`work supervise` launches or resumes a persisted batch, waits for terminal
`batch-status`, and returns a handoff. It does not run review/fix cycles. SDK
workers are owned by a detached batch executor, run in parallel, and update the
same canonical batch/thread state directly.

## SDK capabilities

### OpenCode

OpenCode exposes a typed client for its headless HTTP server:

- create or attach to a server;
- create, list, inspect, and delete sessions;
- send synchronous or asynchronous prompts;
- select provider/model and other prompt options;
- stream server events through SSE;
- inspect messages and session status;
- abort a running session;
- access typed API responses and errors.

OpenCode already has the right shape for AgENV because the current
implementation starts one shared `opencode serve` instance for a batch. The
SDK should attach to that server rather than creating one server per thread.

Use one OpenCode session per implementation thread and persist the returned
native session ID immediately. The SDK client should own prompting, event
subscription, cancellation, and result extraction; the OpenCode server should
remain the agent runtime.

The initial production adapter should use a normal synchronous prompt while
the detached executor remains alive. `promptAsync` is an optional future
capability for server-owned continuation, not a prerequisite for the first SDK
backend. If an executor is lost, the persisted native session ID is used for
best-effort status/abort reconciliation before a fresh attempt is started.

### Cursor Agent

Cursor provides a TypeScript SDK with local and cloud runtimes. For AgENV's
existing local worktree model, use the local runtime:

- `Agent.create({ local: { cwd }, model, apiKey })`;
- `agent.send(prompt)` for a run;
- `run.stream()` for typed assistant, tool, status, and usage events;
- `run.wait()` for the terminal result;
- `run.cancel()` for cancellation;
- `Agent.resume(agentId)` and `Agent.getRun()` for optional observation;
- local stores for provider diagnostics when eventually useful;
- local custom tools when direct AgENV integration is eventually useful.

Use one Cursor Agent per implementation thread. Persist both the Cursor agent ID
and run ID in AgENV state for observability, cancellation, and attempt
reconciliation. The initial executor does not require Cursor conversation resume:
a failed attempt is replaced with a new agent.

Cursor cloud agents are not the default target for this design because they run
in isolated Cursor-managed workspaces rather than the current local worktree.

## Proposed runtime boundary

The exact TypeScript API can evolve, but the conceptual boundary should cover:

```ts
interface AgentRuntime {
  provider: "opencode" | "cursor"

  startAttempt(input: {
    repoRoot: string
    workSessionId: string
    attemptId: string
    title: string
    model: unknown
  }): Promise<AgentAttempt>

  run(
    attempt: AgentAttempt,
    prompt: string,
  ): Promise<AgentResult>

  events(attempt: AgentAttempt): AsyncIterable<AgentEvent>

  cancel(attempt: AgentAttempt): Promise<void>

  // Optional provider-specific cleanup/inspection; not conversation resume.
  reconcile?(nativeSessionId: string): Promise<ReconciliationResult>

  close(): Promise<void>
}
```

The abstraction should not pretend the provider data models are identical.
AgENV should normalize only the lifecycle concepts it needs:

- started;
- assistant output;
- tool activity;
- progress/status;
- completed;
- failed;
- cancelled;
- usage when available.

Provider-specific payloads can remain available as diagnostic metadata.

The boundary represents one atomic agent attempt. It does not require a
provider-neutral conversation-resume API. Providers may expose different
native IDs and cleanup/reconciliation capabilities.

Do not use one generic ID in place of all provider IDs. Persist at least:

```text
work_session_id       AgENV session-* identifier
provider               opencode | cursor
native_session_id     OpenCode session ID or Cursor agent ID
native_run_id         Provider run/message identifier when available
last_event_at         Last provider event observed
executor_pid           Process currently owning the run
heartbeat_at           Last executor heartbeat
attempt_id             Fresh ID for this atomic implementation attempt
execution_backend      legacy | sdk
last_activity_at       Last meaningful provider activity
cancellation_requested_at  When cancellation was requested, if applicable
```

## What happens to tmux?

The legacy CLI/tmux backend remains available. SDK headless execution should
not require tmux for process ownership.

### SDK backend: detached executor without tmux

The first SDK backend should launch one detached `BatchExecutor` process for a
batch. The executor owns parallel provider attempts and writes to canonical
state while redirecting its own stdout/stderr to a runtime log:

```text
work supervise
  -> detached work batch-executor --backend sdk
  -> parallel Cursor/OpenCode attempts
  -> canonical batch/thread state
  -> activity journal and heartbeat
```

The executor should run one provider session/agent per implementation thread,
using the same parallelism as the current batch execution. A failed attempt is
terminal at the attempt level.
The executor does not implicitly retry the same model under another runtime.
Only an explicitly listed later model candidate may create a new provider
session/agent rather than resuming a conversation.

### Optional tmux observability and compatibility

Tmux may still be used for:

- the legacy CLI/tmux backend;
- an optional event/log view;
- operator inspection;
- interactive `work multi` sessions;
- a temporary executor-process fallback during migration.

The preferred SDK design separates execution truth from terminal
observability. `work supervise` output remains concise; a separate status/log
follower or future dashboard consumes the persisted activity journal.

### Important async constraint

Cursor local SDK runs inside the owning Node/Bun process. A parent command must
not create a local agent and then exit while expecting the run to continue.
The detached executor provides the required ownership. Provider conversation
resume is not required after an executor failure; the batch recovery path starts
a new attempt only when an explicitly listed fallback model exists or a
deliberate rerun is requested.

OpenCode is easier to detach because `opencode serve` already provides a
persistent server. The initial SDK backend should use synchronous prompts while
the executor remains alive and attach to the existing shared server. The
provider's asynchronous prompt/disconnect behavior remains an optional future
capability rather than a requirement for removing tmux.

## State and recovery direction

Keep `batch-status` as the public status interface and keep AgENV's SQLite/
filesystem state authoritative. Provider SDK stores are runtime persistence and
recovery aids, not replacements for workstream state.

The executor should write state transitions directly instead of relying on:

- `/tmp/workstream-*-complete.txt`;
- `/tmp/workstream-*-result.json`;
- pane exit status;
- parsed terminal output.

Those artifacts can remain for the CLI compatibility backend and debugging.

The executor should persist provider metadata before sending the first prompt,
then record:

- attempt/model selection;
- provider session and run IDs;
- executor PID and heartbeat;
- event timestamps;
- tool or output summaries;
- terminal status;
- error/cancellation information;
- usage information when exposed by the provider.

Recovery is batch/attempt recovery, not provider conversation resume. It should
use the following order:

1. canonical AgENV executor and thread state;
2. executor PID/heartbeat and persisted attempt ownership;
3. provider-native session status for OpenCode orphan cleanup or terminal
   confirmation;
4. canonical thread/task completion state;
5. tmux and temporary artifacts as compatibility evidence only.

If retry is enabled later, it should move out of shell command construction and
into the executor. Each replacement attempt must be recorded with a fresh
attempt ID and provider session/agent. Cancellation or orphan cleanup must
happen before starting a replacement attempt when the provider allows it. A
Cursor retry does not require provider conversation resume.

The existing `work supervise` timeout continues to mean “stop waiting” unless
an explicit cancellation/stop operation is requested. The executor may continue
running, and the next invocation must reconcile the same batch before launching
another one.

## Provider configuration

The existing top-level `work/agents.yaml` model schema is OpenCode-oriented. A
future configuration should allow serialized runtime suffixes and a default
that applies to all workstreams in the current repository path, for example:

```yaml
execution:
  defaultRuntime: opencode

agents:
  - name: default
    description: General implementation agent
    best_for: Standard development tasks
    models:
      - { model: anthropic/claude-sonnet-4-5, runtime: opencode }
      - { model: auto, runtime: cursor }
```

The final schema is an implementation decision. The important requirement is
that runtime-specific model values are validated by their selected adapter,
that omitted suffixes use `execution.defaultRuntime`, and that retry remains
disabled unless explicitly enabled.

### Agent assignment versus provider selection

The current workstream assignment model stores a logical agent profile on each
thread through `work assign --agent` or `work update --agent`. The profile is
resolved from `agents.yaml` by `work multi`; `work supervise` itself currently
delegates without selecting a provider. Plans and generated `WORK.md` files do
not currently assign providers.

The SDK backend should keep these concepts separate:

```text
execution backend = legacy | sdk
provider           = opencode | cursor
agent              = logical profile assigned to a thread
model              = provider-specific model selection
```

Model references may carry an explicit runtime suffix:

```bash
openai/gpt-5.6-luna@opencode
gpt-5.6-luna@cursor
auto@cursor
```

For the existing structured model form, runtime is a sibling field:

```yaml
- { model: openai/gpt-5.5, variant: high, runtime: opencode }
- { model: auto, runtime: cursor }
```

String and structured forms normalize to the same internal model reference.
`variant` remains a provider-specific option. Structured forms should not also
put `@runtime` in the `model` value, and conflicting runtime declarations must
fail validation.

Use this precedence:

```text
explicit CLI --runtime override
  > explicit @runtime suffix on the model
  > top-level work/* execution.defaultRuntime
  > legacy default: opencode
```

The assigned agent profile supplies the ordered model candidates. Runtime
selection is per model candidate and therefore per thread attempt, so two
threads in one batch may use different SDKs. The adapter validates the
left-hand model value according to its own rules: OpenCode requires a valid
non-empty `provider/model` value, while Cursor uses Cursor's model rules.

Persist the resolved backend, runtime, model, logical agent, and selection
source on the batch run and per-thread attempt before starting execution. Do
not encode a provider into the agent name or force Cursor model IDs through the
OpenCode validator.

A provider error fails the attempt and updates the batch projection without
implicitly changing runtimes or repeating the same model. An explicitly listed
later model candidate may create a fresh attempt and provider session/agent;
retries must not be inferred beyond the configured model list.

## Recommended implementation plan

The detailed step-by-step implementation plan is maintained in
[`docs/WORK_SUPERVISE_SDK_IMPLEMENTATION_PLAN.md`](./WORK_SUPERVISE_SDK_IMPLEMENTATION_PLAN.md).
The short sequence is:

1. Define adapter, attempt, executor, and activity-event contracts without
   changing the legacy default.
2. Implement the OpenCode V1 adapter using synchronous prompts against the
   existing shared server.
3. Implement a detached SDK `BatchExecutor` with parallel attempts, heartbeat,
   canonical state updates, and separate runtime logs.
4. Expose a separate `work-sdk supervise` entry point that always selects the
   SDK backend while reusing the existing supervision state and handoff logic.
5. Add a separate activity journal/following path for operator observation.
6. Integrate `--execution-backend sdk` into the normal `work supervise` command.
7. Implement the Cursor local adapter using the same atomic-attempt contract.
8. Add an optional OpenCode plugin-tool facade only after the CLI path is
   stable.
9. Switch defaults only after compatibility, cancellation, process-loss,
   terminal-without-tmux, and parallel-provider tests pass.

## Implementation questions that remain intentionally bounded

- Should the detached executor use Bun or Node for the first production
  launcher, based on the tested provider requirements?
- Should Cursor use the bundled SDK entry in the executor, or a separate Node
  launcher when packaging requires it?
- How should OpenCode orphan sessions be inspected or aborted before a fresh
  attempt is launched?
- Which compact activity summaries are useful to operators without storing
  complete transcripts in canonical state?
- When should the future OpenCode V2 HTTP adapter be introduced behind the same
  transport boundary?

These questions do not block the initial atomic-attempt implementation. V2
`promptAsync`, provider conversation resume, and an embedded OpenCode runtime
remain optional future capabilities.

## Verification requirements

Before making SDK execution the default, add tests for:

- provider session creation and immediate ID persistence;
- concurrent sessions in one batch;
- typed event-to-batch-status transitions;
- provider errors and cancellation;
- timeout-driven abort;
- quick failure without automatic retry;
- explicit retry-policy attempt persistence when enabled;
- detached executor process loss and fresh-attempt recovery;
- terminal completion with no tmux session;
- optional tmux observability when the executor remains healthy;
- separate activity journal/follower behavior;
- OpenCode orphan-session cleanup before an explicitly enabled retry;
- Cursor local process ownership and fresh-attempt behavior when retry is enabled;
- `model@runtime` parsing, default resolution, and provider-specific validation;
- preservation of the current CLI/tmux compatibility backend.

## References

### Official provider references

- [OpenCode SDK](https://opencode.ai/docs/sdk/)
- [OpenCode server](https://opencode.ai/docs/server/)
- [`@opencode-ai/sdk` on npm](https://www.npmjs.com/package/@opencode-ai/sdk)
- [OpenCode V2 SDK](https://opencode.ai/v2/docs/build/sdk)
- [OpenCode V2 client](https://opencode.ai/v2/docs/build/client)
- [`@opencode-ai/client` on npm](https://www.npmjs.com/package/@opencode-ai/client)
- [Cursor TypeScript SDK overview](https://cursor.com/docs/api/sdk/typescript)
- [Cursor TypeScript SDK reference](https://cursor.com/docs/sdk/typescript.md)
- [`@cursor/sdk` on npm](https://www.npmjs.com/package/@cursor/sdk)
- [Cursor CLI headless mode](https://cursor.com/docs/cli/headless)
- [Cursor CLI output formats](https://cursor.com/docs/cli/reference/output-format.md)
- [Cursor ACP](https://cursor.com/docs/cli/acp)

The SDK versions observed during the audit were `@opencode-ai/sdk` 1.18.18 and
`@cursor/sdk` 1.0.28. Recheck current versions and compatibility before
implementation.

### AgENV references

- [`docs/SUPERVISOR.md`](./SUPERVISOR.md) — operator behavior and source-of-truth
  rules for `work supervise`.
- [`docs/WORKSTREAM.md`](./WORKSTREAM.md) — workstream hierarchy and execution
  state model.
- `packages/workstreams/src/cli/supervise.ts` — supervise orchestration.
- `packages/workstreams/src/cli/multi.ts` — headless batch launch.
- `packages/workstreams/src/lib/supervision-helper.ts` — supervise-to-multi
  handoff.
- `packages/workstreams/src/lib/multi-orchestrator.ts` — per-thread command
  construction.
- `packages/workstreams/src/lib/opencode.ts` — current OpenCode server and CLI
  integration.
- `packages/workstreams/src/lib/batch-monitor.ts` — batch status polling and
  recovery.
- `packages/workstreams/src/lib/multi-finalization.ts` — thread completion and
  tmux finalization.
- `packages/workstreams/src/lib/tmux.ts` — tmux lifecycle and observability.
- `packages/workstreams/src/lib/sqlite-storage.ts` — SQLite persistence.
- `packages/workstreams/src/lib/storage-adapter.ts` — structured state adapter.
- `packages/workstreams/src/lib/threads.ts` — thread sessions and native session
  metadata.
- `packages/workstreams/src/lib/types.ts` — runtime and session types.
- `packages/workstreams/tests/tmux.test.ts` — tmux behavior coverage.
- `packages/workstreams/tests/launch-supervision-opencode.test.ts` — current
  OpenCode process/session test patterns.
- [`docs/AGENT_SDK_POC.md`](./AGENT_SDK_POC.md) — completed exploratory SDK
  probes, commands, artifacts, and production handoff boundary.
- [`docs/WORK_SUPERVISE_SDK_IMPLEMENTATION_PLAN.md`](./WORK_SUPERVISE_SDK_IMPLEMENTATION_PLAN.md)
  — proposed step-by-step implementation sequence.

## Resume point

The exploratory SDK PoC is complete enough to begin implementation planning in
the existing codebase. Follow
[`docs/WORK_SUPERVISE_SDK_IMPLEMENTATION_PLAN.md`](./WORK_SUPERVISE_SDK_IMPLEMENTATION_PLAN.md):
turn the observed provider-specific runners into tested adapters, then build the
detached `BatchExecutor` and its canonical state integration. Use the PoC
commands and raw artifacts as implementation and manual-verification
references, not as production persistence. Do not remove tmux or change the
default `work supervise` backend until executor process-loss handling,
cancellation, terminal-without-tmux, and compatibility tests are in place.
