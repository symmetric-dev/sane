# Local Claude Code / OpenCode Web Bridge

Accepted historical PoC, relocated from `poc-cc-web/` to `poc/cc-web/`.
Active development and operation use `packages/sane-app`; see the
[App documentation](../../docs/sane-app/README.md) and
[ongoing work](../../docs/sane-app/ongoing/README.md).

A single-user React chat interface for Claude Code and OpenCode V2. Bun hosts the
frontend. CC starts a one-shot `claude -p` process per prompt and uses `--resume`
for follow-ups. OC connects to an existing V2 server over HTTP. The bridge uses no
Anthropic SDK or web API and never reads subscription credentials.

See [ARCHITECTURE.md](ARCHITECTURE.md) for server-owned persistence, cross-device
behavior, harness lifecycles, scope boundaries, and the Code/Git workspace surface.

See [HUMAN-OPERATOR-GUIDE.md](HUMAN-OPERATOR-GUIDE.md) for installation, the managed
OpenCode/Tailscale launch sequence, recovery guidance, and future startup automation.
This is a working PoC, not a hardened product. The owner reports both integrations
working; that baseline does not establish all failure/recovery cases. See
[LIMITS.md](LIMITS.md) for the evidence boundary and improvement suggestions.
The owner also reports the prior workspace baseline working. The current navigation
revision and new Terminal implementation remain unverified; that report does not
establish their behavior. Terminal backend integration is being completed.

## Prerequisites

- Bun and a directory you intend the selected harness to operate in.
- Native `git` installed on the bridge host and available on its PATH for Git Diff.
- For CC: the installed `claude` executable, signed in through its normal
  subscription login flow.
- For OC: a running OpenCode V2 managed service for the bridge's OS user, with
  models configured. The default discovers its URL and authentication through
  `@opencode/client/service`; no token environment variable is needed.

The owner reports native Bun **1.4.2** on macOS. Native PTY support uses
`Bun.Terminal`, documented from Bun **1.3.5** on macOS/Linux; that documented
minimum and reported runtime are not a terminal compatibility result. The lockfile includes React 19,
`@assistant-ui/react` 0.15.22, React Markdown, and GFM rendering. The bridge server
uses Bun APIs; frontend packages are bundled locally, without a CDN or AI SDK.

The bridge runs with your OS permissions and the CLI's configured permissions.
Only submit prompts and directories you intend it to use. The browser password,
when enabled, belongs to this bridge, not to your Anthropic account.

No implementation agent has run Claude Code. The owner performs live verification;
record the tested version and observations in [LIMITS.md](LIMITS.md).

For your manual preflight, `claude auth status --text` should report your existing
subscription login. Record only the authentication mode, not account identifiers
or credentials. If it reports API/provider authentication instead, correct that
through your normal CLI setup before testing the bridge. The bridge does not
offer a Claude login UI or accept Anthropic credentials.

## Install and run

These are manual commands for the human operator. From this directory:

```sh
bun install --ignore-scripts
bun run start
```

Open **http://127.0.0.1:8787** (use that exact hostname). The server starts no
Claude process until you submit a prompt. It defaults to this shell's working
directory for API callers without a selected worktree; the workspace-first UI uses
the selected worktree root for new conversations. Set the server default with:

```sh
bun run start --cwd /absolute/path/to/project
```

`bun run start` first runs `build.ts` through Bun's JavaScript build API, writing
`public/assets/app.js` and `public/assets/app.css`, then launches `server.ts`.
The static document is `public/index.html`. The server must serve `/`,
`/assets/app.js`, and `/assets/app.css` with appropriate content types. Assets are
generated and ignored by Git. To build separately, use `bun run build`.

## Chat workspace

In Chat, history lives in the contextual sidebar (a drawer on small screens). The selected conversation
and workspace navigation are restored from the backend owner bookmark; text,
model, effort, and launch-directory drafts are kept
per conversation in memory until reload or sign-out. Start a new conversation with
**New conversation** in a selected worktree; optionally choose a subdirectory in
**Details** before sending. History is grouped by workspace with a worktree filter.
Messages use safe GFM Markdown with code-copy controls. Tool calls expand inline;
the details drawer contains run/session IDs, requested and observed settings,
usage snapshots, hooks, and original raw events. Raw HTML and remote Markdown
images are not rendered.

