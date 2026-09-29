# Terminal research and selected implementation

## Status and evidence

The earlier terminal deferral depended on repository/worktree identity decisions.
The catalog now supplies those identities, and the selected implementation is
**one terminal per worktree**, independent of conversation and harness execution.
Frontend and terminal service source are present; backend integration is being
completed. The terminal implementation remains unverified. The owner's prior
CC/OC/workspace success reports do not establish this new feature's behavior.
SANE workstream membership and phase integration remain deferred.

The owner reports **native Bun 1.4.2**. Bun documents `Bun.Terminal` from **1.3.5**
on macOS/Linux; that historical minimum is not a tested runtime matrix. This
documentation pass used source reading only and ran no commands, builds, tests,
typechecks, browsers, servers, harness calls, or runtime verification.

## Selected building blocks

- Native `Bun.Terminal` and an interactive host shell, initially at the selected
  worktree root. No separate PTY daemon or bridge-restart reattachment is provided.
- Browser `@xterm/xterm` **5.5.0** and `@xterm/addon-fit` **0.10.0** for a full
  Terminal view and controller-owned sizing.
- Server `@xterm/headless` **5.5.0** and `@xterm/addon-serialize` **0.13.0** for
  bounded screen/scrollback snapshots. These are current `package.json` declarations,
  not verified package compatibility results.
- `src/terminal-contract.ts` defines lifecycle and ordered WebSocket messages;
  `src/terminal.ts` owns resources, snapshots, control, limits, and cleanup.
  `frontend/terminal-client.ts` applies snapshots/deltas through xterm and acknowledges
  completed writes; `frontend/terminal.tsx` supplies the worktree view and controls.

## Selected behavior

Only explicit **Start terminal** or **Restart terminal** creates a shell. **Close
terminal** stops it for all viewers. Exit and reconnect never create replacements.
One resource belongs to a catalog workspace/worktree pair with a pinned binding;
changed bindings do not silently retarget it. **Started in:** is launch context,
not live cwd. Shell `cd`, chat launch cwd, and workspace browsing remain independent.
The terminal does not consume the CC/OC execution slot or attach to harness runs.

Same-owner devices attach as viewers. Explicit claim/takeover grants one keyboard
controller, with generation checks enforced server-side for input and resizing.
Release, navigation away, page hiding, disconnect, and logout relinquish control.
Reconnect may restore viewing but never auto-claims input or replays keystrokes.
The warm-light view includes mobile keyboard focus, Ctrl C, Esc, Tab, and arrows;
viewers scroll the shared-size screen without controlling PTY dimensions.

Attachments receive a snapshot at a complete parser/byte boundary, then ordered
output and resize messages. Browser acknowledgements follow xterm application,
not message receipt. Scrollback, serialized snapshots, resource counts, queues,
input, and retention are bounded. Slow clients or retention gaps require a fresh
attachment/snapshot; server screen/parser/backlog overload may stop the resource
and require explicit restart. This is not an unlimited transcript or a guarantee
of full-screen/alternate-buffer restoration fidelity. Current bounds are recorded
in [LIMITS.md](LIMITS.md).

The route contract shares the bridge's existing authentication and exact configured
Origin boundary before WebSocket upgrade. Login revocation closes its attachments
and releases control. Existing Tailscale HTTPS/WSS uses the same bridge port and
route surface; no extra listener is needed. Backend integration remains unverified.

Shell and screen state survive browser/view changes only while the bridge lives.
Close/shutdown attempts bounded shell/process-group signaling and PTY hangup with
escalation. macOS shell job control and detached/reparented processes limit cleanup:
there is no all-descendants-stopped guarantee, durable terminal recovery, or blind
signaling of persisted PIDs. Restart refuses an unconfirmed prior shell exit.

## Historical research references

These were the candidate APIs in the original deferred research and are now the
selected implementation surfaces. Links describe APIs, not observed behavior here.

- [Bun 1.3.5 release — Terminal API](https://bun.sh/blog/bun-v1.3.5)
- [Bun child processes and PTYs](https://bun.sh/docs/runtime/child-process)
- [Bun server WebSockets, upgrades, and backpressure](https://bun.sh/docs/api/websockets)
- [xterm.js documentation](https://xtermjs.org/docs/)
- [xterm.js addon usage](https://xtermjs.org/docs/guides/using-addons/)
- [Official xterm.js repository — headless and addons](https://github.com/xtermjs/xterm.js)
- [Fit addon](https://github.com/xtermjs/xterm.js/tree/master/addons/addon-fit)
- [Serialize addon](https://github.com/xtermjs/xterm.js/tree/master/addons/addon-serialize)

## Remaining owner review

Manual review remains for the integrated terminal's ordinary shell use, snapshot
and resize fidelity, multi-device control handoff, logout/reconnect behavior,
resource limits/cleanup, and physical mobile interaction. These are open evidence
areas, not tested results or agent verification instructions. Record actual owner
observations separately from the prior working baseline in [LIMITS.md](LIMITS.md).
