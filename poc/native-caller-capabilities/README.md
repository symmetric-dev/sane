# Native caller capability probes

Three opt-in, local evidence probes for C8. **Implemented, not executed or verified.**
No native caller enrollment, App handoff, completion detector, or production security
framework is included. Preparation only writes private files below this directory's
ignored `.local/`; loading/launching native tooling is a separate operator action.

## Files and prerequisites

- `cli.ts`: prepare temporary configs, launch an explicitly requested Claude CLI,
  print redacted evidence, add a clearly operator-authored observation marker.
- `claude-hook.ts`, `binding.ts`, `claude-mcp.ts`: native hook → single-use opaque
  bearer → stdio MCP evidence transport; optional bounded harmless wait.
- `opencode-plugin.ts`: argument-free native tool and selected managed-source comparison.
- `opencode-plugin/index.ts`: directory entrypoint re-exporting the probe; generated
  OpenCode configs reference this directory, not the implementation file.
- `observe.ts`: local CLI stream/process observation; never sends interrupts/kills.
- `evidence.ts`, `deps.ts`: private evidence files and installed-package resolution.

Requires the existing Bun installation and workspace packages. No install/build is
needed or performed. MCP resolves the installed SDK peer through the installed Claude
SDK package; OpenCode client resolves through `packages/sane-app/node_modules`.
These are resolution anchors only: no App implementation, config, credentials, or
SDK `query()` is imported. Missing packages are a prerequisite failure; do not use
an automatic dependency installer to make this probe run.

Source grounding inspected:

- `@opencode/plugin` 2.0.8: `dist/promise/plugin.d.ts`, `tool.d.ts`, and its
  `@opencode/schema/dist/tool.d.ts`. `caller.id` is the call ID; context supplies
  `sessionID`, `messageID`, `agent`. This version's tool context does not declare
  the newer documented `signal`, so the plugin does not assume it.
- `@opencode/plugin` 2.0.8 `dist/host.js`: local directory server entrypoints resolve
  `server`, then `index`; `opencode-plugin/index.ts` re-exports the existing default
  `Plugin.define` object. The installed managed runtime rejected a configured `.ts`
  file with `configured plugin path must be a directory`, despite file examples in
  the current unpinned loading guide. Keeping the implementation in place preserves
  its local imports and workspace dependency resolution.
- `@opencode/client` 2.0.18: Promise client/service exports and service implementation.
  Registration is `{id?, version?, url, pid, password?}`; `Service.discover({file})`
  performs health/registration checking, **does not start a service**, and
  `Service.headers(endpoint)` supplies the endpoint's Basic authentication.
  Neither `ensure` nor `stop` is called. Pattern matches the App's read-only discovery.
- `@anthropic-ai/claude-agent-sdk` 0.3.283 `sdk.d.ts`: BaseHookInput,
  StopHookInput, SDKSessionStateChangedMessage, SDKBackgroundTasksChangedMessage,
  SDKResultMessage and child/task message identities. SDK types do not establish
  the installed standalone CLI version or the messages that CLI actually emits.
- `@modelcontextprotocol/sdk` 1.30.1 exported Server/StdioServerTransport,
  ListToolsRequestSchema/CallToolRequestSchema and request-scoped ID/abort signal.
