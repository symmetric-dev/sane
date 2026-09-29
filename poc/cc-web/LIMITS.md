# PoC limits and verification record

## Evidence boundary

Verification belongs to the owner. The owner reports CC and OC integrations working,
including managed OC service discovery/authentication, and has positively reviewed
the React chat UI. The supplied CC trace establishes resumed prompt/tool activity
with consistent primary identity and cwd. The owner also reported the model/effort
extension working. Exact harness versions are not yet recorded.
The owner also reports the workspace baseline working and has now verified Terminal,
describing it as very good for the PoC. The PoC feature scope is closed; workstream
state formalization and artifacts UI move to the app phase. These reports do not
establish every navigation, recovery, cleanup, or workspace edge case below.
See [formalization horizon](../../docs/sane-app/ongoing/HORIZON.md) for the historical next-stage proposal.

This is a working PoC baseline, not a claim of production hardening. Broad success
reports do not establish every capability, failure path, restart, or device case.
Detailed pending checks below remain pending unless specifically evidenced; general
statements that compatibility was unverified are superseded by this owner report.
No harness/model calls were made by implementation agents. Earlier fixture work
was removed at the owner's request; subsequent integrations used source/documentation
work and dependency installation only. This documentation update ran no verification.

## Suggestions for a final implementation

- Durable idempotency and operator resolution for ambiguous admission.
- Explicit recovery for CC process ownership and OC native-state reconciliation.
- Native schema/version compatibility policy and fuller observed model metadata.
- Bounded memory, pagination, retention, migrations, and backup/restore procedures.
- Defined simultaneous-device submission and unsaved-draft semantics.
- Actionable connection diagnostics and opt-in harness installation/startup automation.
- Durable editor draft recovery, bounded buffer retention, native-writer coordination,
  chat-to-file navigation, broader language support, and configurable editor themes.

These are improvement candidates, not implemented guarantees or prerequisites for
continued PoC use. See [HUMAN-OPERATOR-GUIDE.md](HUMAN-OPERATOR-GUIDE.md) for commands
and automation suggestions, and [ARCHITECTURE.md](ARCHITECTURE.md) for adapter invariants.

**Claude Code version tested through this bridge: not yet recorded.** Run
`claude --version` yourself and record the exact output below before the live demo.

```text
Version: pending owner verification
Host OS: pending owner verification
Browser/device: pending owner verification
Date: pending owner verification
OpenCode V2 server version: pending owner verification
```

## Code/Git PoC boundaries — current navigation revision unverified

The prior workspace baseline is owner-reported working. Source registers
repository workspaces with main and externally located linked worktrees, using
canonical common-directory identity and stable catalog IDs. File operations use a
separate binding token and full worktree scope without requiring a conversation.
Conversation cwd and association remain fixed. Re-registering discovers existing
native worktrees; there is no creation, pruning, repair, or reassociation API.

Owner checks remain pending for closest-root/nested-repository registration,
external linked trees, non-Git directory workspaces, operational Git errors,
missing/moved/replaced bindings, migration and unresolved-history access, and
navigation restore/conflicts across devices. `catalog.json` and `navigation.json`
are separate from run metadata; `metadata.pre-catalog.json` preserves pre-migration
metadata when present. One implicit owner's bookmark restores navigation without
forcing other live browsers. Dirty buffers are still browser-only. Catalog growth
does not enable concurrent runs: one global execution slot still spans CC and OC.

The current navigation revision is source-implemented and awaits owner verification. This revision and
documentation pass make no test, build, typecheck, browser, server, harness, or
runtime-verification claim. The prior workspace success report does not establish
the revised navigation or exhaustive filesystem/Git behavior.

- Workspace/worktree context is in the topbar, compact on mobile. Workspace selection
  is a name/path-searchable modal with a secondary Open directory subflow. Explicit
  Refresh worktrees updates discovery while preserving navigation. The application
  menu holds connection details, Reconnect, and authenticated Sign out with dirty-buffer
  confirmation. Runs in appears when browsing differs from conversation execution.
  File actions / Change actions dialogs hold eligible editor/diff controls. Modal
  focus, dismissal, compact layout, and these navigation flows await owner review.
- Global Chat / Code / Git / Terminal controls occupy the sidebar/mobile
  drawer footer. Code's lazy Files tree and Git's Staged / Unstaged / Untracked
  directory tree replace conversation history. Both use Headless Tree core/react
  pinned to 1.7.0. One shell header serves edge-to-edge editor/diff content. Mobile
  uses the contextual drawer, shares expansion state, and closes on file activation.
  The selected catalog worktree's full root is accessible without a conversation.
  One provider owns request scope and polling, with one selected path per canonical
  root; Chat remains mounted while hidden.
