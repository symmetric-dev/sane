# SDK-backed `work supervise` implementation plan

## Status

Implementation through the opt-in SDK backend is complete. This is a repository
implementation plan, not a formal AgENV workstream. It preserves the existing
manager, supervision, and batch-state workflow while keeping the legacy backend
as the default compatibility path. Remaining work is real-workstream
verification, rollout hardening, and optional future capabilities.

## Goal

Allow the existing top-level manager workflow to execute implementation threads
through provider SDKs instead of shell-wrapped `opencode run` commands:

```text
manager OpenCode session
  -> bash tool invokes `work supervise`
  -> detached SDK BatchExecutor
  -> parallel Cursor/OpenCode implementation attempts
  -> existing canonical batch/thread state
  -> `work supervise` returns the normal handoff
```

The first implementation must preserve the current behavior that matters to the
manager:

- `work supervise` remains the public orchestration CLI;
- the manager waits for a terminal batch result or its wait timeout;
- review/fix decisions remain outside `work supervise`;
- existing batch failure, reconciliation, manual status, and fresh-retry tools
  remain usable;
- implementation threads continue to run in parallel;
- SDK execution does not write live provider output into the manager's command
  output.

## Core decisions

### Atomic implementation attempts

One provider execution is one atomic attempt:

```text
start provider agent/session
  -> send the complete implementation prompt
  -> observe tool/output/status activity
  -> receive terminal result
```

The initial production backend does not require provider conversation resume,
message-level replay, or recovery from a tool call. If an attempt fails or its
executor is lost, the batch recovery path may create a brand-new provider
agent/session.

Native provider IDs are still persisted immediately. They are needed for
observability, cancellation, OpenCode orphan cleanup, and avoiding duplicate
remote work—not for Cursor conversation resume.

### Detached executor, not tmux ownership

The SDK backend uses one detached `BatchExecutor` process per batch. It owns
parallel provider attempts and writes canonical state. Tmux remains available
for the legacy backend, interactive sessions, and optional observation, but is
not required to keep SDK agents alive.

The initial executor can run concurrent attempts in one process using the same
parallelism as the current batch execution. Per-thread child processes or
additional concurrency limits can be added later if provider isolation proves
necessary; they are not part of the first implementation.

### OpenCode first, Cursor second

The first provider backend is OpenCode V1 through the currently tested SDK:

- attach to the existing shared local `opencode serve` instance;
- create one native session per implementation thread;
- use synchronous prompting while the executor remains alive;
- subscribe to events and collect a terminal result;
- call `session.abort` for explicit cancellation where supported.

OpenCode `promptAsync` is not required for the first production path. It remains
an optional future capability.

Cursor uses its local SDK inside the detached executor. A Cursor attempt is
considered failed if the owning executor is lost. The executor does not
implicitly retry the same model under another runtime; only a later model
candidate explicitly listed for the assigned agent may be used as fallback.

### Manager invocation

The initial manager invocation remains:

```text
manager OpenCode session -> bash -> work supervise
```

An OpenCode plugin tool can be added later as a thin facade over the same
orchestration library or CLI. It must not own provider SDK processes directly
inside the plugin callback.

### Separate and normal CLI integration

The SDK backend is available through a second entry point from the same
`@agenv/workstreams` package:

```bash
work-sdk supervise --batch "01.01" --timeout-ms 1200000
```

`work-sdk supervise` should reuse the same supervision planning, persistence,
wait, recovery, and handoff code as `work supervise`, but select the SDK
backend unconditionally. It must not fork a second implementation of batch
state logic.

The detached worker is also a CLI process, but is an internal executor command:

```bash
work-sdk batch-executor --batch-id "01.01" --execution-backend sdk
```

`work-sdk supervise` launches this command detached. Direct executor invocation
is primarily for automated tests and diagnostics; normal users should invoke
the supervision command.

The normal command now also supports an explicit backend option:

```bash
work supervise --execution-backend sdk --batch "01.01"
```

For temporary verification, the normal command also accepts a reversible
environment default:

```bash
WORKSTREAM_EXECUTION_BACKEND=sdk work supervise --batch "01.01"
```

