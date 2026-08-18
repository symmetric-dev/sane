# Agent SDK Proof of Concept

## Purpose

This is an exploratory proof of concept for running Cursor and OpenCode agents
directly through their TypeScript SDKs, without tmux and without integrating
with AgENV workstreams yet.

The purpose is to answer practical questions before we design a durable
executor, state model, or web dashboard:

- Can both SDKs run local agents from a long-lived Node/Bun process?
- What lifecycle, output, tool-call, status, cancellation, and usage events do
  they expose?
- Which provider IDs and run/session handles are available, and when?
- Can a separate observer process inspect or follow activity?
- What information would a web UI need in order to replace tmux observability?

This document supersedes the larger `work supervise` SDK architecture for the
initial exploratory stage. The architecture document remains useful as a
long-term direction, but it is not the scope of this PoC.

## Slice 2, Slice 3, and Slice 4 implementation boundary

Slice 2 is implemented in `packages/agent-sdk-poc` as a Cursor-only follow-up
to the Bun bundled-entry Slice 1. It adds the startup ripgrep-path diagnosis and
fix, inspectable stderr diagnostics, gated live Cursor probes, and a no-key
probe of the regular Node entry.

Slice 3 adds provider-specific OpenCode support against an explicitly supplied
already-running server, plus an attach-and-observe command. It uses a normal
synchronous prompt, raw SSE artifacts, native session/message correlation, and
bounded SSE cleanup. It deliberately does not add server ownership, workstream
integration, tmux, SQLite, durable recovery, or a production runtime
abstraction.

Slice 4 adds only the OpenCode async/disconnect experiment. The provider-specific
async launcher creates a native session, persists its ID before prompting, calls
the installed SDK's `session.promptAsync` method (the
`/session/{id}/prompt_async` endpoint), records acceptance and timestamps, and
returns a nonterminal `running` artifact without subscribing to SSE. It never
starts or stops `opencode serve`. The existing `opencode observe` path is the
separate process for status/message inspection and bounded SSE following. This
is still not workstream integration, durable recovery, or a provider-neutral
runtime abstraction.

## Scope

### Included

- A standalone PoC package or executable, isolated from `work supervise`.
- Cursor local SDK integration first.
- OpenCode SDK integration second.
- Real provider end-to-end tests, explicitly opt-in because they consume model
  usage and require credentials.
- Direct execution without tmux.
- Human-readable console logging.
- Timestamped JSONL event logs containing raw provider payloads.
- A small diagnostic run manifest containing provider, process, working
  directory, model, native IDs, timestamps, and terminal result when the PoC
  process owns a terminal run; async launches remain explicitly nonterminal.
- Basic completion, tool activity, timeout/cancellation, and concurrent-run
  probes.
- A short findings report based on observed behavior.

### Explicitly excluded

- `work supervise`, `work multi`, or any workstream state integration.
- SQLite, canonical batch/thread state, retries, or production recovery.
- A production `AgentRuntime` abstraction.
- tmux migration or removal work in the existing CLI.
- Cursor cloud agents.
- Cursor custom tools or AgENV tools.
- A web UI. The JSONL output should be suitable as a future UI input, but the
  UI itself is not part of this PoC.
- Durable detached execution guarantees. Cursor local execution must remain in
  the owning process for this experiment.

## Proposed shape

Create an isolated package such as `packages/agent-sdk-poc` rather than adding
provider dependencies to `@agenv/workstreams`.

The PoC should use provider-specific runners and only share a deliberately
small logging envelope:

```ts
interface PocEventEnvelope {
  timestamp: string
  provider: "cursor" | "opencode"
  runDirectory: string
  kind: string
  raw: unknown
}
```

This is not intended to be the eventual normalized runtime event model. Raw
provider data must remain available while we learn what the useful common
concepts actually are.

Each run should produce an inspectable directory, for example:

```text
.tmp/agent-sdk-poc/<timestamp>-<provider>/
  manifest.json
  events.jsonl
  stdout.log
  stderr.log
  result.json
  conversation.json       # when the provider exposes one
```

