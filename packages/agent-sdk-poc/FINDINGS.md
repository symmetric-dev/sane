# Cursor/OpenCode SDK PoC findings

## Runtime and package

- Package dependency: `@cursor/sdk` `^1.0.28`; the installed lockfile version
  is `1.0.28`.
- Bun runner: `@cursor/sdk/bundled`, executed by Bun `1.3.12` in this checkout.
  This remains the tested live path.
- Node compatibility: Cursor documents Node `>=22.13`. `npm`/Node projects
  should import the regular `@cursor/sdk` entry. The package includes
  `probe:node`, which imports that entry and checks its public exports without
  credentials or an agent call. It is run with Node's TypeScript stripping
  support (`node --experimental-strip-types ...`) and is not a live test.
- The bundled entry has the same public API but is the intended self-contained
  entry for the Bun PoC. OpenCode support is provider-specific and remains
  isolated from SQLite, tmux, workstream integration, and production runtime
  abstractions.

## OpenCode SDK Slice 3 inspection

- Direct dependency: `@opencode-ai/sdk` `^1.18.18`; Bun installed `1.18.18`.
- The installed SDK exports `createOpencodeClient` and generated methods for
  `session.create`, `session.get`, `session.status`, `session.messages`,
  `session.prompt`, `session.promptAsync`, `session.abort`, and
  `event.subscribe`.
- The generated client defaults to fields-style response envelopes containing
  `data`, `error`, and `response`. Prompt input is a `parts` array containing a
  text part, with an optional `{ providerID, modelID }` model object.
- `event.subscribe` returns an async SSE stream and accepts `signal` plus
  `sseMaxRetryAttempts`. The generated client does not expose a close/release
  method, so the PoC aborts/returns the stream and does not call server startup,
  shutdown, or instance disposal APIs.
- OpenCode's generated event payloads use `sessionID`/`messageID`; the artifact
  correlation layer accepts those and `sessionId`/`messageId` variants while
  retaining the original raw payload.

The installed v1 client declarations also expose `session.promptAsync`, which
maps to `POST /session/{id}/prompt_async`. Its request body accepts `parts`, an
optional `{ providerID, modelID }` model, and other native OpenCode fields. Its
declared successful response is HTTP 204 with `void` data. In the fields-style
runtime envelope used here, the raw response contains `data`, `error`, and a
Fetch response object; the diagnostic JSON representation of the latter is
not a useful status source, so the launcher records the HTTP status separately.

The async launcher is provider-specific. It creates a native session, awaits
the manifest write containing `sessionId`, calls `promptAsync`, records raw
request/response events and timestamps, writes a `running` launch artifact, and
returns without calling `event.subscribe()`. A separate observer is required
for terminal status.

## Final command reference

From the repository root:

```bash
# Cursor keeps its existing auto default.
CURSOR_API_KEY=... bun run --cwd packages/agent-sdk-poc run -- \
  cursor run --prompt "Summarize this directory" --cwd "$PWD" --model auto \
  --run-dir "$PWD/.tmp/agent-sdk-poc/manual-cursor-run" --timeout-ms 120000

# OpenCode synchronous run.
bun run --cwd packages/agent-sdk-poc run -- \
  opencode run --server http://127.0.0.1:4096 \
  --prompt "Respond exactly TEST COMPLETED" --cwd "$PWD" \
  --run-dir "$PWD/.tmp/agent-sdk-poc/manual-opencode-run" --timeout-ms 120000

# OpenCode async launch, followed by a separate observer using the printed ID.
bun run --cwd packages/agent-sdk-poc run -- \
  opencode async --server http://127.0.0.1:4096 \
  --prompt 'Use the shell tool to run `sleep 5`. After it finishes, respond exactly SDK POC ASYNC LIVE.' \
  --cwd "$PWD" --run-dir "$PWD/.tmp/agent-sdk-poc/manual-opencode-async-launch"
bun run --cwd packages/agent-sdk-poc run -- \
  opencode observe --server http://127.0.0.1:4096 --session <id> \
  --cwd "$PWD" --run-dir "$PWD/.tmp/agent-sdk-poc/manual-opencode-async-observer" \
  --timeout-ms 30000
```

