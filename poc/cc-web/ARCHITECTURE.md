# Server-owned conversations and harness adapters

## Status and scope

This document records the implemented CC / OpenCode V2 persistence model and
design direction and the source-implemented Code/Git PoC. The owner reports the prior
workspace baseline working; the current navigation revision and new Terminal
implementation remain unverified. Terminal backend integration is being completed.
Runtime and UI verification belong to the owner. The owner reports
CC and OC working, including managed OC discovery/authentication. This establishes
a working PoC baseline, not a hardened implementation or exhaustive recovery proof.

Only conversations created through this PoC / SANE are in scope. Discovering,
importing, attaching to, or controlling independently started CC or OC sessions
is out of scope. Subscription/account usage management and provider usage-link
directories are also out of scope.

## Implemented persistence model

The server owns durable conversation state. Browsers fetch and project it; they
are not the permanent conversation store.

| State | Storage | Shared between devices |
| --- | --- | --- |
| Session index, harness/native ID mapping, run metadata, requested settings | `<data-dir>/metadata.json` | Yes |
| Submitted messages, CLI output, hooks, OC message snapshots, lifecycle events | `<data-dir>/<runId>.jsonl` | Yes |
| Native conversation state needed by Claude resume | Claude Code's own server-local storage | Through the server |
| Native OpenCode conversation state | Existing OC server's own storage | Through the server |
| Repository/worktree catalog and conversation associations | `<data-dir>/catalog.json` | Yes |
| Owner navigation bookmark (workspace/worktree/conversation/view/file/comparison) | `<data-dir>/navigation.json` | Restore across devices; no live navigation forcing |
| Unsent drafts and composer selections | Browser memory | No; not durable across reload |
| Open file buffers, unsaved edits, and editor state keyed by canonical workspace root/path | Browser memory | No; retained across view/file/conversation switches, lost on reload/sign-out |
| Explicitly saved workspace files and Git state | Selected full worktree / directory workspace | Yes; independently of bridge conversation logs |
| Terminal shell, PTY, bounded screen/scrollback, and controller generation | Bridge process memory, keyed by workspace/worktree | Same-owner viewers while this bridge lives; no bridge-restart recovery |
| Open drawers and other presentation state | Browser UI state | No |

The default data directory is `poc/cc-web/.data`; `--data-dir` selects another.
It is a bridge-wide store spanning conversations in different launch directories,
not an index of every native conversation on the host. One live bridge owns
a data directory. Browsers connected to that bridge share its conversation list
and saved history. Disconnecting a browser does not cancel server-owned execution.
Multiple devices do not imply multi-user authorization or collaborative editing.

Bridge history and native harness state have different responsibilities:

- Bridge records reconstruct the UI, including messages and execution details.
- Native harness state enables continuation of the actual model conversation.

Preserving bridge logs alone does not guarantee native resume. Moving or backing
up the system must account for both stores and the referenced workspace paths.

Historical runs predating explicit submission persistence can recover user text
only where it was actually recorded in a hook. Missing history is not fabricated.

## Separation of responsibilities

### Repository catalog and navigation

`src/catalog.ts` and `catalog-contract.ts` separate the catalog from mutable run
metadata and navigation. There is one implicit owner under the existing bridge
data-directory lock. Catalog and navigation writes have independent queues;
navigation uses an expected revision and returns 409 on conflict. Frontend restore
does not continuously apply another browser's navigation. Dirty editor buffers and
composer drafts remain browser-only.

Registration canonicalizes an absolute host directory and discovers its closest
Git root. Repository identity uses the canonical Git common directory plus its
filesystem identity; worktree bindings pin root and Git administrative directory
identities. A workspace groups main and linked worktrees, even at external paths.
Native `git worktree list --porcelain -z` supplies discovery; re-registration
refreshes that list. A confirmed non-Git directory is a `directory` workspace.
Missing Git, permission errors, timeouts, and other discovery failures are not
non-Git fallback. Bare entries are not browsing worktrees.

Stable catalog workspace/worktree UUIDs are distinct from `bindingRevision`, the
filesystem-operation token. Missing, moved, or replaced bindings become invalid
rather than silently taking over an old identity. No create/prune/repair worktree
or conversation-reassociation API exists. A conversation's association and exact
launch cwd remain immutable; browsing another tree never retargets its execution.

On first migration, existing `metadata.json` is preserved with exclusive creation
as `metadata.pre-catalog.json`. Recorded conversation cwd drives association;
unresolvable paths get explicit unresolved associations while logs stay readable.
Migration does not rewrite cwd or manufacture a replacement execution directory.
The backup is not a substitute for native harness storage or a complete rollback.

