# Human Operator Guide

This is a working single-user PoC, not a hardened deployment. The owner reports
both CC and OC integrations working, including managed OpenCode authentication.
Verification and visual review remain with the owner.
The owner also reports the prior workspace baseline working. The current navigation
revision and new Terminal implementation remain unverified; terminal backend
integration is being completed. Detailed edge-case and physical-device checks remain pending.

## Installation and sign-in

Install Bun, Claude Code, and OpenCode V2 using their supported installation
instructions. Harness installation remains separate from bridge installation.
The owner reports native Bun **1.4.2**. Terminal uses native `Bun.Terminal`,
documented from Bun **1.3.5** on macOS/Linux; this is a documented API minimum,
not a verified terminal compatibility result.
Install native Git on the bridge host and make `git` available on PATH for Git Diff.
Use the intended OS user consistently; managed OC discovery depends on the same
home/XDG environment. Sign into CC through `claude auth login` using its subscription
flow, and configure OC providers through OpenCode's own interface.

Install bridge dependencies:

```sh
cd /Users/beto/sane/poc/cc-web
bun install --frozen-lockfile --ignore-scripts
```

References: [CC setup](https://code.claude.com/docs/en/setup),
[OC V2 documentation](https://opencode.ai/v2/docs/), and
[managed service environment](https://opencode.ai/v2/docs/network/).

## Recommended startup

Persist the Exa setting used in this PoC:

```sh
opencode service set env OPENCODE_ENABLE_EXA 1
opencode service start
```

Changing a managed environment variable stops the existing service. Configure it
once, outside active work. On subsequent starts, only run:

```sh
opencode service start
```

Its dynamic loopback port is expected. The bridge discovers the registered URL
and authentication headers together. No `OPENCODE_SERVER_PASSWORD` or
`OPENCODE_TOKEN` is needed for this managed connection flow.

Start the bridge in another terminal:

```sh
cd /Users/beto/sane/poc/cc-web
bun run start --host 127.0.0.1 --port 18879 \
  --public-origin https://server.gecko-halibut.ts.net:18879
```

This builds React assets and starts the bridge. Omit `--opencode-url` in managed
mode. CC needs no separate server: its CLI starts only when a prompt is submitted.
These are human-run instructions, not commands executed for this extension.
The existing `bun run start` builds the editor along with Chat; no separate editor
server is needed. `bun run build` is the existing optional manual build-only command.

Keep the existing Tailscale Serve mapping running:

```text
https://server.gecko-halibut.ts.net:18879/
  proxy http://localhost:18879
```

Open that HTTPS URL on an authorized tailnet device. The mapping is the one
reported by the owner; an exact Tailscale CLI invocation was not recorded.
The bridge remains loopback HTTP. Optional `CC_WEB_PASSWORD` enables a separate
bridge login; it is not an OC service or provider credential.

## Explicit OpenCode endpoint alternative

`--opencode-url` bypasses discovery. A separately configured foreground
`opencode serve` endpoint can be selected with:

```sh
bun run start --host 127.0.0.1 --port 18879 \
  --public-origin https://server.gecko-halibut.ts.net:18879 \
  --opencode-url http://127.0.0.1:4096
```

Use its actual listening port. If it requires bearer authentication, privately
supply `OPENCODE_TOKEN` in the bridge environment. This does not convert a password
into a token or support Basic authentication through that variable. For a managed
service, remove the URL flag rather than copying credentials.

## Using Code and Git Diff

1. Open the topbar workspace button and search existing workspaces by name or path.
   To add one, choose the secondary **Open directory…** action and enter an absolute
   bridge-host path; **Back** returns to workspace selection. Use the topbar worktree
   button to choose the **Browsing worktree**. Context stays compact in the mobile
   topbar. No conversation is needed. Git registration
   resolves the closest repository root and discovers main and linked worktrees,
   including trees outside the main checkout. Code/Git cover the full selected
   tree. Confirmed non-Git folders are directory workspaces; operational Git errors
   do not silently open a folder instead. Use **Refresh worktrees** in the context
   dialog after external worktree changes; it preserves the current navigation.
2. Choose **Code** in the global **Chat / Code / Git / Terminal** navigation in the shared
   sidebar footer. On mobile, open the contextual
   navigation drawer first. Each view uses one shell header; Code and Git fill the
   content area with the editor or diff.
3. Expand folders in the lazy **Files** tree, which replaces conversation history.
   On mobile, the drawer shows the same tree with shared expansion and selection;
   activating a file closes it. Use **Refresh files** to refresh loaded listings.
   Open an existing writable UTF-8 file no larger than 256 KiB.
   Symlinks, hard links, protected paths, unsupported encodings, mixed EOL, binary,
   and oversized files cannot be edited. CodeMirror 6 uses the same warm-light
   palette as Chat; theme configuration is a future option, not a current setting.
4. Edit and use topbar **File actions → Save** or press **⌘S / Ctrl+S**. Switching files, views,
   worktrees, or conversations retains local buffers in this browser's memory. Conversations
   at the same canonical root share those buffers. Other devices see saved disk
   contents, not your unsaved text. Save before reloading the browser.
5. If disk changes, use **File actions → Compare disk**. **Reload** in that dialog asks before discarding local
   edits, as does explicit sign-out. Browser page reload has no implemented discard
   confirmation in the inspected source and loses buffers. A stale-save conflict
   preserves edits; there is no force-save or merge action. Copy important local
   changes before reloading. Revision checks do not lock out native/agent writers,
   and an unsuccessful in-place save can still have changed disk.
6. Choose **Git** and a file in its **Staged**, **Unstaged**, or **Untracked**
   directory tree, which replaces conversation history in the sidebar/drawer.
   These compare HEAD/index, index/saved disk, or empty/saved disk respectively.
   The topbar **Change actions** dialog offers previous/next text-change navigation.
   Unsaved buffer changes are excluded. Eligible entries offer **Open in Code** there, which
   opens the file and navigates directly to Code. There are no stage, discard,
   or commit controls.
7. Read mode/rename metadata and unavailable reasons alongside the text. Conflicts,
   submodules, symlinks, cross-workspace renames, binary/invalid UTF-8, and oversized
   contents cannot produce supported text diffs. EOL/BOM-only changes can show no
   text changes because display text is normalized. Truncated listings and failed
   Git requests are not evidence of a clean repository.

The selected file and Git view refresh on focus and roughly every five seconds
while visible. This is not immediate filesystem watching or an atomic repository
snapshot. The Chat activity indicator helps you return to an active run or pending
interaction; Chat remains mounted while hidden. Native Git operations remain in
your usual external workflow. Chat file links, reference parsing, and line/range
reveal are future work; the shared file-activation seam does not implement them.

The prior workspace baseline was reported working by the owner; this revised
navigation flow, physical mobile use, and detailed conflict cases remain pending.
See [LIMITS.md](LIMITS.md) for actual bounds and unsupported cases.

## Using the worktree Terminal

Choose **Terminal** in the sidebar/mobile navigation for the selected worktree.
It fills the main view with a warm-light xterm terminal. **Start terminal** starts
the shell explicitly at the full worktree root; opening the view does not start it.
One terminal is shared by conversations in that worktree and your other devices.
**Started in:** names its initial worktree, not the shell's current directory after
`cd`. Changing Chat or browsing context does not retarget an existing shell.

Initially you are **Viewing**. Choose **Use keyboard here** to control input, or
**Take control here** to take it from another attachment. **Release keyboard**
returns to viewing. Only the controller sends keys, Ctrl C, or shared terminal
resizes. The mobile key row provides **Keyboard** focus, **Ctrl C**, **Esc**, **Tab**,
and arrows. Paste uses terminal input; a message above 8 KiB is rejected rather
than queued. Viewers can scroll the shared-size screen without resizing it.

Leaving Terminal, changing worktrees, hiding the page, disconnecting, or signing
out releases keyboard control. Return/reconnect restores a bounded screen snapshot
and live output as a viewer. Choose control again explicitly; input is never
automatically replayed. **Reconnect** refreshes viewing, not the shell process.

**Close terminal** confirms stopping the shared shell for everyone. After exit or
close, **Restart terminal** explicitly starts a replacement at the worktree root.
Terminals run independently of the single CC/OC chat execution slot. They survive
view changes and browser reload/disconnect only while the bridge is alive. A bridge
restart loses terminal resources and screen history; there is no PTY reattachment.
Finish terminal work before planned shutdown. Cleanup attempts to stop the shell
and jobs, but detached/reparented jobs are not guaranteed to stop.

Use the existing Tailscale HTTPS address: terminal WSS shares that bridge port and
authentication/Origin boundary, with no extra port or route. Password-mode logout
revokes the login's sockets and control; it does not close the shared shell.
Resource/output limits may require fresh viewing or explicit terminal restart;
see [LIMITS.md](LIMITS.md). The new terminal is unverified: owner manual review of
ordinary use, reconnection/control handoff, and physical mobile interaction remains
pending, separate from the prior working baseline.

## Daily operation and recovery

- Workspace selection chooses browsing scope. New conversations default to that
  worktree root; Details can set a launch subdirectory before first submission.
  Existing conversations keep their execution cwd, harness, and association.
  If browsing differs, **Runs in:** identifies the execution worktree. Use **Browse
  execution worktree** to return, or **Execution details** when association IDs are absent.
  History groups conversations by workspace and offers a worktree filter.
- Open the topbar **Application menu** for connection status, **Connection details**,
  and **Reconnect**. **Sign out** appears when password authentication is enabled
  and asks before discarding dirty editor buffers.
- The backend owner bookmark restores workspace/worktree, conversation, view,
  selected file, and Git comparison across visits/devices. It does not move another
  live browser's selection or transfer unsaved text. A navigation conflict needs
  reconciliation with the saved bookmark; it is not a file-save conflict.
- Missing or changed worktree bindings block affected file access and continuation,
  while recorded conversation history remains accessible. There are no worktree
  creation, pruning, repair, or conversation-reassociation endpoints in this PoC.

- Select CC or OC for a new conversation; its harness is fixed afterward. Only
  app-created sessions appear. Unrelated native sessions remain out of scope.
- One chat execution runs at a time across both harnesses; worktree terminals use
  separate resources. Other devices
  share saved history; unsent drafts stay in browser memory and are lost on reload.
- Finish work before planned restarts. Ctrl-C stops the bridge. CC shutdown manages
  its owned process group; OC shutdown stops observation, not native execution.
- Restart with the same bridge data directory. OC recovery also needs the same
  native service storage; CC continuation needs its native conversation storage.
- After a CC crash, confirm surviving owned CLI processes have stopped before
  using `--reconcile-interrupted`. This is an operator assertion, not automatic
  orphan cleanup. See README recovery instructions for stale locks/storage errors.
- When submission acceptance is unknown, inspect recorded state before sending
  again. Automatic resend is deliberately disabled. Unresolved OC admission can
  retain the global slot; not every such case has a complete operator workflow yet.
- Do not delete metadata or locks merely to clear a busy indicator.

| Symptom | Action |
| --- | --- |
| Explicit URL error mentioning a token | In managed mode, remove `--opencode-url` and restart the bridge |
| No managed service found | Start it under the bridge's OS user/home/XDG environment |
| Service port changes | Keep the URL unspecified; discovery refreshes endpoint and headers |
| Host/Origin rejected | Use the exact configured HTTPS origin and proxy mapping |
| Native session missing after relocation | Check native storage and workspace paths, not only bridge logs |

Optional diagnostics for the human operator:

```sh
opencode service status
opencode api get /api/info
```

No commands were executed by agents for this documentation update.

## Storage and upgrades

Preserve bridge `.data` (or `--data-dir`), native harness storage, and workspace
files. Logs alone do not guarantee native continuation. Use quiescent or
native-supported backups rather than assuming copies of active stores are consistent.
The data directory now includes `catalog.json` for stable repository/worktree IDs
and associations, and `navigation.json` for the separate owner bookmark. Initial
migration preserves existing metadata as `metadata.pre-catalog.json` and records
unresolved associations for missing/unresolvable old cwd paths without discarding
history. Re-registering does not repair a changed binding or reassociate an old
conversation. Preserve these files with metadata and event logs during upgrades.
Record Bun, CC, OC, and bridge revision for a compatibility baseline. Pinned client
dependencies do not prevent independently installed harness contracts changing.

## Suggestions for the final implementation — not implemented

1. **Setup/start entrypoint:** locate dependencies, guide official installation,
   configure workspace/data paths, discover OC, and start the bridge without
   replacing existing harness settings or storage.
2. **Explicit lifecycle ownership:** distinguish user-owned services from services
   started by the app. Any managed auto-start should be opt-in; closing the UI
   must not stop a shared OC service.
3. **Installation/version policy:** record supported versions, upgrades and rollback
   procedures. Keep provider sign-in in supported native flows.
4. **Supervised startup:** consider launchd or a platform equivalent for boot/login
   startup, logs, restart ordering, and graceful shutdown.
5. **Actionable diagnostics:** distinguish discovery, auth, schema, provider setup,
   and browser proxy errors without exposing credentials.
6. **Recovery workflows:** provide inspect/reconcile actions for uncertain admission,
   orphaned processes, stale locks, and removed native sessions.
7. **Durability at scale:** versioned migrations, backup/restore, retention,
   pagination, bounded memory, and incremental history projections.
8. **Submission reliability:** durable idempotency/admission reconciliation and
   explicit multi-device concurrency semantics before parallel executions.
9. **Workspace refinement:** durable unsaved-buffer recovery, native-writer
   coordination, buffer retention limits, chat-to-file navigation, broader syntax
   support, and configurable themes after owner feedback on the replacement views.

These are suggestions to evaluate, not current guarantees or a commitment to
implement everything before the next PoC feature.

SANE-specific proposals are in [SANE-FOLLOW-UP.md](SANE-FOLLOW-UP.md); they are not
current membership or phase-handoff functionality; workstream integration remains
deferred. [TERMINAL-RESEARCH.md](TERMINAL-RESEARCH.md) records the selected terminal
implementation, historical research, and remaining owner review.