The explicit CLI option overrides the environment. Unset the variable, or pass
`--execution-backend legacy`, to use the legacy backend again. SDK execution is
not permanently the default.

### Provider and agent selection

The current workstream model assigns a logical agent profile to a thread. The
existing commands are:

```bash
work assign --thread "01.01.01" --agent default
work update --thread "01.01.01" --agent default
```

That assignment is persisted as `assignedAgent` in canonical thread runtime
state. It currently selects an entry from `agents.yaml`, whose models are
OpenCode-oriented. Plans and generated `WORK.md` files do not currently assign
providers.

The SDK design keeps four concepts separate:

```text
execution backend = legacy | sdk
provider           = opencode | cursor
agent              = logical profile assigned to a thread
model              = provider-specific model selection
```

Model references may include an explicit runtime suffix:

```bash
openai/gpt-5.6-luna@opencode
gpt-5.6-luna@cursor
auto@cursor
```

The existing structured model form should add `runtime` as a sibling field,
not append the suffix to the `model` value:

```yaml
models:
  - { model: openai/gpt-5.5, variant: high, runtime: opencode }
  - { model: auto, runtime: cursor }
```

Both forms normalize to the same internal representation:

```ts
{
  model: "openai/gpt-5.5",
  variant: "high",
  runtime: "opencode",
}
```

Rules:

- string model references may use `model@runtime`;
- structured model references use a separate `runtime` field;
- an omitted runtime uses the top-level `work/*` execution default;
- `variant` remains a provider-specific option and is validated by the
  selected adapter;
- a structured model should not also include a runtime suffix in its `model`
  field;
- conflicting runtime declarations must fail validation rather than silently
  choosing one.

Recommended precedence is:

```text
explicit CLI --runtime override
  > explicit @runtime suffix on the model
  > top-level work/* execution.defaultRuntime
  > legacy default: opencode
```

The CLI override is intended for experiments and forced batch runs, for
example:

```bash
work-sdk supervise --batch "01.01" --runtime cursor
```

The assigned logical agent profile still supplies the ordered model candidates.
The top-level `work/agents.yaml` configuration applies to all workstreams in
the current repository path and can provide the default runtime while
preserving the existing agent catalog, for example:

```yaml
execution:
  defaultRuntime: opencode

agents:
  - name: default
    models:
      - { model: anthropic/claude-sonnet-4-5, runtime: opencode }
      - { model: auto, runtime: cursor }
```

The parser should recognize only supported runtime suffixes, reject an unknown
or empty suffix, and pass the left-hand model value to the selected adapter.
OpenCode validation should require a non-empty `provider/model` value and
Cursor validation should use Cursor's model rules rather than the OpenCode
slash validator. Runtime-specific validation belongs in each adapter.

An omitted suffix uses the top-level `work/*` default. The resolved backend,
runtime, model, source profile, and runtime-selection source must be persisted
on the batch run and per-thread attempt before provider execution starts.

Runtime selection is per model candidate and therefore per thread attempt. Two
threads in one batch may use different SDKs. A later model candidate may
explicitly select a different SDK as an ordered fallback.

SDK retry is disabled by default in the sense that the executor must not
implicitly retry a model under another runtime or repeat the same model. The
ordered `models` list is the explicit fallback policy already used by the
workstream configuration:

```yaml
models:
  - { model: gpt-5.6-luna, runtime: cursor }
  - { model: anthropic/claude-sonnet-4-5, runtime: opencode }
```

If the first candidate fails, the second candidate may be attempted because it
was explicitly listed. If only one candidate is listed, the attempt fails
without a replacement. A fallback candidate always receives a fresh attempt ID
and provider session/agent. Existing legacy backend behavior remains unchanged.

Do not encode providers as agent names such as `cursor-default` or
`opencode-default`, and do not force Cursor model IDs through OpenCode's
`provider/model` validator.

## Target architecture

```text
work supervise
  -> existing launch/wait/recover/stop planning
  -> selected backend
       -> legacy work multi --headless --async
       -> detached work-sdk batch-executor --batch-id ... --execution-backend sdk
  -> provider adapters
       -> OpenCode V1 SDK -> existing opencode serve
       -> Cursor local SDK
  -> canonical batch/thread state
  -> activity journal + executor log
```