- CodeMirror 6 shares the app's warm-light palette. Semantic tokens support future
  theme extension, but there is no theme selector/configuration. Highlighting covers
  JavaScript/TypeScript/JSX/TSX, JSON, CSS, HTML, and Markdown; other text is plain.
  No LSP, completion service, debugger, file creation/deletion/rename,
  global file search, or chat-to-file navigation is implemented. The shared
  activation seam is for future external file/line actions; file links, reference
  parsing, and line/range reveal are not implemented.
- Existing writable regular UTF-8 files only, maximum 256 KiB including encoded
  BOM/line endings on save. NUL-containing content is treated as binary. Invalid
  UTF-8, oversized, mixed-EOL, and non-writable files cannot be edited; the current
  Code view shows a reason rather than a read-only text editor for these files.
  Symlink traversal and hard-linked files are rejected. `.git` and bridge data
  paths are excluded. This is not isolation from native processes with OS access.
- Reads normalize EOL and remove the UTF-8 BOM for display. Saves preserve a BOM
  and uniform LF/CRLF/CR convention. Raw-byte hashes supply optimistic revisions;
  server writes are queued per path. In-place writes are not atomic replacement,
  rollback, or exclusion of agent/native writers. A native edit after the last
  check can race a save; an I/O failure can leave a partial save. An error response
  is not proof disk was unchanged. There is no force-save or automatic merge.
- Dirty buffers and editor state survive view/file/conversation switches in browser
  memory, shared for conversations with the same canonical root. They are not
  durable on reload or synchronized across devices, and opened buffers have no
  eviction policy. Explicit file Reload and sign-out confirm discard. There is no
  implemented browser-page unload/reload confirmation in the source inspected.
  Expired authentication preserves buffers in memory; explicit sign-out clears them.
- Only the selected file is periodically checked while Code or Git is active and
  the page is visible, approximately every five seconds and on focus. Clean buffers
  may refresh; dirty buffers retain edits with disk-change evidence. There is no
  continuous watcher or guaranteed instant detection.
- Directory listing scans at most 2,000 entries per folder; lazy tree expansion
  does not remove that bound. Use Refresh files to refresh loaded directory listings.
  Git status retains at most 2,000 in-scope entries;
  truncation is shown. Native Git commands have an eight-second deadline and a
  bounded output budget (normally 4 MiB, smaller for blob reads). Large repository
  output may fail before scoped results can be shown. Git must be installed on PATH.
- Git Diff is read-only saved-state inspection: staged HEAD → index, unstaged
  index → working tree, untracked empty → working tree. Unsaved buffers are excluded.
  No staging, discard, commits, or conflict resolution are offered. Open in Code
  opens an eligible file and navigates directly to Code.
- Additions/deletions use an empty absent side. An unborn branch can use an empty
  HEAD side. Modes and in-scope rename metadata are carried separately. Mode-only
  changes can have no text change. Conflicts, submodules, symlinks, cross-workspace
  renames, binary/invalid UTF-8, and oversized blobs show unsupported reasons.
  Hard-linked disk files can fail the request. Non-UTF-8 Git status paths are
  unsupported. Git status supplies rename detection; the UI does not infer renames.
- Unified diffs compare normalized before/after text, not a raw Git patch. BOM-only
  or EOL-only changes can show no text changes. Textconv, external diff, and working
  tree conversion filters are not applied to blob comparisons. Independent Git and
  disk reads can race native changes; status and diff are not one atomic snapshot.
  Non-repositories or missing Git show unavailability, not a fabricated clean state.

Owner checks remain pending for contextual trees, shared expansion/selection,
navigation/mobile layout, editor interactions,
explicit saves and conflicts, reload/sign-out handling, shared-root buffers,
staged/unstaged/untracked comparisons, and the unsupported cases above. Record
observations without treating the existing integration success report as coverage.

## Terminal boundaries — implementation unverified

Terminal frontend and service source are present; backend integration is being
completed. The owner reports native Bun **1.4.2**. Bun documents `Bun.Terminal`
from **1.3.5** on macOS/Linux, but no PTY compatibility or terminal runtime result
is claimed. This docs-only pass ran no commands or verification. Prior owner-verified
CC/OC/workspace behavior does not establish the terminal's behavior.

- One terminal per catalog worktree, independent of conversations and the shared
  CC/OC execution slot. Start/restart/close are explicit. Exit, disconnect, or
  navigation never starts a replacement. **Started in:** is the initial worktree
  root, not current shell cwd; the shell is not restricted by Code's file API.