The directory should be configurable with `--run-dir` and easy to print at the
end of a run. POC artifacts must be ignored by git and may contain prompts,
tool arguments, file paths, and model output.

## Cursor probe sequence

### 1. Runtime and package smoke test

- Install the current compatible `@cursor/sdk` package.
- Verify the documented Node 22.13+ requirement.
- Verify the Bun execution/bundled-entry strategy separately rather than
  assuming that the existing Bun CLI runtime is compatible.
- Record the chosen invocation and package versions in the findings report.

The repository may continue to use Bun as its package manager while the PoC
launcher targets Node 22.13+ if that is the most reliable Cursor local runtime.

### 2. Basic local run

Create a local agent in a temporary working directory, send a prompt, stream
all events, wait for the result, and record:

- `agentId`;
- run ID and request ID;
- model selection;
- assistant/thinking output;
- tool calls and their arguments/results;
- status changes;
- usage when available;
- final result and duration.

Use `await using` or an equivalent explicit cleanup path so the process does
not accidentally remain alive after the run.

### 3. Tool activity run

Use a temporary directory and ask the agent to create a known file, for
example:

```text
Create a file named poc-output.txt containing exactly POC FILE CREATED.
Then respond exactly TEST COMPLETED.
```

The test should verify both the file and the captured tool-call events.

### 4. Delayed completion and cancellation

Use a deterministic shell-tool prompt rather than relying on the model to
silently wait:

```text
Use the shell tool to run `sleep 5`. After it finishes, respond exactly TEST COMPLETED.
```

Also run a cancellation probe using `sleep 60`, cancel the run after a short
delay, and record how quickly cancellation propagates and which final status
and partial output are available.

### 5. Concurrent local runs

Start two independent local agents or runs from one process, multiplex their
events into one JSONL stream, and verify that agent ID and run ID correlation
is sufficient to separate their output.

### 6. Local resume/inspection probe

If the default local store supports it without introducing custom persistence,
record the agent ID and verify `Agent.resume`, `Agent.getRun`, and conversation
inspection from a second process. This is an optional observation probe, not a
recovery implementation and not a prerequisite for the initial atomic-attempt
`work supervise` backend.

## OpenCode probe sequence

### 1. Attach to a server

Use `createOpencodeClient` against an explicitly supplied `opencode serve`
URL. The PoC should not make server ownership part of the first design.

Record server health and version before creating a session.

### 2. Basic session run

- Create one session and immediately record its native session ID.
- Subscribe to the server event stream before prompting.
- Send a simple prompt through the SDK.
- Capture raw SSE events, messages, parts, and the final prompt response.
- Record the relationship between session ID, message ID, event payloads, and
  tool activity.

### 3. Tool activity and cancellation

Repeat the temporary-file and delayed-shell probes used for Cursor, adapting
the prompt and event parsing to OpenCode’s payloads. Exercise
`session.abort` and record the resulting status and message history.

### 4. Async/disconnect probe

Exercise `prompt_async` with a delayed task using the provider-specific PoC
launcher. Compare:

1. fake/unit request construction, immediate session-ID persistence, and
   accepted-response artifact handling;
2. sending the async prompt and ending the launcher process without an SSE
   subscription;
3. reconnecting from a second process using the persisted session ID and
   inspecting status/messages/events until a correlated terminal status,
   bounded timeout, or signal.

This is the most important OpenCode-specific feasibility probe because the
long-term design may need to rely on async prompts without a terminal client.

The installed SDK types must be inspected rather than assuming a method name:
in the tested `@opencode-ai/sdk` `1.18.18` client the method is
`session.promptAsync`, while the HTTP endpoint is `prompt_async` and successful
acceptance is HTTP 204. The launch artifact is intentionally nonterminal and
must say that an observer is required.

## Test strategy

### Automated tests

- Unit-test the run-directory creation, manifest updates, JSONL logging, event
  correlation, redaction/configuration, and result formatting with fixtures.
- Keep live Cursor tests behind an explicit environment flag such as
  `SDK_POC_CURSOR_E2E=1` and require `CURSOR_API_KEY`.