The frontend uses `useExternalStoreRuntime`: backend event history remains the
source of truth. `frontend/types.ts` defines harness-neutral conversation, run,
message, usage, capability, and client contracts. `cc-client.ts` adapts same-origin
HTTP, `cc-reducer.ts` projects CC evidence, and `store.ts` owns reconnecting polling,
run-local sequence deduplication, selection/authentication fencing, and drafts.
OpenCode shares the app-owned catalog and event history using native message
snapshots. Choose a harness for a new conversation; existing conversations keep
their harness and launch directory. The owner reports both installed integrations working.

Bridge-reported availability controls sending, including activity in another
conversation or browser. You can keep drafting while a run is active. Failed
submission requests are never automatically retried: if acceptance is ambiguous,
check history before resending. Output appears as recorded messages arrive;
token-by-token streaming is not promised. Editing, regeneration, attachments, and
free-form mid-run steering are unsupported. Actions depend on the harness:

| Capability | Claude Code | OpenCode V2 |
| --- | --- | --- |
| Model / reasoning | CLI model ID and five effort levels | Enabled server models and exact native variants |
| Permission / question replies | Unsupported; hooks are observational | Native permission decisions and typed form answers |
| Cancel | Unsupported in one-shot UI | Interrupt the app's active native session |

OC permission decisions are allow once, always allow, and reject. Forms retain
native field types, options, and conditional constraints. Cancellation requests an
interrupt; native reconciliation, not HTTP acceptance, settles the run. The bridge
never automatically grants permissions or answers forms.

## Code and Git Diff workspace

Global **Chat / Code / Git / Terminal** navigation lives in the sidebar footer and mobile
drawer footer. Workspace/worktree context stays in the topbar, compact on mobile.
The topbar **Application menu** shows connection status/details, **Reconnect**, and
**Sign out** when password authentication is enabled; sign-out confirms discarding
dirty editor buffers. Each view takes over the shell's single
header and main content area; Code and Git use edge-to-edge editor/diff content.
Chat remains mounted and observing activity while hidden, with a running or
pending-interaction indicator in navigation.

Use the topbar workspace button to select a workspace in a modal searchable by
name or path. Its secondary **Open directory…** action opens a directory-path
subflow to register an absolute path on the bridge host. The worktree button opens
the **Browsing worktree** selector. No conversation is required to open files.
For Git, a subdirectory resolves to its closest repository/worktree root; Code and
Git cover that full worktree, even when a conversation launches in a subdirectory.
One repository workspace groups its main and linked worktrees, including worktrees
outside the main checkout. Canonical Git common-directory identity groups them;
names, branches, and directory nesting do not. A confirmed non-Git directory opens
as an explicit directory workspace; Git discovery/permission/operational failures
are errors, not a reason to silently fall back to a folder.

Use **Refresh worktrees** in either context dialog to refresh native discovery
without changing the current navigation selection. This registers existing trees;
there is no worktree creation, pruning, repair, or
conversation-reassociation API. Conversations retain their original harness,
launch cwd, and workspace/worktree association regardless of browsing selection.
When browsing differs from the selected conversation's execution context, **Runs
in:** identifies its execution worktree; **Browse execution worktree** returns to
that scope (or **Execution details** opens diagnostics when association IDs are absent).

Code replaces conversation history with a lazy **Files** directory tree; Git
replaces it with a **Staged / Unstaged / Untracked** directory tree. The mobile
drawer shows the same contextual tree, sharing expansion and selection with the
desktop sidebar; activating a file closes the drawer. Both trees use
`@headless-tree/core` and `@headless-tree/react`, pinned to **1.7.0**.
CodeMirror 6 provides
editing and unified read-only diffs in the same warm-light palette as Chat.
Semantic theme variables allow future palettes, but no theme configuration exists.

- Edit existing writable UTF-8 regular files up to **256 KiB**. Symlinks and
  hard-linked files are unsupported; `.git` and bridge data paths are excluded.
  Binary, invalid UTF-8, oversized, mixed-line-ending, and non-writable files cannot
  be edited. Saves preserve a UTF-8 BOM and uniform LF/CRLF/CR convention.
