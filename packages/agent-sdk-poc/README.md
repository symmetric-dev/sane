# Agent SDK PoC: Cursor Slice 2 and OpenCode Slices 3–4

This package is an isolated Cursor/OpenCode local-agent probe. It does not
integrate with `work supervise`, `work multi`, workstream state, tmux, SQLite,
or a provider-neutral runtime.

## Dependency and runtime versions

This checkout uses Bun `1.3.12` for package management, tests, and the CLI.
The direct SDK dependencies installed by the Bun lockfile are:

* `@cursor/sdk` `1.0.28`; Cursor runs through `@cursor/sdk/bundled`.
* `@opencode-ai/sdk` `1.18.18`; OpenCode runs through
  `createOpencodeClient({ baseUrl, directory })`.

Cursor documents Node.js `22.13+` for its regular entry. The existing
`probe:node` command remains a no-key smoke test for that entry; the PoC's
tested Cursor execution path is Bun's bundled entry. The OpenCode SDK uses the
standard Fetch/SSE APIs available in the required Bun runtime.

The installed OpenCode declarations expose fields-style response envelopes by
default (`data`, `error`, and `response`). `session.prompt` and
`session.promptAsync` accept text parts and an optional
`{ providerID, modelID }` model. The generated async method is camelCase
`promptAsync`; it sends `POST /session/{id}/prompt_async`, whose declared
success response is HTTP 204 (`void`). `event.subscribe()` returns an async
SSE stream that accepts an `AbortSignal`. The generated client has no
client-close method. The runner therefore aborts/returns the SSE generator
when observing, rather than disposing or owning the server.

## Commands

From the repository root:

```bash
bun install
bun run --cwd packages/agent-sdk-poc typecheck
bun run --cwd packages/agent-sdk-poc test # default unit tests; no server required
bun run --cwd packages/agent-sdk-poc probe:node # no-key Cursor regular-entry probe

# Cursor remains unchanged and defaults --model to auto.
CURSOR_API_KEY=... bun run --cwd packages/agent-sdk-poc run -- \
  cursor run \
  --prompt "Summarize this directory" \
  --cwd "$PWD" \
  --model auto \
  --run-dir "$PWD/.tmp/agent-sdk-poc/manual-cursor-run" \
  --timeout-ms 120000
```

### OpenCode server prerequisite

Start OpenCode separately and leave server ownership to that process. For the
default local attachment URL, an example is:

```bash
opencode serve --hostname 127.0.0.1 --port 4096
```

The PoC never starts or stops `opencode serve`. It only attaches to the
explicit `--server` URL, defaulting to `http://127.0.0.1:4096` when omitted.
The server must have a configured provider/model if `--model` is omitted.

Run a synchronous prompt (Slice 3):

```bash
bun run --cwd packages/agent-sdk-poc run -- \
  opencode run \
  --server http://127.0.0.1:4096 \
  --prompt "Respond exactly TEST COMPLETED" \
  --cwd "$PWD" \
  --title "SDK PoC Slice 3" \
  --run-dir "$PWD/.tmp/agent-sdk-poc/manual-opencode-run" \
  --timeout-ms 120000
```

Submit an async prompt (Slice 4). This command creates the native session,
persists its ID, sends `promptAsync`, records the HTTP 204 acceptance, flushes
the launch artifacts, prints the session ID, and exits without subscribing to
SSE:

```bash
bun run --cwd packages/agent-sdk-poc run -- \
  opencode async \
  --server http://127.0.0.1:4096 \
  --prompt 'Use the shell tool to run `sleep 5`. After it finishes, respond exactly SDK POC ASYNC LIVE.' \
  --cwd "$PWD" \
  --run-dir "$PWD/.tmp/agent-sdk-poc/manual-opencode-async-launch"
```

Use the printed native session ID in a separate process. Use a different
artifact directory so the observer does not overwrite the launch evidence:

```bash
bun run --cwd packages/agent-sdk-poc run -- \
  opencode observe \
  --server http://127.0.0.1:4096 \
  --session ses_... \
  --cwd "$PWD" \
  --run-dir "$PWD/.tmp/agent-sdk-poc/manual-opencode-async-observer" \
  --timeout-ms 30000
```

`observe` first fetches the session, status, and messages, then follows the
global SSE feed. It stops on a correlated `session.idle`/`session.status` idle
or `session.error` event, or when the timeout/signal ends observation. A
timeout or signal stops the
observer only; it does not call `session.abort` and does not claim that the
remote session terminated.

To select a model, use OpenCode's provider/model shape. It is independent of
Cursor's `auto` default:

```bash
  --model anthropic/claude-sonnet-4-5
```