- Keep live OpenCode tests behind an explicit environment flag such as
  `SDK_POC_OPENCODE_E2E=1` and require an available server and configured
  provider credentials.
- Make tests use temporary working directories and clean up provider handles.
- Do not make paid provider tests part of the default repository test command.

### Final PoC commands

From the repository root, the final Slice 2–4 command shapes are:

```bash
# Start opencode serve separately; the PoC never owns this process.
opencode serve --hostname 127.0.0.1 --port 4096

# Cursor; --model auto remains the default.
CURSOR_API_KEY=... bun run --cwd packages/agent-sdk-poc run -- \
  cursor run --prompt "Summarize this directory" --cwd "$PWD" \
  --model auto --run-dir "$PWD/.tmp/agent-sdk-poc/manual-cursor-run" \
  --timeout-ms 120000

# OpenCode synchronous run.
bun run --cwd packages/agent-sdk-poc run -- \
  opencode run --server http://127.0.0.1:4096 \
  --prompt "Respond exactly TEST COMPLETED" --cwd "$PWD" \
  --run-dir "$PWD/.tmp/agent-sdk-poc/manual-opencode-run" \
  --timeout-ms 120000

# OpenCode async launch; copy the printed native session ID.
bun run --cwd packages/agent-sdk-poc run -- \
  opencode async --server http://127.0.0.1:4096 \
  --prompt 'Use the shell tool to run `sleep 5`. After it finishes, respond exactly SDK POC ASYNC LIVE.' \
  --cwd "$PWD" --run-dir "$PWD/.tmp/agent-sdk-poc/manual-opencode-async-launch"

# OpenCode observer in a separate process and separate artifact directory.
bun run --cwd packages/agent-sdk-poc run -- \
  opencode observe --server http://127.0.0.1:4096 --session <id> \
  --cwd "$PWD" --run-dir "$PWD/.tmp/agent-sdk-poc/manual-opencode-async-observer" \
  --timeout-ms 30000
```

OpenCode `--model` is optional and uses `provider/model` when supplied; omit it
to use the server default. Do not pass Cursor's `auto` sentinel to OpenCode.

## Initial questions this PoC should answer

1. Does Cursor local execution require Node, Bun, or the bundled Bun entry in
   the way we would need for a future AgENV executor?
2. Does a local Cursor run expose enough stable event information for a live
   activity view?
3. Which Cursor payloads are stable enough to normalize, and which should stay
   provider-specific?
4. Can Cursor local agents be resumed and inspected meaningfully after the
   owning process exits?
5. Does OpenCode’s SSE stream provide tool-call and assistant-output detail
   comparable to Cursor’s stream?
6. Does OpenCode `prompt_async` continue after the client disconnects, and can
   another client observe or recover it?
7. What identifiers and timestamps are available for correlating output,
   tools, runs, and sessions?
8. What should a future web UI consume: raw events, reconstructed turns, or
   both?
9. What minimum lifecycle vocabulary is genuinely common to both providers?

## Slice 4 observed result

The live observation was run once on 2026-08-17 against a healthy local
OpenCode `1.18.18` server. The async launcher received HTTP 204, persisted a
native session ID in a `status: "running"` launch artifact, printed the ID and
artifact path, and exited. A separate observer later correlated that session,
captured the `bash` tool running `sleep 5`, captured the fixed response, and
observed a correlated `session.status` idle event before finishing. This is
live evidence for that local server/provider configuration, not a durable
guarantee across restarts, network loss, provider failures, or versions.

The launch artifact preserves raw `session_created`, async request, and async
acceptance responses. The observer preserves raw SSE, session/status/message/
part payloads, filtered cross-session events, and terminal observation metadata.
The manual/CLI observations are limited to command shape and the requirement for
a separate observer; they are not provider evidence. The exact fake/unit
observations, manual workflow, and status-map edge case are recorded in
`packages/agent-sdk-poc/FINDINGS.md`.

## Reuse boundary and implementation handoff