The server is started separately with `opencode serve`; the PoC does not start
or stop it. OpenCode model selection is optional and uses `provider/model`;
Cursor's `auto` is not an OpenCode model value.

## Slice 3 live verification

One opt-in synchronous OpenCode smoke test was run successfully against the
local server at `http://127.0.0.1:4096`:

- native session ID and assistant message ID were captured;
- the SSE observer captured `server.connected`, session updates, status events,
  message parts, and the final assistant response;
- the run completed with status `finished` in approximately four seconds;
- no tool calls were requested by the prompt;
- the live test cleaned up its temporary workspace and artifacts afterward.

The default test suite remains provider-free; this live smoke test is opt-in.

## Slice 4 async/disconnect observations

### Unit/fake observations

The async fake verifies all of the following without a server or credentials:

- the request is `{ path: { id }, query: { directory }, body: { parts, model? } }`;
- the native session ID is present in `manifest.json` while `promptAsync` is
  executing, before the request is sent;
- HTTP 204 is treated as accepted and stored with request-start,
  request-complete, and acceptance timestamps;
- `result.json` remains `status: "running"`, includes `observerRequired: true`,
  and contains no terminal result;
- the async path never subscribes to SSE;
- observer correlation retains other-session SSE as `sse_filtered`, prints only
  the requested session, and associates the session's idle event with the
  final status.

These are fake/unit observations only and do not establish OpenCode server
behavior.

### Manual/CLI observations

The no-provider CLI help/manual workflow was checked separately. It exposes the
async launcher and observer as separate commands, preserves Cursor's `auto`
default, and requires `provider/model` only when an OpenCode model is supplied.
Those are command-shape observations only; they are not evidence that a server
accepted or continued a task.

### One live observation

On 2026-08-17, the local health endpoint returned `{"healthy":true,"version":"1.18.18"}`.
One live experiment was run, and no additional live experiment was run. The
launcher command used the local server and the deterministic prompt:

```text
Use the shell tool to run `sleep 5`. After it finishes, respond exactly SDK POC ASYNC LIVE.
```

The launcher received HTTP 204, printed a native session ID and launch artifact
path, and exited with its launch manifest still `status: "running"`. Its raw
artifact contained `session_created`, `prompt_async_request`, and
`prompt_async_response` events. A separate observer process then attached with
the persisted ID. It captured raw SSE `server.connected`, `message.part.updated`
tool events for `bash`/`sleep 5`, message and part updates, the exact fixed
response, and a correlated `session.status` event with `{ "type": "idle" }`.
The observer finished after that terminal status and did not abort the remote
session.

The first live observer artifact's final status query returned an empty status
map after the SSE idle event, so that pre-fix artifact retained the earlier
`busy` status even though raw SSE proved `idle`. The implementation now updates
the manifest from correlated SSE status events and does not replace an observed
terminal status with an empty later map. This is an exact live observation of
the server's status API, not a claim that every OpenCode version behaves the
same way.

### Disconnect conclusion and limits

For this server/provider configuration, the separate observer saw the accepted
task continue and complete after the launcher process exited. That is evidence
of this async/disconnect path, not a durable execution guarantee. Server
restart, network loss, provider failure, and arbitrary SDK/server versions were
not tested. The PoC does not own `opencode serve`, implement retries or leases,
or provide durable recovery.

## Native binary and ripgrep path

The installed platform package is `@cursor/sdk-darwin-arm64@1.0.28` on this
checkout and contains `bin/rg`. The PoC resolves that binary from the package
layout and sets the absolute path in `CURSOR_RIPGREP_PATH` before local agent
creation. A caller-supplied valid absolute/relative path is normalized and
retained; an executable `rg` on `PATH` is the final fallback.

The public declaration files expose `configureCursorSdk` / `Cursor.configure`
for local-store and workspace-scan-cache settings, but do **not** expose
`configureRipgrepPath`. The function exists in the bundled implementation's
internal shell-exec module. The PoC therefore does not deep-import an
unexported module: it uses the SDK's environment input and records
`publicRipgrepConfigurator: false` in diagnostics. If no executable can be
resolved, the artifact says `ripgrepWarningStatus: "unavailable"`; stderr is
preserved in `stderr.log` so a future SDK/package fix is observable.