The legacy path remains available:

```text
work supervise
  -> work multi --headless --async --execution-backend legacy
  -> tmux
  -> shell-wrapped opencode run
  -> compatibility artifacts
```

## State contract

Extend existing canonical batch/thread/session records only where fields are
missing. Do not make the PoC manifest or result files canonical.

### Batch/executor metadata

- `executionBackend`: `legacy | sdk`;
- `executorPid`;
- `executorStartedAt`;
- `executorHeartbeatAt`;
- `executorFinishedAt`;
- executor terminal/error information;
- runtime log and activity journal locations.

### Per-thread attempt metadata

- `attemptId`;
- `provider`: `opencode | cursor`;
- provider-specific model selection;
- AgENV `workSessionId`;
- `nativeSessionId`;
- `nativeRunId` when available;
- `lastEventAt`;
- `lastActivityAt`;
- cancellation requested/acknowledged timestamps;
- terminal attempt outcome;
- compact error/result summary.

The existing public statuses remain authoritative. New metadata explains how a
thread was executed; it must not replace `batch-status` or canonical thread
state.

## Step-by-step implementation

### Step 1: Define production contracts without changing the default

**Status: Complete.**

Create AgENV-owned types for:

- provider attempt input;
- native session information;
- normalized lifecycle events;
- terminal attempt results;
- cancellation outcome;
- executor heartbeat and ownership;
- compact activity records.

The adapter boundary should support one atomic attempt rather than a generic
conversation-resume API:

```ts
interface AgentAttemptAdapter {
  provider: "opencode" | "cursor"

  startAttempt(input: AttemptInput): Promise<NativeAttempt>
  run(attempt: NativeAttempt, prompt: string): Promise<AttemptResult>
  events(attempt: NativeAttempt): AsyncIterable<AgentEvent>
  cancel(attempt: NativeAttempt): Promise<CancelResult>
  reconcile?(nativeSessionId: string): Promise<ReconciliationResult>
  close(): Promise<void>
}
```

Tasks:

1. Add optional executor/provider fields to the existing runtime/session types.
2. Add a `model@runtime` parser with default-runtime resolution and explicit CLI
   runtime override support.
3. Add provider-specific model validation instead of requiring every model to
   use OpenCode's `provider/model` syntax.
4. Preserve explicit ordered model fallbacks while preventing implicit
   same-model/runtime retries.
5. Add fake adapter fixtures and contract tests.
6. Keep the legacy backend and all current defaults unchanged.

Likely code areas:

- `packages/workstreams/src/lib/types.ts`;
- `packages/workstreams/src/lib/agents-yaml.ts`;
- `packages/workstreams/src/lib/model.ts`;
- `packages/workstreams/src/lib/storage-adapter.ts`;
- new model-reference/configuration modules;
- new `packages/workstreams/src/lib/agent-runtime/` modules;
- corresponding `packages/workstreams/tests/` fixtures.

Done when:

- the contracts represent both providers without exposing SDK types;
- model references resolve `@cursor`/`@opencode` and the top-level `work/*`
  default;
- invalid runtime/model combinations fail before provider startup;
- SDK attempts do not retry the same model under an unlisted runtime;
- ordered model-list fallbacks continue to work;
- fake adapters can produce success, failure, cancellation, and timeout
  attempts;
- legacy typecheck and tests remain unchanged and passing.

### Step 2: Implement the OpenCode V1 adapter

**Status: Complete.**

Adapt the tested PoC request and event handling into a production adapter.

Required behavior:

1. Attach to the existing server URL and verify health.
2. Create one session per thread.
3. Persist the native session ID before prompting.
4. Send a normal synchronous prompt.
5. Consume correlated events for activity and terminal state.
6. Extract the terminal assistant result.
7. Support explicit abort and bounded cleanup.
8. Preserve raw provider payloads only in diagnostics/activity output.

Do not initially add `promptAsync` to the common executor contract. Keep it in a
provider-specific capability surface for later experiments.