If `--model` is omitted, the runner omits the model field and lets the attached
OpenCode server select its configured default. `--model auto` is not silently
sent to OpenCode because it is a Cursor-only sentinel.

Attach an observer to an existing native session ID (the ID is printed by
`opencode run` and stored in `manifest.json`):

```bash
bun run --cwd packages/agent-sdk-poc run -- \
  opencode observe \
  --server http://127.0.0.1:4096 \
  --session ses_... \
  --cwd "$PWD" \
  --run-dir "$PWD/.tmp/agent-sdk-poc/manual-opencode-observer" \
  --timeout-ms 30000
```

Without `--timeout-ms`, `observe` follows the SSE stream until a correlated
terminal event, the server closes it, or the process is interrupted. A bounded
timeout is useful for scripted probes.

CLI help is always safe and does not contact a provider or server:

```bash
bun run --cwd packages/agent-sdk-poc run -- --help
```

## Inspectable artifacts

The default location is
`.tmp/agent-sdk-poc/<timestamp>-<provider>/`. `--run-dir` selects an exact
directory. Each run and observer writes:

```text
manifest.json   # inputs, server/native IDs, timestamps, status, result/error
events.jsonl    # timestamped raw provider/SSE/message/part/status payloads
stdout.log      # human-readable activity also printed to stdout
stderr.log      # provider/SDK stderr, kept separate from stdout
result.json     # terminal result or nonterminal async acceptance artifact
```

OpenCode artifacts include `serverUrl`, `sessionId`, and `messageId` when
available. An accepted async launch has `status: "running"`,
`launchKind: "async"`, `observerRequired: true`, request/acceptance timestamps,
and `asyncAcceptedStatus: 204` in `manifest.json`/`result.json`; it has no
terminal result. Its `events.jsonl` includes the native session response,
`prompt_async_request`, and raw `prompt_async_response`. The observer preserves
raw `session`, `session_status`, `messages_response`, `message`, `part`, and
`sse`/`sse_filtered` events, followed by a diagnostic `terminal_result`.
Correlated SSE status events update the observer manifest, including a terminal
idle event when a later status query has already removed the session from its
status map. Events from other sessions are retained as `sse_filtered` but are
not printed; events without a session identifier are retained as global
activity. Artifacts can contain prompts, tool arguments, paths, and model
output and are ignored by git.

## Tests and live coverage

The default OpenCode unit tests use fake SDK clients and finite SSE fixtures;
they cover model parsing, response-envelope extraction, native ID correlation,
sync runner artifact capture, async request construction, session-ID
persistence before `promptAsync`, accepted-response handling, and observer
filtering/status correlation. They do not require a server, credentials, or a
paid provider call.

Cursor live tests remain gated by `SDK_POC_CURSOR_E2E=1` and
`CURSOR_API_KEY`; they are not part of the default test command. The existing
Cursor invocation is:

```bash
SDK_POC_CURSOR_E2E=1 CURSOR_API_KEY=... \
  bun run --cwd packages/agent-sdk-poc test:live
```

No live OpenCode test is enabled in the default suite. Live tests require
`SDK_POC_OPENCODE_E2E=1`, an explicitly supplied or default local server URL,
and the server's configured provider credentials. The Slice 3 opt-in smoke
test is:

```bash
SDK_POC_OPENCODE_E2E=1 SDK_POC_OPENCODE_SERVER=http://127.0.0.1:4096 \
  bun run --cwd packages/agent-sdk-poc test:live:opencode
```

## Slice 4 async/disconnect evidence

### Unit/fake observations

The fake launcher test reads `manifest.json` from inside `promptAsync` and
verifies that the native session ID is already persisted with `status:
"running"`. It verifies the exact `path`, `query`, and `body` request shape,
HTTP 204 acceptance metadata, raw request/response events, no SSE subscription,
and the absence of a terminal event. These are implementation observations,
not provider behavior.

### Manual/CLI observations

The manual CLI workflow and `--help` invocation confirm that the async command
exposes `--server`, `--prompt`/`--prompt-file`, `--cwd`, `--model`, and
`--run-dir`, and that the documented workflow requires a separate observer.
These command-shape observations do not establish OpenCode server behavior;
the live result below is the only provider observation for this slice.

### One live observation (run 2026-08-17)

The local server health endpoint returned OpenCode `1.18.18`. One minimal live
probe was run with the deterministic shell `sleep 5` prompt above. The async
launcher process returned after the server accepted `prompt_async` with HTTP
204; its launch manifest remained `running` and contained the native session
ID and acceptance timestamps. A separate observer process, started after the
launcher exited, reconnected using that ID and captured `server.connected`, the
`bash` tool running/completing `sleep 5`, message/part updates, the exact fixed
response `SDK POC ASYNC LIVE`, and a correlated `session.status` transition to
`idle`. The observer ended with `finished` after the terminal SSE status, not
because the launcher stayed alive.