This addresses the warning's cause rather than filtering the messages:

```text
Error initializing ignore mapping for .gitignore:
error: Ripgrep path not configured. Call configureRipgrepPath() at startup.
```

The same initialization path covers `.cursorignore`. The startup diagnostic is
also written as a raw `runtime_diagnostics` event and a human-readable stdout
line in every Cursor artifact.

## Live probe coverage

`tests/cursor-live.test.ts` is gated by both `SDK_POC_CURSOR_E2E=1` and
`CURSOR_API_KEY`. It uses temporary directories and the runner disposes each
agent handle. The suite covers exact completion, file creation plus raw
`tool_call` events, `sleep 5`, bounded cancellation of `sleep 60`, and two
concurrent runs whose events are checked against both `agent_id` and `run_id`.

The setup phase is intentionally still not bounded: the runner timeout starts
after `agent.send()` returns. This is a known PoC limitation, not durable
recovery behavior.

## Reuse boundary and production handoff

Reusable PoC material for a future work-supervise executor is limited to
provider adapters, native ID capture, provider request construction, raw
message/part/SSE preservation, and the observation evidence that a separate
OpenCode process can correlate a session after an async launcher exits.

The PoC `ArtifactStore`, manifest, result file, JSONL ordering, and observer
labels are intentionally not production state. The PoC artifact logger is
diagnostic evidence, not canonical state. Nothing in this package changes
`work supervise`, `work multi`, workstream state, tmux, SQLite, or production
executor code, and it does not finalize a provider-neutral runtime.

Recommended next production slices, in order, are: provider adapters first; a
durable `BatchExecutor` process second; canonical AgENV state mapping third;
compatibility/default switching last.

## Future work: OpenCode V2 horizon

As of August 2026, the public V2 network client is available as the beta
`@opencode-ai/client` package. It uses `OpenCode.make({ baseUrl })`, typed
resource methods, async event iterables, request `AbortSignal`s, and optional
Node service management through `Service.discover()`, `Service.ensure()`, and
`Service.stop()`.

The beta API is not stable. Before using it for production execution, verify
the installed declarations and live behavior for `promptAsync`, abort and
timeout semantics, status/history inspection, terminal event correlation,
service lifecycle, and restart/recovery. The V2 documentation examples alone
do not establish parity with the V1 PoC or its observed async/disconnect
behavior.

The embedded V2 runtime, `@opencode-ai/sdk-next`, is Effect-native and scoped,
but is currently private to the OpenCode workspace and is not published for
normal external installation. It should not be added as an AgENV dependency
yet.

The current Cursor and OpenCode V1 plan remains compatible with V2 if SDK types
stay inside provider adapters. The future runtime should separate transport
from server ownership, use provider-specific prompt builders, expose
abortable event streams and explicit cleanup, and treat asynchronous
continuation as an optional capability. The canonical AgENV state model,
native-ID persistence, detached executor, and tmux compatibility plan do not
need to change. The first production integration treats one provider execution
as one atomic attempt. A failed or lost attempt can use a fresh provider
agent/session; conversation-level resume is not required.

The initial OpenCode production path should use synchronous prompting while a
detached executor remains alive. The PoC `promptAsync` launcher/observer is
optional future evidence, not a prerequisite for the executor. The manager
should continue to call `work supervise` through the bash tool; a future
OpenCode plugin tool should remain a thin facade over the same orchestration
path. Before changing the default command, an experimental `work-sdk supervise`
entry point can select the SDK backend while reusing the same persisted
supervision state and handoff logic.

The recommended future sequence is an isolated V2 client spike, followed by a
feature-flagged versioned V2 adapter after the required operations are verified.
An embedded adapter should wait until `sdk-next` is externally installable and
its Effect lifecycle is suitable for the executor.

The detailed production implementation sequence is documented in
[`docs/WORK_SUPERVISE_SDK_IMPLEMENTATION_PLAN.md`](../../docs/WORK_SUPERVISE_SDK_IMPLEMENTATION_PLAN.md).