- **File actions** in the topbar opens a dialog with **Save**, **Compare disk**, and
  **Reload**, plus change navigation when comparing text. Git's **Change actions**
  offers change navigation and **Open in Code** when eligible.
- Save explicitly with **File actions → Save** or **⌘S / Ctrl+S**. Raw-byte revision checks reject
  stale saves, and bridge writes are serialized per path. This is optimistic
  conflict detection, not atomic exclusion of native editors or agent writes.
- Buffers, undo state, and local edits remain in browser memory across view, file,
  worktree, and conversation switches; conversations using the same canonical root share
  buffers. They do not survive browser reload or move between devices. **Reload**
  from disk and explicit sign-out ask for confirmation; do not rely on a browser
  page-reload warning. **Compare disk** compares saved text with the local buffer.
- Git Diff groups **Staged** (HEAD → index), **Unstaged** (index → saved working
  tree), and **Untracked** (empty → saved working tree). Unsaved editor text is
  excluded. Unified before/after text includes change navigation and collapsed
  unchanged regions. Mode metadata, renames, and unsupported-content reasons are
  shown where available. There is no staging, discard, commit, or conflict resolver.
- **Open in Code** opens an eligible Git selection and navigates directly to Code.
  The selected file and Git view refresh while visible, on focus, and approximately
  every five seconds. Clean file buffers may refresh automatically; dirty buffers
  retain local changes and report a changed disk revision.

See [LIMITS.md](LIMITS.md) for bounded listings, unsupported Git cases, and the
remaining owner-verification work. Workspace operations use the bridge filesystem
service, independently of the selected chat harness.
One shared workspace provider owns request scope and polling; Code and Git share
one selected path per canonical root. External chat-to-file/line navigation is a
future integration seam only: file links, reference parsing, and line/range reveal
are not implemented.

## Worktree Terminal — implementation unverified

**Terminal** is a full xterm.js view in the shared shell, using the same warm-light
palette. There is one server-owned terminal per selected worktree, shared across
conversations and the same owner's devices. **Start terminal** explicitly starts
an interactive shell at that worktree root; selecting or viewing a worktree never
starts one. **Restart terminal** replaces an exited/closed terminal explicitly;
**Close terminal** stops the shared shell for all viewers. No automatic restart occurs.

**Started in:** identifies the initial worktree, not the shell's current cwd.
Shell navigation is independent of Chat, Code, Git, and later browsing selection.
The terminal does not consume the CC/OC execution slot or attach to a harness run.

Attachments begin as viewers. Choose **Use keyboard here**, or **Take control here**
when another attachment controls the shell. Only that controller can send input,
Ctrl C, or resize the shared PTY. **Release keyboard**, leaving the view/changing
worktrees, hiding the page, disconnecting, or signing out releases control.
Reconnect restores viewing without claiming control or replaying input.
Mobile controls include **Keyboard**, **Ctrl C**, **Esc**, **Tab**, and arrow keys;
viewers retain the shared screen size and can scroll rather than resizing it.

The shell and bounded screen state survive view switches and browser reloads or
disconnects while the bridge remains alive. They are memory-only: bridge shutdown,
restart, or crash does not preserve a reattachable terminal. Reconnect uses a
bounded screen/scrollback snapshot followed by ordered, acknowledged output and
resize messages, not an unlimited transcript. Slow attachments reconnect from a
fresh snapshot. Cleanup of shell jobs is best-effort; detached/reparented jobs are
not guaranteed to stop.

The terminal transport uses the existing same-origin bridge WebSocket route and
bridge authentication policy, with an exact configured `Origin` check before
upgrade. Password-mode sockets are tied to the bridge login and revoked on logout.
The existing Tailscale HTTPS mapping carries WSS on the same port; no new listener
or tunnel route is needed. This new implementation awaits owner manual review,
including backend integration, screen restoration, control handoff, and physical
mobile behavior. See [LIMITS.md](LIMITS.md) and [terminal research](TERMINAL-RESEARCH.md).

## Server options

Options:

| Option | Default / meaning |
| --- | --- |
| `--host` | `127.0.0.1` |
| `--port` | `8787` |
| `--cwd` | Shell working directory; default launch directory for new sessions |
| `--data-dir` | `poc/cc-web/.data`; local metadata, logs and generated hook settings |
| `--claude-bin` | `claude`; explicit executable path for a non-PATH installation |
| `--opencode-url` | Omitted: discover the running managed service. Supplied: use only this explicit V2 server URL and optional `OPENCODE_TOKEN` bearer auth |
| `--public-origin` | Exact browser origin; by default `http://127.0.0.1:8787` |
| `--allow-remote` | Explicit opt-in for a non-loopback bind; requires password and HTTPS public origin |
| `--reconcile-interrupted` | Operator confirmation that surviving processes have stopped; see recovery below |

Set `CC_WEB_PASSWORD` in the server's environment to enable the bridge login.
Keep its value out of checked-in files and command histories. For example, in zsh:

```sh
read -rs 'CC_WEB_PASSWORD?Bridge password: '
export CC_WEB_PASSWORD
bun run start
```

### OpenCode connection and authentication

For the default managed connection, start the service yourself under the same OS
user and home/XDG environment as the bridge:

```sh
opencode service start
bun run start
```

The bridge lazily calls `Service.discover()` and uses `Service.headers(endpoint)`
for that exact endpoint. `OPENCODE_TOKEN` is ignored in managed mode. The bridge
never calls `Service.ensure()`, starts/stops the service, or invokes the OC CLI.
An unavailable service does not prevent CC startup or access to recorded history.

For a separately managed foreground server, start it yourself in another terminal:

```sh
opencode serve
```

Then explicitly pass its actual listening URL (4096 is an example, not a discovery
fallback):

```sh
bun run start --opencode-url http://127.0.0.1:4096
```

An explicit URL bypasses managed discovery entirely. If that endpoint accepts
bearer authentication, supply its token in the bridge server's `OPENCODE_TOKEN`
environment variable. This mode sends `Authorization: Bearer …`; it does not
translate tokens to Basic auth or reuse managed-service credentials, even if the
URL happens to match the managed service. For a managed service requiring its
SDK-provided authentication, omit `--opencode-url` instead. Keep tokens out of
command histories and checked-in files. Auth headers remain server-side and are
never logged, persisted, or forwarded to the browser or Claude child process.

Concurrent discovery is deduplicated; successful endpoints are cached for five
seconds, and failed discovery has a one-second cooldown. Connection, auth, server,
or JSON-response failures invalidate the matching cached endpoint so a later
request rediscovers its URL and credentials together. Requests are never replayed
automatically, including mutations. Managed restarts/credential rotation can
therefore cause a transient unavailable result; ongoing observation retries through
normal polling. Recovery requires the same native OC storage, not merely a newly
reachable service.