The captured raw observer status query after completion returned an empty status
map while the SSE stream had already reported `idle`; the observer now retains
the correlated SSE idle status in its manifest instead of treating that empty
query as a replacement. This is an observed OpenCode server/API detail, not a
durable recovery guarantee. No second live experiment was run.

### Disconnect conclusion

This live run is evidence that, for this local server/provider configuration,
the accepted async task continued far enough for a later process to observe its
completion after the launcher exited. It does not prove behavior across server
restarts, network partitions, provider failures, or arbitrary OpenCode
versions. The PoC still has no durable detached-execution contract.

## Timeout and lifecycle boundaries

OpenCode run timeout calls `session.abort` when the installed SDK exposes it,
aborts the in-flight synchronous prompt request, records the cancellation
timestamp, and preserves partial raw events. SSE cleanup uses an
`AbortController`, async-generator return, and a bounded shutdown wait so the
command can exit. This is an observation PoC, not durable detached execution
or recovery.

OpenCode async launching is now implemented as a provider-specific PoC path.
The async launcher never starts/stops `opencode serve`, never subscribes to a
long-lived stream, and never marks a remote task terminal. The observer is the
separate inspection/recovery process. Cursor remains unchanged and its default
model is still `auto`.

## Reuse and production handoff

Reusable evidence for a future executor includes provider adapters around the
native Cursor/OpenCode calls, native ID capture before prompting, raw provider
event/message/part retention, explicit request/acceptance timestamps, and a
separate OpenCode observer process. The provider-specific request construction
and correlation helpers are useful adapter test seams.

Intentionally not reusable as production state are `ArtifactStore`,
`manifest.json`, `result.json`, JSONL event ordering, the `running` launch
artifact, and observer completion labels. The PoC artifact logger is diagnostic
evidence, not canonical state. It does not implement retries, leases,
recovery, workstream state, SQLite, tmux, server ownership, or a
provider-neutral runtime abstraction.

Recommended next production slices are, in order:

1. provider adapters first;
2. a durable `BatchExecutor` process second;
3. canonical AgENV state mapping third;
4. compatibility/default switching last.

## Future work: OpenCode V2 horizon

As of August 2026, V2 should be treated as a future compatibility target. The
public `@opencode-ai/client` beta provides `OpenCode.make`, typed resources,
async event streams, request cancellation, and optional Node service
management. Its API is explicitly unstable, and its exact behavior for
`promptAsync`, abort, status/history, terminal events, and recovery still
requires declaration and live verification.

The embedded `@opencode-ai/sdk-next` runtime is Effect-native and in-process,
but is currently private to the OpenCode workspace and unavailable as a normal
external dependency. This PoC does not use it.

The current V1/Cursor plan can accommodate V2 by keeping SDK types behind
provider adapters, separating transport from server ownership, using
provider-specific prompt builders, and making async continuation and cleanup
explicit capabilities. The canonical AgENV state and detached executor plan
do not need to change. For the initial `work supervise` integration, one
provider execution is an atomic attempt: a failed or lost attempt may be
replaced with a brand-new provider agent/session, without conversation-level
resume. The first production OpenCode path should use synchronous prompting
inside a detached executor; the PoC's async launcher/observer is optional
future evidence.

The manager should continue to invoke `work supervise` through the bash tool.
An OpenCode plugin tool may later be a thin facade over the same orchestration
path, but should not own provider SDK processes directly. See the architecture
document, [FINDINGS.md](./FINDINGS.md), and
[`docs/WORK_SUPERVISE_SDK_IMPLEMENTATION_PLAN.md`](../../docs/WORK_SUPERVISE_SDK_IMPLEMENTATION_PLAN.md)
for the detailed horizon and implementation plan. Before changing the default
command, the SDK path may be exposed as `work-sdk supervise`, reusing the same
supervision state and handoff logic.

## Cursor runtime diagnosis

The observed Cursor warnings for `.gitignore` and `.cursorignore` came from the
bundled SDK's internal ignore scanner trying to use ripgrep before its native
path had been configured. In installed `@cursor/sdk` 1.0.28, both public SDK
entries export `configureCursorSdk`, but neither exports
`configureRipgrepPath`; the bundled implementation contains that internal
function and reads `CURSOR_RIPGREP_PATH`. `src/cursor-runtime.ts` resolves the
installed platform binary and sets that environment input before
`Agent.create()`. See [FINDINGS.md](./FINDINGS.md) for the existing Cursor
observations.