```text
Harness execution + native session state
                 |
Server conversation index + durable event history
                 |
Harness adapter -> shared conversation/message/run model
                 |
Application store -> assistant-ui / React presentation
```

The frontend's shared model and client contract live under `frontend/`. Harness
transport and event projections translate CC evidence and OC snapshots into it.
assistant-ui renders externally managed messages rather than becoming a second
conversation persistence system. Detailed raw events remain available separately.

Conversation, submitted execution, and harness internal iterations are distinct.
Completion follows the authoritative backend lifecycle. Capabilities determine
available actions; unsupported cancellation or permission replies are not exposed.
Reported usage remains a sourced snapshot, not an assumed additive session total.

## Adapter contract and final-implementation considerations

- Application conversation identity maps to one harness/native session identity.
  A submitted run is not inherently an OS process. Run IDs and native internal
  iteration counts must not be treated as interchangeable.
- CC projects its durable events; OC message events are complete snapshots:
  upsert by native message ID across the conversation and replace ordered parts.
  Event sequence numbers are run-local. Tool correlation requires actual IDs.
- Completion belongs to the execution owner: CC process/result evidence versus
  OC native command/session evidence. Browser disconnect, HTTP acceptance, a
  stop hook, or an interrupt acknowledgement alone does not establish completion.
- Capabilities gate actions; a missing capability must not become an ineffective
  control. Provider-specific model variants retain their native values.
- Reconnection reconciles authoritative state rather than assuming missing events
  mean completion. Never automatically resend ambiguous submissions.
- Usage retains source and snapshot semantics; it is not automatically additive
  across resumes and does not represent subscription allowance.

For a final implementation, evaluate idempotent submission/recovery, versioned
native-contract compatibility, bounded/paginated history, storage migrations and
backup/restore, and simultaneous-device behavior. Observed OC model/variant
coverage also remains an adapter improvement. These are suggestions, not guarantees
or blockers imposed on this PoC. Startup/installation automation proposals live in
[the Human Operator Guide](HUMAN-OPERATOR-GUIDE.md).

## Implemented Code/Git surface — navigation revision unverified

Global Chat / Code / Git / Terminal navigation occupies the shell sidebar footer, also used
in the mobile drawer. Workspace/worktree context lives in the topbar, compact on
mobile. `catalog-selector.tsx` provides a searchable workspace-selection modal,
a secondary Open directory subflow, and browsing-worktree selection. Explicit
Refresh worktrees re-registers discovery through `catalog.refresh` without changing
navigation; a returned different workspace identity is an error. Code replaces conversation history with a
lazy directory tree; Git replaces it with a Staged / Unstaged / Untracked directory
tree. Each view uses the shell's single header, with edge-to-edge editor/diff
content. The mobile drawer is contextual, shares tree expansion/focus state with
the desktop sidebar, and closes on file activation. Chat stays mounted and
observing while hidden. There is no editor tab strip.

The topbar application menu contains connection status/details, Reconnect, and
authenticated Sign out with dirty-buffer discard confirmation. A Runs in notice
appears only when selected conversation execution and browsing scopes differ;
browsing does not retarget execution. File actions and Change actions use dialogs
for eligible editor/diff controls. `shell-dialog.tsx` uses a native modal dialog
with Escape/backdrop dismissal and focus restoration on close.

`src/workspace-contract.ts` defines the shared transport contract;
`src/workspace.ts` owns filesystem access and native Git reads.
`frontend/workspace-client.ts`, `workspace-store.ts`, and `workspace.tsx` handle
transport, memory-only buffers, and presentation independently of CC/OC adapters.
`workspace-controller.tsx` supplies one shared provider for sidebar, header, and
content: one selected path per canonical root, worktree/authentication-scoped
requests, deduplicated lazy directory loads, and one polling owner regardless of
how many sidebar trees are mounted. `workspace-tree.tsx` uses
`@headless-tree/core` and `@headless-tree/react`, both pinned to 1.7.0, with async
loading for Code and a status-derived directory hierarchy for Git. Tree expansion
and focus are stored per root and mode; selection also records the Git comparison.
The shared activation action selects a file and navigates, including **Open in
Code** from Git. It is a seam for future external chat file/line actions, not an
implemented chat-link parser, file-link UI, or line/range reveal feature.
`workspace-editor.tsx` uses CodeMirror 6 and its unified merge extension.
`workspace-theme.ts` and semantic CSS variables match the single warm-light app
theme; alternative palettes are an extension point, not a configurable feature.