- Shell and screen state live only in the bridge process. They survive browser/view
  changes, not bridge restart/crash. There is no durable terminal transcript,
  PTY reattachment across bridge lifecycles, or crash/orphan reconciliation facility.
- Same-owner viewers share one explicitly claimed keyboard controller. Takeover
  and release use a control generation; only the controller sends input/interrupts
  or changes PTY dimensions. Navigation away, hidden pages, disconnect, and logout
  release control. Reconnect restores a viewer without auto-claim or input replay.
- Current contract bounds: **8 terminal resources**, **8 attachments per terminal**,
  **500 scrollback lines**, **20–240 columns**, **5–100 rows**, **8 KiB input messages**,
  **16 KiB output chunks**, **1 MiB backlog**, and **2 MiB serialized snapshots**.
  Closed/exited resources are retained and count toward the resource limit until
  bridge restart; explicit restart replaces the same worktree's resource.
- Snapshot/ordered-delta delivery is acknowledged after browser xterm processing.
  There is one outstanding screen frame per attachment, a 15-second acknowledgement
  timeout, bounded retention, and slow-viewer disconnection/resnapshot. Waiting for
  a complete parser boundary can time out; screen/parser or server backlog overload
  can stop the shell and require explicit restart. These bounds do not establish
  full-screen application, Unicode, alternate-buffer, or resize fidelity.
- Packages currently declared: `@xterm/xterm` and `@xterm/headless` **5.5.0**,
  `@xterm/addon-fit` **0.10.0**, and `@xterm/addon-serialize` **0.13.0**. Declared
  versions are source evidence, not a tested compatibility matrix.
- WebSocket integration uses the existing bridge authentication and exact configured
  Origin boundary, login revocation, and existing Tailscale WSS route with no new
  port. The frontend uses the warm-light full Terminal view and mobile keyboard,
  Ctrl C, Esc, Tab, and arrow controls. Authentication/Origin integration, control
  handoff, reconnect/snapshot behavior, and physical mobile interaction await owner
  manual review; this is not an agent testing prescription.
- Close/shutdown attempts bounded shell/process-group signaling and PTY hangup.
  Job-control groups, detached or reparented processes, and abrupt crashes make
  descendant cleanup best-effort. No guarantee that all jobs stop is made. Restart
  is refused when the previous shell's exit remains unconfirmed.

SANE workstream integration remains deferred. See [TERMINAL-RESEARCH.md](TERMINAL-RESEARCH.md)
for historical research and the implementation selected from it.

## OpenCode V2 boundaries

- Defaults to `Service.discover()` from pinned `@opencode/client` 2.0.18 and
  `Service.headers(endpoint)` for the discovered running service only. The owner
  starts it with `opencode service start` under the bridge's OS user/home/XDG
  environment. No environment token is needed; `OPENCODE_TOKEN` is ignored in
  managed mode. Missing service/authentication leaves OC unavailable, while CC
  startup and recorded history remain accessible.
- Explicit `--opencode-url` bypasses discovery, using only the supplied URL and
  optional `OPENCODE_TOKEN` bearer credential. A separate foreground server started
  with `opencode serve` requires its actual URL explicitly, including on port 4096.
  This mode cannot use a Basic-only endpoint via the bearer token setting. It never
  borrows managed auth. No OC CLI invocation, service startup/shutdown, credential
  logging/persistence, or browser token forwarding is implemented.
- Discovery is lazy and deduplicated, with a five-second success cache and
  one-second failed-discovery cooldown. Transport/auth/server/JSON failures evict
  only their own cached generation; subsequent requests refresh URL and headers
  together. No automatic request replay occurs. Rotation may temporarily report
  unavailable; polling reconnects, but native recovery requires the same native
  storage. A custom registration file is not configurable through bridge options.