- Official, unpinned docs: [Claude hooks](https://code.claude.com/docs/en/hooks),
  [MCP](https://code.claude.com/docs/en/mcp),
  [CLI](https://code.claude.com/docs/en/cli-reference),
  [OpenCode plugins](https://opencode.ai/v2/docs/build/plugins),
  [plugin loading](https://opencode.ai/v2/docs/plugins),
  [client](https://opencode.ai/v2/docs/build/client),
  [configuration](https://opencode.ai/v2/docs/config).

## First operator commands: preparation only

From `/Users/beto/sane`:

```sh
bun poc/native-caller-capabilities/cli.ts prepare first
```

This first command renders absolute paths and does not import client/MCP packages,
read registrations, install hooks/plugins, contact services, or launch native tools.
Inspect `.local/first/claude-normal.json` and `mcp.json`. For OpenCode, prepare a
separate run with the **explicitly selected existing registration file**, not a
guessed default, App source ID, or endpoint string:

```sh
bun poc/native-caller-capabilities/cli.ts prepare oc-first /absolute/path/to/selected/service.json
```

Replace that placeholder. Do not print the registration file: it can contain a
password. The generated `oc-workspace/opencode.json` contains the path, not its
contents. Preparation refuses to overwrite a run directory. Every run can use a
fresh name; native scenarios intentionally reuse a directory only when comparing
concurrent calls. Native version queries, compilation, and all runtime checks are
left to the operator. If a CLI rejects a configured event, preserve that as a
compatibility gap; remove only that event from the temporary config for a narrower
follow-up, and do not interpret its absence as an empty signal.

## 1. Claude hook → MCP caller

Launch from a normal operator terminal (not a nested Claude process). Set `D` and
`CWD` explicitly; the latter is the checkout you want to observe:

```sh
export D=/Users/beto/sane/poc/native-caller-capabilities/.local/first
export CWD=/Users/beto/sane
printf '%s\n' 'Call native_probe capture once with wait_ms 0. Leave _invocation absent. Do nothing else.' | bun poc/native-caller-capabilities/cli.ts run "$D" "$CWD" normal
bun poc/native-caller-capabilities/cli.ts view "$D"
```

The launcher supplies temporary `--settings`, `--setting-sources ''`,
`--strict-mcp-config`, and `--mcp-config`; it does not edit live settings.
Managed policy can still apply. Print mode allows only this probe through the
`--allowedTools` permission flag (that flag does not hide other tools). The
operator prompt requests no other work. Native history/account usage still follows
the installed CLI's normal behavior. The PoC itself never reads or edits that history.

Expected **evidence to establish transport**, not a pre-claimed result:

1. `claude.hook` with `hook_event_name: PreToolUse`, native `session_id`, `cwd`,
   `tool_use_id`, plus `prompt_id`/`agent_id` where present.
2. `binding.issued` naming that hook event and a token fingerprint.
3. `mcp.binding` with the same fingerprint/hook event and `status: bound`.
   MCP JSON-RPC `requestID` is recorded separately; it is not called the native
   tool-use ID. The native ID comes only from the stored hook input.
4. Native PostToolUse and stream/turn evidence for the same session. Hook identity
   fields absent in native input stay `null`. Missing session/cwd/tool-use ID rejects
   with `identity-incomplete`; missing prompt or child ID stays an explicit limitation.

`PreToolUse.updatedInput` replaces the complete tool arguments with the normalized
wait parameter plus the opaque token. It does not auto-approve the tool. Each
token binds one native hook identity and payload, expires after five minutes,
and is atomically consumed via rename across MCP processes. Files are private,
and only token fingerprints are logged. Caller IDs provided by the model are
neither accepted nor used. `CLAUDE_ENV_FILE` is never used for identity.

### Negative and concurrent scenarios

Repeat the same prompt with final mode `missing`, then `tamper`:

```sh
printf '%s\n' 'Call native_probe capture once with wait_ms 0; do not retry errors.' | bun poc/native-caller-capabilities/cli.ts run "$D" "$CWD" missing
printf '%s\n' 'Call native_probe capture once with wait_ms 0; do not retry errors.' | bun poc/native-caller-capabilities/cli.ts run "$D" "$CWD" tamper
```

Expected: `missing` and `unknown-tampered-or-replayed`, respectively, with MCP
`isError: true`; tamper still has an issued fingerprint that does not match the
received one. No successful identity is returned on rejection. Errors from a
blocked tool, unavailable hook, missing MCP connection or permission denial are
**not** equivalent to observing the MCP rejection. Do not infer transport from
the model's narrative response.

Run the normal command simultaneously in two operator terminals using the same
`D`; request `wait_ms 1000` to overlap. Require distinct native session/tool-use
IDs, distinct fingerprints, and each accepted event resolving to its own hook
record. There is no mutable current-session slot. `launchID` is wrapper correlation
only and is never a native identity authority.

For child evidence, use interactive mode below and explicitly ask the native CLI
to create a child that invokes the probe. The PoC does not spawn children itself.
Compare `SubagentStart/Stop.agent_id`, child-launch `tool_response.agentId` when
available, the child's PreToolUse `agent_id`, and stream `parent_tool_use_id`.
**Claude agent_id is a child identifier, not a proven resumable conversation UUID.**
Absence can mean main-thread input or unsupported child evidence on that CLI.

### Binding limit

This proves native hook evidence transport under a trusted local hook/store and
honest harness. An MCP invocation has no independent native caller field against
which to verify a stolen token. The bearer can appear in native tool arguments/
transcripts, and a same-user process/model with filesystem access could mint,
steal or alter evidence. Atomic single-use and payload checks reject unknown,
replayed, expired and changed tokens; they do not solve theft-before-first-use or
a hostile same-user filesystem. No production anti-spoofing claim is made. If
the installed CLI ignores `updatedInput` for MCP, this question remains unresolved.

## 2. OpenCode plugin → selected managed source

After preparing `oc-first`, open a **new** native OpenCode session at the temporary
workspace using the operator's intended existing service connection:

```sh
opencode /Users/beto/sane/poc/native-caller-capabilities/.local/oc-first/oc-workspace
```

This is an operator launch, not something preparation executes. Use your already
configured native connection; ordinary CLI discovery may start a service if none
exists, so establish the intended existing connection before running this command.
The probe never starts/stops one. The temporary directory is deliberately a new
location, so it can load its explicit plugin without restarting a service or
editing global config. Native ancestor/global plugins can also load normally.

Ask: **“Call native_caller_probe once; do nothing else.”** Then view:

```sh
bun poc/native-caller-capabilities/cli.ts view /Users/beto/sane/poc/native-caller-capabilities/.local/oc-first
```

For a headless retry in that workspace:

```sh
cd /Users/beto/sane/poc/native-caller-capabilities/.local/oc-first/oc-workspace
opencode run 'Call native_caller_probe once; do nothing else. If unavailable, report that and stop.'
```

`opencode run` uses the current directory; it has no cwd flag. An already loaded
location may retain cached plugin state. To retry the directory packaging fix at a
fresh location without restarting the shared service, prepare a new run (from the
repository root) with the explicitly selected existing registration, then launch:

```sh
cd /Users/beto/sane
bun poc/native-caller-capabilities/cli.ts prepare oc-directory-retry /Users/beto/.local/state/opencode/service.json
cd /Users/beto/sane/poc/native-caller-capabilities/.local/oc-directory-retry/oc-workspace
opencode run 'Call native_caller_probe once; do nothing else. If unavailable, report that and stop.'
```

Choose another fresh run name if `oc-directory-retry` already exists. These commands
use ordinary managed-service discovery, so the intended current service must already
be available. Preparation and the packaging correction do not establish runtime
success; require an `opencode.caller` event from the operator's retry.

The argument-free tool records `caller.sessionID/messageID/id/agent`, gets that
actual session through plugin `ctx.session.get`, and records `location.directory`
and `parentID`. `ctx.location.directory` is recorded separately, never substituted
for the caller location. It then discovers only the selected registration,
authenticates with its own credentials, and fetches the same session there.

- `session-match-at-selected-endpoint`: session ID, directory and parent match,
  with registration unchanged across observation. **Not by itself host proof.**
- `exactHostProof: same-local-process-pid-and-healthy-registration`: additionally,
  the endpoint is loopback and the registered healthy service PID equals the
  executing plugin process PID.
  This is a narrow local-process observation, not cryptographic enrollment or a
  durable authority ID. PID reuse/TOCTOU is not solved by this PoC.
- `pidComparison: different`, `exactHostProof: unavailable`: a plugin worker may
  have its own PID; this does not automatically prove a different host.
- `session-mismatch`, `registration-changed`, `managed-unavailable`, or
  `unavailable-read-discovery-or-session-lookup`: no association established.
  Raw errors, URLs, passwords and authorization headers are never returned/logged.

Next scenarios: two independent native sessions; an explicitly requested native
child (require its own session ID and actual parent); and another freshly prepared
run pointing at a different existing registration. Expect mismatched/unavailable
evidence if the selected source cannot serve that caller. To demonstrate that a
matching endpoint alone is weaker than host proof, inspect any worker-PID case
or a separately selected endpoint that can serve the same session. Do not invent
such a topology if unavailable. A nonexistent registration is an available negative
case: prepare a fresh run with an absolute nonexistent file, then invoke its tool.

Browser selection, server cwd, global current-session state, and shell environment
are never used for caller identity. The installed shell hook has no guaranteed
session ID; it is not a substitute for `ToolContext`. This probe proves no domain
enrollment and creates no `{version,repository,source,authorityId,nativeId}` envelope.

## 3. External Claude completion observations

Normal and continued print turns:

```sh
printf '%s\n' 'Reply with DONE. Do not use tools.' | bun poc/native-caller-capabilities/cli.ts run "$D" "$CWD" normal
printf '%s\n' 'Reply with DONE. Do not use tools.' | bun poc/native-caller-capabilities/cli.ts run "$D" "$CWD" continue
```

`continue` registers a Stop hook that proposes `decision: block` when
`stop_hook_active === false`, requesting one more reply; the subsequent Stop
should carry `stop_hook_active: true`. `claude.stop-proposal` records only this
hook's proposal, **never an aggregate Stop decision**. Other hooks run in parallel
and the harness can override continuation. Require later native evidence, not the
proposal or a single Stop callback, to establish what actually happened.

Installed SDK types explicitly describe `system/session_state_changed: idle` as
an authoritative **turn-over** signal after held results flush and the background
agent loop exits. The observer captures it if standalone CLI stream-json emits it.
This is a supported SDK message shape; availability in ordinary CLI output and
unwrapped interactive sessions is **not established**. There is no post-all-Stop-
decisions hook in the inspected hook API. The PoC does not initialize an SDK control
channel or silently substitute SDK execution for the local CLI. If no state event
arrives, `stateEvents: 0` is an explicit gap, not proof of idleness.

The observer records redacted stream frames, native result subtype/error/stop reason,
task bookends and `background_tasks_changed` (IDs/types/ambient only), plus spawned
PID, OS exit code/signal and stream-close summary. No prompt/text/transcript or stderr
content is saved. Result text and hook stdout are dropped, including opaque tokens.
Task level signals have replacement semantics and their ordering relative to
bookends is unspecified; do not pair them by array position or timestamps. Missing
background arrays are `null`, different from observed `[]`. Scheduled wakeups at
Stop retain ID/recurring only, not cron prompt/command text.

### Interruption and background cases

```sh
bun poc/native-caller-capabilities/cli.ts run "$D" "$CWD" interactive
```

This inherits the terminal and captures hook/process evidence only (no machine
stream is available from the inherited interactive UI). Ask for probe capture with
`wait_ms 30000`, then press **Esc yourself** while it runs. Observe native UI state,
any failure/interrupt metadata, and the absence or presence of Stop. In a second
terminal you may mark the action:

```sh
bun poc/native-caller-capabilities/cli.ts mark "$D" operator-interrupt
```

That marker is explicitly operator evidence, not a native interrupt acknowledgement.
Stop is documented not to fire on user interruption; cancellation may also omit
PostToolUseFailure. A stream error, missing Stop, or OS signal cannot be silently
converted into successful completion. The wrapper sends no signals and does not
stop/kill user processes. Exit your own PoC session normally after observing it.

For background work, in a fresh interactive run ask for capture with
`wait_ms 150000` and allow the native MCP auto-background behavior if available.
Current docs describe main-thread interactive calls auto-backgrounding after two
minutes; subagent/print calls may behave differently and CLI versions vary. Inspect
Stop `background_tasks` and later tool completion/child/task hooks. Alternatively
explicitly ask the native CLI for a harmless background child and observe its
native start/stop evidence. Do not equate TaskCompleted (task tracking) with all
background execution having ended. For print-mode background experiments, explicitly
opt into native behavior per the installed CLI's docs; this PoC sets no automatic
background environment flags. Print runs capture task/state frames when emitted.

An `idle` turn signal, successful result and normal process exit each have different
scope. None alone proves all detached descendants, timers, remote jobs or future
scheduled work are finished. The probe emits **no completed boolean**. If needed
signals are absent, reconciliation remains unknown; do not start a same-checkout
handoff on quiet transcripts, elapsed waits, a single Stop or a process exit alone.

## Reading and removing evidence

Each record is atomically published as a private JSON file with event UUID,
producer UUID/sequence, host monotonic observation time and wall clock. `view`
sorts monotonic observations on this host; this is not a global native causal order.
Within one stream use producer sequence; across hooks/MCP use explicit hook event,
session, prompt, tool-use and fingerprint joins. Simultaneous hooks can finish in
a different order from invocation. An interrupted writer can leave `.pending`;
the viewer ignores it, so missing evidence stays unknown. Do not merge records
across machines/reboots and treat their monotonic clocks as comparable.

All generated configs, bindings (including consumed mappings), and redacted events
live in the exact prepared run directory. Review events before sharing: native UUIDs,
paths and process IDs are intentionally retained. Never publish native transcripts
or registration files to supplement them indiscriminately.

Teardown: exit only the PoC sessions you explicitly opened through their normal UI;
wait for your probe's bounded waits to finish. Remove only the generated
`oc-workspace/opencode.json` for that run to remove its location-scoped plugin
configuration (native watched config should unload it; if not, leave the location
unused rather than restarting the shared service). Claude's settings/MCP flags end
with that launched session. No global hook/plugin/MCP registration was installed.
After saving desired redacted events, delete **only** the exact `.local/first` and/or
`.local/oc-first` run folders you prepared, using Finder or individually reviewed
paths. Do not delete native service registrations, global settings, native histories,
other PoCs, or broadly clear `.local` while another run may be active.