Files resolve independently of conversations from the selected catalog worktree.
Paths are relative to its full root, including when a conversation uses a nested
launch cwd. Traversal, `.git`, Git administration directories,
bridge data, symlink traversal, and hard-linked file access are rejected. These
checks do not provide an OS sandbox against concurrent native filesystem changes.

The API base is `/api/workspaces/:workspaceId/worktrees/:worktreeId`: resolve with
GET, then GET `/list`, `/file`, `/git`, or `/diff`, and PUT `/file` to save.
URL IDs are stable catalog identities. Subsequent operations carry the resolved
`bindingRevision` (also accepted under the legacy `workspaceId` field); writes
include it with `path`, normalized `text`, and
`expectedRevision`. HTTP 409 reports stale workspace/file/comparison state.
Legacy `/api/sessions/:id/workspace` routes remain association-checked compatibility
routes and preserve their conversation-cwd scope.
Unsupported text is `null`, distinct from an empty file or absent diff side (`""`).

Existing writable regular UTF-8 files are bounded to 256 KiB. The browser edits
BOM-free LF-normalized text; saves preserve the existing BOM and uniform line
ending convention. Mixed EOL text is not editable. Revisions hash raw bytes.
Per-path write queues serialize bridge saves, with revision and inode/stat checks
before in-place writes. Saves preserve inode/ownership/mode, but are not atomic
replacement transactions or mutual exclusion with native writers: partial writes
and concurrent-write races remain possible.

Buffers are keyed by canonical root/path and shared by conversations at that root.
CodeMirror state survives file/view/worktree/conversation switches in browser memory only.
Explicit file Reload and sign-out confirm discard. Page reload is not durable
recovery. Visible workspace observation polls approximately every five seconds
and on focus/visibility changes; it refreshes clean selected buffers and preserves
dirty ones for Compare disk or explicit Reload. It is not a filesystem watcher or
a background scan of all open buffers.

Git uses the installed native executable with bounded output/time, literal
pathspecs, and no shell or patch application. Status is scoped back to the selected
workspace even if its repository root is higher. Staged compares HEAD/index;
unstaged compares index/disk; untracked compares empty/disk. Blob reads avoid Git
textconv/external diff/filter execution. Before/after text is normalized for the
read-only unified renderer; modes and supported rename metadata are separate.
Unsupported conflict, submodule, symlink, binary, oversized, invalid UTF-8, and
cross-workspace rename comparisons produce reasons instead of fabricated text.
Independent status/index/HEAD/disk reads are not a transactional repository snapshot.
There are no staging, discard, commit, LSP, or debugger actions in Code/Git.

## Worktree Terminal — source implementation, integration unverified

`src/terminal-contract.ts` defines a worktree resource independent of conversations
and the single CC/OC execution slot. `src/terminal.ts` owns native `Bun.Terminal`
PTYs, interactive shells, headless screen state, attachment/control generations,
and bounded cleanup. The owner reports native Bun 1.4.2; Bun documents the PTY API
from 1.3.5 on macOS/Linux. Neither statement verifies this implementation.

One terminal belongs to each catalog workspace/worktree pair and pins its binding
revision. GET never creates a shell. Explicit start uses the full worktree root;
explicit restart replaces the prior resource after observing shell exit, and close
stops it for all viewers. Exited/closed state remains visible; reconnect does not
restart. Changed bindings are rejected rather than retargeted. `Started in:` is
initial scope, never live shell cwd. Shell access uses the host user's permissions,
not the Code view's restricted filesystem API.

The route contract is `/api/workspaces/:workspaceId/worktrees/:worktreeId/terminal`:
GET state, POST start, POST `/restart` or `/close`, and GET `/socket` for WebSocket
upgrade. Lifecycle requests include `bindingRevision`. Integration must apply the
existing bridge authentication/Host policy and exact configured Origin before
upgrade. Sockets bind to the authenticated login; revocation closes its attachments
and releases control. This shares the existing bridge/Tailscale port and WSS origin.

`frontend/terminal.tsx` and `terminal-client.ts` provide the full warm-light Terminal
view with xterm and Fit. Every attachment is a same-owner viewer until an explicit
claim/takeover. Server-side generation checks gate input, interrupt, and resizing;
viewers cannot resize. Navigation away, worktree/authentication changes, page hiding,
disconnect, and logout release keyboard control. Reconnection restores viewing,
never input ownership or buffered keystrokes. Mobile exposes keyboard focus, Ctrl C,
Esc, Tab, and arrows; physical-device behavior remains owner review work.