- Managed discovery/authentication works according to the owner. Credential rotation
  and explicit-URL auth isolation remain unverified edge cases. Sources are the
  [V2 client guide](https://opencode.ai/v2/docs/build/client),
  [troubleshooting](https://opencode.ai/v2/docs/troubleshooting),
  [CLI guide](https://opencode.ai/v2/docs/cli), and installed service declarations
  and source, read without execution.
- Only app-created catalog sessions can be listed, continued, replied to, or
  cancelled. App UUID → native session mapping and command admission state persist
  in bridge metadata. Bridge event logs and native OC storage are separate; both
  are needed for history plus native continuation. No native session import or
  cross-harness handoff is provided.
- One active run spans CC and OC. Ambiguous OC prompt acceptance holds that slot
  while reconnecting, without automatic retry. Missing native evidence, connection
  failure, or history outside the 100-page reconciliation budget cannot establish
  completion and may leave the bridge blocked.
- Browser disconnect and bridge shutdown do not cancel native OC work. Restart
  observes the saved sending/accepted command; a preparing run fails without
  submission. This is separate from CC orphan-process reconciliation.
- Models/variants come from the native enabled catalog. Native permissions and
  typed forms accept explicit owner replies; cancellation interrupts only the
  app's active OC session and settles through native status observation. These
  capabilities do not enable CC cancellation, replies, or general mid-run input.
- Message snapshots preserve available native cost/token evidence, not account
  usage, subscription capacity, or cross-run totals. The owner reports the integration
  working through the configured setup; interaction variants, cancellation, and
  restart/reconnect edge cases remain individually unverified.

## Intentionally unsupported

- Cross-run summed usage or a calculated subscription bill. Usage panels show
  CC terminal-result snapshots: main-loop input/output/cache tokens, model-specific
  input/output/cache tokens and estimated USD, total estimated USD, durations,
  and CLI turn count, only when present. Resumed cost/model totals are cumulative
  from CLI v2.1.277 onward and per-invocation on older versions; summing would
  double-count on current versions. Main-loop usage excludes subagents. Error
  results can be partial or zeroed. No result means unavailable, not zero spend.
- Subscription/account usage, subscription percentages, rate-limit projections,
  and provider usage-page links. These are outside the chat migration scope.
  Received `rate_limit_event` records remain in raw diagnostics only. No
  speculative status-line forwarder or token-to-percentage conversion is used.
- Guaranteed application of requested model/effort. Account access, model
  support, policy, and installed CLI version decide what runs. The UI separates
  requested flags, observed init model, and observed primary hook effort. Missing
  hook fields remain unavailable. The selector supports five reasoning levels;
  the CLI's `ultracode` workflow shortcut is outside this effort-only selector.

The model/effort/usage extension was implemented by reading code and official
documentation only. No CLI invocation, test, typecheck, browser, server, mock,
or other verification command was executed for this extension. Owner verification
of new/resumed choices, reload history, and usage availability remains pending.
Sources: [CLI flags](https://code.claude.com/docs/en/cli-reference),
[model configuration](https://code.claude.com/docs/en/model-config),
[headless output](https://code.claude.com/docs/en/headless),
[result and rate-limit schemas](https://code.claude.com/docs/en/agent-sdk/typescript),
[cost accounting](https://code.claude.com/docs/en/agent-sdk/cost-tracking),
[hook effort](https://code.claude.com/docs/en/hooks#common-input-fields), and
[status-line data](https://code.claude.com/docs/en/statusline#available-data).

- Interactive attachment to harness runs, steering, and free-form mid-run
  chat input. The separate worktree Terminal does not attach to these runs.
  Each CC prompt starts a one-shot process; a later prompt resumes in a
  different process. OC native permission/form replies are supported separately.
- Automatic permission or form answers. Observational hooks never grant access.
- Simultaneous bridge runs, passive queues, and control of independently launched
  CC processes or unrelated OC sessions. Use app-created catalog conversations.
- Multi-user accounts, shared subscription access, cloud tasks, Anthropic web API
  integration, credential extraction, and vendor-page embedding.
- Full nested-agent lineage. Hook `session_id` identifies the primary conversation;
  `agent_id` identifies a child, not a new primary. Hook payloads alone do not
  establish every child's parent or depth. Internal agents may emit stop events.
- Recovering a live CC output pipe after the bridge crashes. Stored history
  survives; process ownership must be reconciled before replacement work. OC
  reconnects to server-owned execution instead.
- Large-scale history retention. The PoC loads recorded events into memory and
  the page retains raw events for viewed runs; log rotation and virtualized output
  are not implemented.
- Windows support is unverified. Hook command quoting and process supervision
  target the local macOS/POSIX environment used for this implementation.
- HTTP request bodies are limited to 1 MiB. Oversized prompts are rejected, and
  oversized hook payloads may not reach the log. Hook delivery is best-effort,
  not a guaranteed complete transcript.

## Unproven until the owner runs the demo

The React/assistant-ui migration was implemented without running tests, mocks,
typechecking, builds, servers, browsers, or Claude Code. Dependency installation
used `bun install --ignore-scripts` only. Compilation, runtime integration,
accessibility, mobile layout, real-event compatibility, and visual review remain
owner verification work. No agent-generated verification result is claimed.

Frontend-specific limits:

- Drafts are per-conversation (or new-conversation worktree) memory only;
  reload/sign-out clears them. Navigation is an owner-scoped backend bookmark,
  separate from drafts and run metadata.
- History titles use the first recorded prompt after opening a conversation;
  unopened conversations use the directory name and short ID.
- No token-partial display is promised. Assistant message records and tool
  results update through polling. Result text is a fallback only when no assistant
  text was recorded for CC. OC messages are full upsert snapshots by native ID.
  Run status, never a Stop hook or cancel acknowledgement, determines completion.
- Tool pairing requires an actual matching ID namespaced by run. Unpaired records
  remain in diagnostics. Child-agent nesting/lineage is not synthesized.
- Markdown supports GFM and code copying, without raw HTML, remote image loading,
  syntax-highlighting bundles, or diagram execution.
- Run/session event history is loaded in memory; there is no virtualization or
  retention policy in this PoC.
- A failed POST can have unknown acceptance. Its draft remains, GET polling
  reconnects, and the UI asks the owner to inspect history before resubmitting.
- The frontend expects authenticated capabilities and authoritative availability
  from the bridge. Missing availability disables sending rather than guessing.

| Check | Expected | Observed |
| --- | --- | --- |
| Subscription-only authentication | Installed CLI uses existing subscription login without API credentials | Pending |
| New session | Returned UUID matches stream and SessionStart/Stop hooks | Pending |
| Resume in same directory | Same session UUID, new run UUID, previous context retained | Pending |
| Hook cwd | Hook rows use payload cwd, independent of server cwd | Pending |
| Subagent | SubagentStart has distinct agent_id and primary session_id; no extra primary session | Pending |
| Normal termination | CLI result and exit status produce an accurate terminal run state | Pending |
| Permissions | Denials remain visible without bridge auto-approval or interactive input | Pending |
| Restart after completed run | Session list and previous output survive | Pending |
| Restart during active run | Interrupted/unknown state is visible and replacement execution is blocked pending reconciliation | Pending |
| SSH forwarding | Same browser flow through a loopback-bound SSH local forward | Pending |
| Phone/tablet | Composer, scrolling, reconnect and virtual keyboard work on a physical device | Pending |
| Cross-directory resume | Version-dependent session discovery and cwd behavior are understood | Pending; not required for baseline |

Cross-directory resume is documented for Claude Code v2.1.223+, but documentation
is not evidence for this installed binary. The baseline keeps the recorded launch
directory when resuming. Do not infer cwd from project-root variables or transcript
location. Transcripts may lag; this bridge does not tail them for completion.

## Compatibility notes

The configured Tailscale Serve deployment is
`https://server.gecko-halibut.ts.net:18879/` → `http://localhost:18879`.
Loopback-proxy Host handling was added for this deployment. Per the owner's
instruction, this final compatibility change has not been run or verified by
agents; verification belongs to the owner.

Documentation reviewed 2026-09-26:
[headless authentication and streaming](https://code.claude.com/docs/en/headless),
[resume version boundary](https://code.claude.com/docs/en/headless#continue-conversations),
[hook merging](https://code.claude.com/docs/en/hooks#hook-locations), and
[noninteractive permissions](https://code.claude.com/docs/en/hooks#permissionrequest).
These describe documented behavior, not a live compatibility result.

- The CLI is launched without `--bare`: current documentation says bare mode skips
  subscription OAuth/keychain authentication and automatic hook discovery. The
  documentation also anticipates a future default change. Reverify after upgrades.
- `SessionStart`, `Stop`, `SubagentStop`, and `SessionEnd` have different meanings.
  A stop hook alone is not proof that the child process exited. Abrupt termination
  may prevent hook delivery.
- Settings and managed policy can affect hook availability and permissions. A
  missing hook is a failed observation, not permission to bypass policy.
- Bridge settings merge with ordinary user/project hooks; they do not isolate or
  replace your existing configuration. Matching handlers can run in parallel.
  Log sequence numbers describe receiver order, not a guaranteed causal ordering
  across independent hook handlers.
- Current documentation allows PermissionRequest hooks in noninteractive runs.
  Receiving one does not mean a browser-answerable prompt exists. This bridge
  records it without returning an allow/deny decision; normal CLI permission
  behavior still applies.
- Streaming JSON provides incremental messages; this PoC need not provide token
  deltas. Startup-hook stream messages can precede `system/init`.

## Recording a failure

For any failed live check, replace its Pending entry with the exact expected and
observed behavior, CLI version, command shape (without secrets), and relevant run
ID. If proceeding would need an undocumented endpoint or violate the single-user
local-use boundary, stop that investigation and record it here. Do not substitute
private APIs, credential forwarding, or permission bypasses.