Required tests:

- exact session creation and prompt request shapes;
- immediate native ID persistence;
- model parsing and omission of an unset model;
- tool/status/message event correlation;
- provider failure;
- explicit cancellation;
- timeout-driven abort;
- concurrent independent sessions;
- stream error versus normal terminal completion.

### Step 3: Implement the detached `BatchExecutor`

**Status: Complete.**

Add an internal command, for example:

```bash
work-sdk batch-executor --batch-id "SS.BB" --execution-backend sdk
```

The executor should:

1. Load the prepared batch and thread records.
2. Record its PID and start time.
3. Start a heartbeat every few seconds.
4. Start one adapter attempt per thread using the same parallelism model as the
   current batch execution.
5. Persist native IDs before prompts.
6. Update canonical thread state on meaningful transitions.
7. Capture compact activity records.
8. Handle SIGINT/SIGTERM by requesting cancellation and cleaning up.
9. Finalize each attempt independently.
10. Finalize the batch after all threads are terminal.
11. Exit with a process code that reflects executor health, while canonical
    batch state remains the source of truth.

The executor must not write live provider output to the manager's stdout. Its
stdout/stderr should be redirected to a batch runtime log.

Failure semantics:

- provider error: fail that attempt and update the batch projection;
- explicit stop: request provider cancellation and finalize as cancelled;
- supervisor wait timeout: stop waiting, but do not imply remote cancellation;
- executor process loss: heartbeat/reconciliation marks the run recoverable;
- same-model/runtime retry: never implicit;
- explicit ordered fallback: try only the next model candidate listed for the
  assigned agent;
- fallback attempt: create a new attempt and provider agent/session;
- OpenCode orphan: inspect or abort the persisted native session before an
  explicitly listed fallback when possible.

Required tests:

- parallel fake attempts;
- one attempt failing while others continue;
- executor heartbeat updates;
- SIGTERM cancellation;
- process-loss/restart detection;
- quick failure when no fallback model is listed;
- ordered fallback candidates use fresh attempt IDs;
- no duplicate launch while a batch is active.

### Step 4: Integrate the SDK backend with existing orchestration

**Status: Complete for the opt-in path.**

First expose the separate `work-sdk` entry point described above. Then change
the smallest existing orchestration seams:

- `supervision-helper.ts` launches the selected backend;
- `multi.ts` prepares batch state and starts required provider services;
- `multi-orchestrator.ts` selects SDK worker execution instead of shell command
  construction;
- `batch-monitor.ts` checks executor PID/heartbeat for SDK batches;
- `multi-finalization.ts` maps SDK terminal outcomes into existing session
  records;
- `supervise.ts` continues to select launch, wait, recover, or stop.

The separate CLI path retains existing `work supervise` output and handoff
semantics. The normal `work supervise --execution-backend sdk` option and the
reversible `WORKSTREAM_EXECUTION_BACKEND=sdk` default now select the same
detached worker. Neither SDK path requires an implementation tmux session.

OpenCode server ownership remains the current local shared-server behavior. Do
not introduce V2 `Service.ensure()` or embedded `sdk-next` into this step.

Required tests:

- `work-sdk supervise` selects the SDK backend;
- `work-sdk` and `work` use the same persisted batch state and handoff logic;
- `work supervise` launches the SDK backend;
- wait returns only after terminal batch state;
- a wait timeout leaves the run resumable;
- terminal batch recovery does not relaunch work;
- executor loss is reconciled;
- SDK completion works without tmux;
- legacy CLI/tmux execution remains unchanged.

### Step 5: Add quiet operator observability

**Status: Complete.**

Use canonical state for truth and a separate activity journal for monitoring.

Recommended runtime artifacts live in the existing ignored `work/` runtime
area, not in `/tmp` or the PoC package directory:

```text
work/<stream-id>/runtime/batches/<batch-id>/runs/<run-id>/
  executor.log
  activity.jsonl
  snapshot.json
  raw/                         # optional provider diagnostics
```