Headless xterm plus Serialize supplies a bounded snapshot at a complete parser/byte
boundary. A fresh attachment receives hello/snapshot, then sequenced output and
resize frames. The browser acknowledges after xterm finishes applying each frame;
the server allows one outstanding screen frame per attachment. Missing retention,
slow acknowledgement, or backpressure disconnects the viewer for fresh snapshot
attachment. Server processing/screen overload can stop the terminal and require
explicit restart. This is bounded screen restoration, not durable transcript replay.

Shells/screens survive view switches and browser loss only within the bridge
lifetime. Shutdown closes attachments and attempts bounded SIGHUP, PTY close, then
TERM/KILL cleanup. Job-control groups and detached/reparented descendants prevent
an all-jobs-stopped guarantee. No crash reattachment or persisted-PID cleanup exists.
See [LIMITS.md](LIMITS.md) for resource bounds and the evidence boundary.

## Implemented OpenCode V2 adapter

`src/opencode.ts` defaults to lazy managed-service discovery through pinned
`@opencode/client` 2.0.18's `Service.discover()`. The SDK discovers a healthy
registered endpoint without starting it; `Service.headers(endpoint)` supplies
authentication for that endpoint only. Start it yourself with
`opencode service start`, under the bridge's OS user and home/XDG environment.
Managed mode needs no token environment variable and ignores `OPENCODE_TOKEN`.

Explicit `--opencode-url` bypasses discovery and uses only that URL with optional
`OPENCODE_TOKEN` bearer authentication. A foreground server started separately with
`opencode serve` needs its actual listening URL passed explicitly, even on port
4096. This mode requires a bearer-compatible endpoint if authentication is enabled;
it does not borrow managed Basic credentials. No CLI invocation, service lifecycle
management, credential logging/persistence, or browser credential forwarding is
involved. Tailscale continues to proxy only the bridge.

Discovery is deferred until an OC request, so absence of OC does not prevent CC
startup. Concurrent discovery shares one promise; successful URL/header pairs are
cached for five seconds and discovery failures back off for one second. Transport,
401/403, 5xx, and JSON-response failures invalidate only the connection generation
used by that request. A late failure cannot evict a newer discovered pair. Later
requests rediscover; no request is automatically replayed, especially mutations.
Service rotation can briefly surface unavailability before polling reconnects.
Native recovery still requires the same underlying OC storage. The SDK's default
registration path/environment rules apply; no custom registration-path flag is
provided by the bridge.

The catalog maps an app UUID to its harness and native session ID. Older records
default to CC. OC creation uses the selected directory; follow-ups retain that
directory, harness, and native session. Commands receive durable native IDs before
submission. Polling reconciles messages, active state, inbox admission, and native
idle/outcome evidence; HTTP acknowledgement alone is not completion. Message events
are full upserts by native message ID across runs, preserving ordered
text/reasoning/tool parts and reported usage. History lookup is bounded to 100
pages of 100 messages; missing evidence does not imply completion.

One execution slot covers both harnesses. Ambiguous prompt admission retains the
slot and reconnects without automatic resubmission. Closing the bridge stops OC
observation, not native execution. Restart observes the recorded sending/accepted
command; a preparing run fails without submission. CC still uses process-group
shutdown and explicit crash reconciliation. Storage failures block new execution.

Capabilities are per harness: CC offers model IDs and fixed effort levels; OC
supplies enabled models and exact native variants, pending permission/form replies,
and active-session interruption. A cancel response is not a terminal run event;
native reconciliation settles status. Neither adapter auto-answers interactions
or collects subscription/account usage. Unrelated native sessions and cross-harness
handoffs remain outside scope. The owner reports the installed OC integration
working; individual recovery/interaction edge cases have not all been established.

## Future suggestions — not implemented

[Terminal research](TERMINAL-RESEARCH.md) retains the historical API investigation,
selected implementation, and remaining owner review. Terminal multiplicity is now
one per worktree; SANE workstream integration remains deferred.

Preserve the owner-reported CC/OC baseline while the owner evaluates Code/Git on
desktop and physical mobile devices. Potential follow-ups include durable local
draft recovery, stronger native-writer coordination, bounded buffer eviction,
chat-to-file/line navigation, more language packages, and configurable themes.
These are improvement candidates rather than guarantees of this PoC.

[SANE-FOLLOW-UP.md](SANE-FOLLOW-UP.md) records optional workstream membership,
harness-qualified identity, invocation context, and CLI audit proposals separately
from the implemented repository catalog.