Sources: [V2 client/service API](https://opencode.ai/v2/docs/build/client),
[managed service commands](https://opencode.ai/v2/docs/troubleshooting), and
[CLI connection modes](https://opencode.ai/v2/docs/cli).

For a local HTTPS tunnel, configure its exact origin while retaining loopback:

```sh
bun run start --public-origin https://your-private-bridge.example
```

Enable `CC_WEB_PASSWORD` first and configure your tunnel's own authentication.
A same-machine proxy may preserve the browser's `Host` or rewrite it to
`localhost:<listen-port>`, `127.0.0.1:<listen-port>`, or `[::1]:<listen-port>`.
The latter authorities are accepted only from loopback peers on a loopback-bound
server with an explicitly configured public origin. Forwarded headers are not
used to establish trust. Non-loopback binding additionally requires:

```sh
bun run start --host 0.0.0.0 --allow-remote --public-origin https://your-private-bridge.example
```

For SSH forwarding on a different client port, explicitly configure the browser
origin, for example `--public-origin http://127.0.0.1:18787`, then forward
`127.0.0.1:18787` to the host's `127.0.0.1:8787`. `localhost` and `127.0.0.1` are
different origins: use the exact printed URL. One public browser origin is
supported per server instance.

### Your Tailscale Serve setup

For `https://server.gecko-halibut.ts.net:18879/` proxying to
`http://localhost:18879`, run this from `poc/cc-web/`:

```sh
bun run start --host 127.0.0.1 --port 18879 \
  --public-origin https://server.gecko-halibut.ts.net:18879
```

Keep your existing Tailscale Serve command running and open the HTTPS URL above.
Tailscale terminates TLS; the bridge stays on loopback HTTP. Set `CC_WEB_PASSWORD`
before starting if you want the bridge's password login in addition to your
authenticated tailnet access. No `--allow-remote` flag is needed. Login cookies
use `Secure` for this HTTPS public origin, and browser requests use relative API
URLs, so there is no mixed-content connection. The separate hook listener remains
local and does not need a Tailscale route.

This same launch discovers the running managed OC service automatically. For a
separate foreground server, add `--opencode-url` even if it uses port 4096, with
that endpoint's bearer token if required. The browser still uses the bridge's
same-origin API; no separate OC tunnel route is needed.

The startup check rejects API/provider override environment variables rather than
silently using them. It reports variable names only; remove conflicting overrides
from the bridge's launch environment. It cannot certify your installed CLI's
authentication configuration; use the manual preflight above.

## Per-turn model, effort, and usage

### OpenCode

Models come from the enabled-model catalog for the launch directory. IDs use
`provider/model`; the effort field carries the exact native variant ID, not CC's
fixed effort list. Omit both to retain native defaults/current selection. A new
conversation needs a model when selecting a variant. Choices are applied through
native session model selection. Message snapshots retain cost/token fields when
provided, without subscription usage, quota estimates, or cross-run sums.

### Claude Code

Before each prompt, choose `sonnet`, `opus`, or `haiku` from the model suggestions,
or type a custom model ID. Effort offers `low`, `medium`, `high`, `xhigh`, and
`max`. Blank model/default effort omits the corresponding flag, letting the CLI
resolve its settings and resumed conversation defaults. Choices stay visible for
the next send and can be changed independently on every turn.

Each request passes optional `--model` and `--effort` arguments to that run's
process, for both new sessions and resume. The bridge does not write these into
global settings. Requested values are saved on the run; old history without them
still loads. Model IDs are limited to 200 characters, begin with a letter/digit,
and otherwise accept letters, digits, `.`, `_`, `:`, `/`, `[` , `]`, and `-`.
The CLI determines model availability and supported effort levels. A request is
not proof it took effect: run history separately shows the `system/init` model
and observed main-session hook `effort.level`, when provided. Subagent effort
stays in its own raw/hook event and is not presented as the primary effort.
`ultracode` is a documented CLI workflow shortcut, not a separate effort level;
this selector exposes the five reasoning levels only.

Session usage is derived entirely from the existing recorded events, including
after reload. Each run shows its first unique, associated terminal result
(success or error), with input/output/cache-read/cache-write tokens, estimated
USD, duration/API duration, CLI turn count, and per-model token/cost breakdown.
Missing or malformed numbers are **Unavailable**, not zero. Additional distinct
terminal results are flagged and retained in raw history, not added together.
The session panel shows the latest available result snapshot and identifies when
it belongs to an earlier run. Main-loop usage excludes subagents; `modelUsage`
includes query-pipeline subagents/internal calls but excludes auxiliary calls
outside that pipeline. Error results may be partial or zeroed by the CLI.

**There are no cross-run usage sums.** Current documentation says resumed
`total_cost_usd` and `modelUsage` restore earlier session totals starting with
Claude Code v2.1.277; earlier versions reset them for each invocation. The panel
therefore labels all values as reported snapshots instead of guessing the
installed version's accounting behavior. USD is a client-side estimate, not a
subscription bill or a measure of remaining subscription capacity.

Subscription/account usage, quota projections, rate-limit panels, and links to
provider usage pages are outside this chat migration's scope. Any received
`rate_limit_event` remains available as an original raw event in diagnostics.
There is no status-line forwarder, account-page scraping, extra prompt, private
API request, or credential read to collect usage.

## Claude Code hook setup and removal

No global Claude settings changes are needed. For each run the server writes a
local `.data/<runId>.settings.json` and passes it through documented `--settings`.
The command-hook forwarder reads JSON on stdin and posts to an additional
ephemeral **127.0.0.1-only hook listener** in the same Bun process. The browser
port is not the hook port. No extra tunnel forwarding is needed.

[`hooks/settings.example.json`](hooks/settings.example.json) shows the generated
configuration shape. Its absolute paths are placeholders; do not install it as-is.
The runtime substitutes actual, shell-quoted Bun and forwarder paths. The child
inherits `CC_WEB_HOOK_URL`, `CC_WEB_RUN_ID`, and a per-run `CC_WEB_HOOK_SECRET`.
These are bridge correlation values, not Anthropic credentials. The forwarder
does nothing outside a bridge-launched environment, produces no decision output,
and times out rather than holding Claude indefinitely.

Generated hooks merge with your usual effective settings. Existing hooks and
managed policy still apply. Stopping the bridge removes the receiver; no hooks
were installed into user or project settings. Delete the local data directory
only if you intend to discard the bridge's session index and output history.

## Restart and recovery

The backend keeps repository/worktree identities in `catalog.json` and an
independent owner navigation bookmark in `navigation.json`, alongside run/session
`metadata.json` and event logs. There is one implicit owner. The bookmark restores
workspace, worktree, conversation, view, file, and Git comparison on another visit
or device; it does not force live navigation in other open browsers or save dirty
buffers. Navigation revision conflicts are surfaced rather than overwriting blindly.

First catalog migration preserves existing metadata as `metadata.pre-catalog.json`
when present and associates conversations from their recorded cwd. Missing or
unresolvable paths retain an unresolved association and readable history. Missing,
moved, or replaced bindings do not silently retarget execution or file access;
there is no repair/reassociation endpoint in this PoC.

Use Ctrl-C for normal shutdown. Restart with the same data directory to recover
the recorded session list and output. A separate server cannot acquire an already
owned data directory, even on another port.

For OC, closing the browser or bridge does not cancel native execution or stop its
server. Restart with the same data directory and OC endpoint to observe the
recorded native session and command. A run saved before submission fails on
recovery; sending/accepted runs reconnect without resending. Missing native state
or an unavailable server leaves execution unconfirmed and blocks new runs. An
OC-only active-run recovery can reclaim a dead bridge owner without
`--reconcile-interrupted` if no reconciliation flag is already set.

For CC after an abrupt crash, the old process may still be running. Verify and
stop any surviving bridge-owned CLI process using your OS process tools before
restarting with `--reconcile-interrupted`. This flag is your explicit confirmation,
not automatic orphan detection or reattachment. Saved PIDs are not blindly killed.
Previously running records become interrupted, and no replacement execution is
allowed while reconciliation is required.

If a crash happens during lock acquisition, startup can report a stale
`owner-acquisition.lock` directory. Only after verifying that the previous bridge
and its CLI processes have stopped, remove that directory inside your configured
data directory and restart with the reconciliation flag.

## Local API

| Endpoint | Response / behavior |
| --- | --- |
| `GET /api/config` | Authentication state; authenticated responses include default cwd, `oneShot: true`, and capabilities |
| `GET /api/harnesses/opencode/models?cwd=…` | Enabled native models and variants |
| `POST /api/login` | `{password}` → HTTP-only bridge cookie |
| `POST /api/logout` | Invalidates the bridge cookie |
| `GET /api/sessions` | Session records plus resolved workspace/worktree IDs or an unresolved association reason, and global `{availability:{canSend,reason?}}` |
| `POST /api/sessions` | `{prompt,cwd?,sessionId?,harness?,model?,effort?,workspaceId?,worktreeId?}` → `202 {sessionId,runId,harness,nativeSessionId}`; stable workspace/worktree IDs must be supplied together; omitted new cwd defaults to that tree root |
| `GET /api/workspaces` / `POST /api/workspaces` | List catalog / register `{cwd}` and discover existing native worktrees |
| `GET /api/workspaces/:workspaceId` | Repository or directory workspace record |
| `GET /api/workspaces/:workspaceId/worktrees/:worktreeId` | Resolve full worktree and filesystem binding token without a conversation |
| Same worktree base + `/list`, `/file`, `/git`, `/diff` | Read workspace data; `PUT /file` saves with binding and file revision checks |
| `GET /api/navigation` / `PUT /api/navigation` | Read/write owner bookmark; writes require `expectedRevision`, conflict returns `409` |
| `GET /api/sessions/:sessionId/runs` | `{runs: [...]}` |
| `GET /api/runs/:runId/events?after=N` | `{events,nextCursor,status}` |
| `POST /api/runs/:runId/input` | `501`; no live input |
| `GET /api/sessions/:sessionId/interactions` | OC pending permissions/forms; empty for CC |
| `POST /api/sessions/:sessionId/interactions/:interactionId/reply` | Native permission decision or typed question answer; CC returns `501` |
| `POST /api/sessions/:sessionId/cancel` | Interrupt active app-owned OC session; CC returns `501` |

A supplied session ID must already be in the bridge's local store. Resume uses
its recorded launch cwd. Validation errors do not start a CLI; overlapping runs
return `409`. Run status and diagnostic events report failures after acceptance.
Event records contain `{seq,time,runId,sessionId,kind,data}`; kinds are `stdout`,
`stderr`, `hook`, `status`, `submission`, and `message`. Submission records durably
store `{messageId, text}`: CC uses `<runId>:user`, OC its native command ID. OC
message events are full snapshots, replaced by message ID across the conversation,
not appended as deltas. Old CC logs recover
prompts only from actual primary `UserPromptSubmit` evidence; missing prompts
remain unavailable. Hook data contains `{event,payload}`, preserving
the original hook JSON. Browser mutations require the exact configured `Origin`;
requests require its public `Host` or the narrowly allowed local proxy authority
described above.

Catalog `workspaceId` and `worktreeId` are stable UUIDs. The resolved
`bindingRevision` is a separate filesystem token, not a catalog ID: file operations
accept it as `bindingRevision` or the legacy `workspaceId` query/body field. See
`src/catalog-contract.ts`. Legacy conversation-workspace routes remain available.

SANE integration proposals are recorded in [SANE-FOLLOW-UP.md](SANE-FOLLOW-UP.md).
Terminal implementation choices and historical research are recorded in
[TERMINAL-RESEARCH.md](TERMINAL-RESEARCH.md). SANE workstream integration remains deferred.

## Conversation and run identities

```text
Browser ── same-origin HTTP/polling ── Bun server ── spawn ── installed claude -p
                                           │                      │
                                           │       command hooks (stdin JSON)
                                           │                      │
                                           └──── loopback POST ───┘
                                           │
                                    local metadata + event logs
```

- **Session ID:** app conversation UUID; for CC also the native conversation UUID.
- **Native session ID:** persistent mapping to the owning harness; OC uses its own
  `ses…` ID. Older catalog entries without harness fields remain CC conversations.
- **Run ID:** bridge UUID for one submitted execution and its log. OC also persists
  a native `msg_…` command ID and admission phase.
- **Agent ID:** an optional child identity from hooks, never a primary session.
- **Launch cwd:** directory supplied when launching the CLI.
- **Hook cwd:** the actual `cwd` in a particular hook payload; it can differ from
  launch cwd and is preserved separately.

The diagram above shows the CC path; OC instead uses bridge-to-server V2 HTTP.
Only app-created catalog sessions are listed and controllable. There is no native
session import, discovery, attachment, or CC transcript tailing. Bridge mappings
and logs reconstruct the UI; continuation also requires each harness's own native
storage. Backing up bridge logs alone does not preserve native context.
Polling uses event cursors so browser reconnects can replay stored output.

## Submission behavior

Each CC submission provides one prompt and closes process input. OC submits a
durably identified command to its server. Wait for the run to finish, then send a
follow-up in the same conversation. Native OC interaction replies are separate
from free-form input. Chat has no interactive harness attachment, live steering, or queue;
`POST /api/runs/:runId/input` returns `501`.

One run may be active across both harnesses and all browsers. Ambiguous OC prompt
admission fails closed: the slot stays occupied while native history is reconciled,
without automatic prompt retry. HTTP acknowledgement does not prove completion.
Avoid submitting work through another client in a bridge-owned conversation; the
bridge cannot serialize independent clients.

## Remote access boundaries

SSH local forwarding is the simplest deployment: both listener endpoints stay on
loopback and SSH authenticates the connection. A forwarding client must bind its
local port to `127.0.0.1`, not all interfaces.

For an authenticated HTTPS tunnel, keep the bridge on loopback when the tunnel
agent runs on the same machine. Configure the exact externally visible origin and
enable the bridge password. Do not publish the loopback service through an
unauthenticated tunnel. The password must be a new bridge-only password.

An explicit non-loopback listener is for a deliberately configured private
deployment behind TLS/tunnel protection. It does not add TLS itself. Restrict
network access to the intended proxy; password authentication alone does not
encrypt plain HTTP. Do not forward `/hooks/` through the public proxy: hook
delivery is local and separately authenticated.

Treat local event logs as conversation data: prompts, responses, tool events, and
filesystem paths can be present. Keep the data directory local and excluded from
version control. Browser logout does not delete saved conversations.

## Owner-run Claude Code acceptance demo

These manual steps invoke the real CLI and consume your subscription usage.

1. Run `claude --version` and record the output in `LIMITS.md`.
2. Create an empty disposable directory, for example:
   ```sh
   mkdir -p /tmp/cc-web-demo
   ```
   Start the bridge on loopback from a different directory (the `poc/cc-web`
   directory is suitable) and open its printed URL.
3. Select a new session, enter that directory, and submit:
   > Remember the marker LOCAL-BRIDGE-731. Reply with the marker and a short greeting. Do not use tools.
4. Confirm the displayed session/run IDs, output, and SessionStart/Stop hook rows.
   Hook and stream `session_id` must match the displayed primary ID. Hook payload
   `cwd` must resolve to the selected test directory, not the server's launch
   directory (`/tmp` may resolve to `/private/tmp` on macOS). Record both paths.
5. In the same session, submit:
   > What marker did I ask you to remember? Do not use tools.
   Verify retained context, the same session ID, a different run ID, and preserved
   output from both runs.
6. Submit a small subagent task:
   > Use one available subagent to report whether this directory contains any files. Do not modify files. Summarize its answer.
   Confirm a SubagentStart row with `agent_id != session_id` and the same primary
   `session_id`. The session list must not gain a child entry. If delegation is
   denied or does not happen, record that observation rather than manufacturing
   a successful demo.
7. After completion, stop and restart the bridge. Verify the session list and
   saved output are still available and the one-shot explanation is visible.
   Select the persisted session and ask for the marker again: its session ID
   remains unchanged, its run ID is new, and earlier output remains accessible.
8. From another laptop, forward the bridge over SSH:
   ```sh
   ssh -N -L 127.0.0.1:8787:127.0.0.1:8787 your-host
   ```
   Open `http://127.0.0.1:8787` on that laptop, select the same persisted session,
   and ask for its marker. Verify the same session ID, a new run ID, and retained
   history. The host
   server remains bound to loopback. Use another local port if 8787 is occupied;
   configure the bridge's accepted browser origin accordingly if required.
9. For a phone/tablet, use your SSH client's local forwarding or your own
   authenticated HTTPS tunnel. Verify keyboard, scrolling, background/resume,
   and reconnect on the physical device. Desktop viewport resizing alone is not
   a physical-device pass.

Record expected versus observed results in `LIMITS.md`. Stop if a step would
require an undocumented API or a change to the single-user subscription boundary.

## Documented integration surfaces

- [CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Headless CLI](https://code.claude.com/docs/en/headless)
- [Model and effort configuration](https://code.claude.com/docs/en/model-config)
- [Result and rate-limit event schemas](https://code.claude.com/docs/en/agent-sdk/typescript#sdkresultmessage) (documentation only; no SDK dependency)
- [Cost accumulation and limitations](https://code.claude.com/docs/en/agent-sdk/cost-tracking#accumulate-costs-across-multiple-calls)
- [Status-line data](https://code.claude.com/docs/en/statusline#available-data)
- [Hooks](https://code.claude.com/docs/en/hooks)
- [Subagents](https://code.claude.com/docs/en/sub-agents)
- [Plugins](https://code.claude.com/docs/en/plugins/overview)
- [MCP](https://code.claude.com/docs/en/mcp)

Hooks are installed locally through bridge-supplied settings. Plugins and MCP are
not needed. Hook forwarding carries explicit bridge run context; it never assumes
that ordinary MCP calls provide session identity or live cwd.