The `<run-id>` prevents retries from overwriting earlier execution evidence.
Canonical state remains in `work/db.sqlite` (or the existing filesystem
fallback when SQLite is unavailable). The batch/executor record should store
the resolved runtime directory so observers do not reconstruct paths manually.
The runtime directory may contain prompts, paths, tool arguments, and model
output, so it remains local, Git-ignored, and subject to future redaction and
retention controls.

The journal should contain compact records with:

- timestamp;
- batch/thread/attempt IDs;
- provider and native session ID;
- event kind;
- short human-readable summary;
- optional reference to raw diagnostic data.

Do not persist every token/delta to SQLite. Coalesce assistant output and flush
the journal approximately every second, 64 KB, or 100 events, whichever comes
first. Lifecycle changes, tool start/finish, errors, heartbeats, and terminal
results should be persisted promptly.

Add a separate observer command, such as:

```bash
work-sdk batch-events --follow --batch "SS.BB"
work batch-status --batch "SS.BB" --format json
```

The exact command name can follow existing CLI conventions. The important
properties are that observation is separate from `work supervise`, and the
manager's command output remains concise.

Required tests:

- journal correlation for concurrent threads;
- flush behavior and bounded records;
- snapshot atomic replacement;
- observer output does not alter canonical state;
- observer works when no tmux session exists.

### Step 6: Add the Cursor local adapter

**Status: Complete.**

Implement Cursor after the executor and OpenCode path are stable.

Required behavior:

1. Resolve the tested bundled runtime and ripgrep configuration.
2. Start timeout coverage before agent creation and prompt submission.
3. Create one local agent per thread inside the executor process.
4. Persist agent/run IDs.
5. Stream tool/status/output activity.
6. Wait for one terminal result.
7. Support explicit cancellation and bounded disposal.
8. Treat executor loss as failed-attempt recovery, not conversation resume.

Required tests:

- setup and prompt failure;
- setup timeout;
- tool activity;
- cancellation;
- disposal failure;
- concurrent attempts;
- no same-model/runtime retry;
- explicit ordered fallback uses a new agent/session;
- gated live completion and file-creation probes.

### Step 7: Add an optional OpenCode tool facade

Only after the CLI/backend path is stable, consider a managed-profile
OpenCode tool that calls the same orchestration service.

The tool should return a structured launch/terminal result and should not
directly own provider SDK sessions. It may either wait for terminal state, which
matches the existing manager workflow, or return a batch ID and require a
separate status call. The first option is the compatibility behavior.

Required tests:

- tool and CLI use the same orchestration behavior;
- tool output is concise and structured;
- tool failure does not orphan the executor;
- duplicate tool/CLI launches are rejected by existing guards.

### Step 8: Controlled rollout and future providers

**Status: In progress: real-workstream verification and rollout decision remain.**

Keep the legacy backend as the default until the SDK backend passes:

- parallel execution;
- quick failure when no explicit fallback candidate exists;
- explicit ordered model fallback;
- explicit cancellation;
- supervisor timeout/resume;
- executor process loss;
- terminal completion without tmux;
- quiet activity observation;
- compatibility tests.

Then enable SDK execution by explicit provider/backend configuration before
considering a default switch.

Future providers, including OpenCode V2, Gemini, or additional Claude paths,
should implement the same AgENV-owned adapter contract. Provider SDK types,
prompt shapes, service ownership, and event payloads remain inside adapters.

## Explicit non-goals for the first implementation

- Cursor conversation-level resume;
- OpenCode `promptAsync` as a required execution path;
- OpenCode V2 embedded runtime;
- automatic server restart recovery;
- complete transcript persistence in canonical state;
- a web dashboard;
- replacing interactive `work multi` tmux behavior;
- changing parent-side review/fix/escalation behavior;
- making SDK execution the default before compatibility evidence exists.

The environment-controlled SDK default is a verification switch, not a
permanent product-default change.

## Verification commands

The exact commands can evolve with implementation, but the default verification
boundary should include:

```bash
bun run typecheck
bun run test
bun run --cwd packages/agent-sdk-poc test
```

Provider and integration tests remain explicitly opt-in and must use temporary
workspaces. Live tests should not be part of the default repository test
command.