Reusable PoC evidence for a future executor includes provider adapters, native
ID capture before requests, raw provider payload retention, request/acceptance
timestamps, and a separate OpenCode observer process. The PoC artifact logger
is diagnostic evidence, not canonical state. Its manifest, result file, JSONL
ordering, `running` launch state, and observer labels are intentionally not
production state and must not be used as AgENV workstream state.

The next production slices should be implemented in this order: provider
adapters first; a durable `BatchExecutor` process second; canonical AgENV state
mapping third; compatibility/default switching last. `work supervise`,
`work multi`, workstream state, tmux, SQLite, and production executor code
remain outside this PoC.

## Future work: OpenCode V2 horizon

As of August 2026, OpenCode V2 is a future compatibility target rather than a
PoC dependency. The public `@opencode-ai/client` is available as a beta HTTP
client with `OpenCode.make`, typed resources, async event streams,
`AbortSignal` request support, and optional Node service management through
`Service.discover()`, `Service.ensure()`, and `Service.stop()`. Its package and
API are explicitly unstable, so the exact V2 behavior of `promptAsync`, abort,
status/history inspection, event terminal states, and server recovery still
needs to be verified before production adoption.

The documented embedded V2 runtime, `@opencode-ai/sdk-next`, is Effect-native,
scoped, and in-process, but is currently private to the OpenCode workspace and
not published for normal external installation. It is not a current AgENV
dependency.

The current Cursor and OpenCode V1 plan remains valid if SDK types stay behind
provider adapters. Future-proofing should provide separate transport and
server-ownership seams, provider-specific prompt builders, abortable event
streams, explicit cleanup, and optional async-continuation capabilities. The
canonical AgENV state model, native-ID persistence, detached executor, and tmux
compatibility direction do not need to change for V2.

For the initial `work supervise` integration, one provider execution is treated
as one atomic attempt. Provider conversation resume is not required: a failed
or lost attempt can be replaced with a brand-new provider agent/session. The
first production OpenCode adapter should use synchronous prompting while a
detached executor remains alive; the PoC's `promptAsync` launcher/observer is
optional future evidence, not the required execution path.

The manager should continue to invoke `work supervise` through the bash tool.
An OpenCode plugin tool can be added later as a thin facade over the same
orchestration path, but it should not own provider SDK processes directly. The
production handoff now exposes `work-sdk supervise` and the normal
`work supervise --execution-backend sdk` opt-in, both reusing the same persisted
supervision state and handoff logic. `WORKSTREAM_EXECUTION_BACKEND=sdk` is a
reversible verification switch for regular `work` commands.

The detailed implementation sequence is in
[`docs/WORK_SUPERVISE_SDK_IMPLEMENTATION_PLAN.md`](./WORK_SUPERVISE_SDK_IMPLEMENTATION_PLAN.md).
When V2 is revisited, first run an isolated client spike against the installed
beta declarations and a live server. Only then add a versioned V2 adapter or
consider an embedded adapter after `sdk-next` becomes externally installable.

## Exit criteria

The PoC is successful when:

- Cursor can run a local task without tmux and produce inspectable output,
  tool-call events, IDs, cancellation behavior, and a final result.
- OpenCode can run a task through its SDK without tmux and produce inspectable
  session/message/event data, tool activity, IDs, cancellation behavior, and a
  final result.
- At least one delayed task, one tool task, one cancellation task, and one
  concurrent-run probe have been exercised.
- OpenCode async/disconnect behavior has a documented observed result.
- Raw artifacts from both providers can be compared side by side.
- A findings report records recommended next steps for the eventual executor,
  state model, recovery model, and web observability design.

Success does not mean that `work supervise` changes behavior or that a
provider-neutral runtime abstraction is finalized.

## References

- [Cursor TypeScript SDK](https://cursor.com/docs/api/sdk/typescript)
- [OpenCode SDK](https://opencode.ai/docs/sdk/)
- [OpenCode server](https://opencode.ai/docs/server/)
- [OpenCode V2 SDK](https://opencode.ai/v2/docs/build/sdk)
- [OpenCode V2 client](https://opencode.ai/v2/docs/build/client)
- `docs/WORK_SUPERVISE_SDK_ARCHITECTURE.md` — deferred long-term direction
