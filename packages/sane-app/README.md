# SANE App

Browser App for native Claude Code/OpenCode conversations, repository/worktree
navigation, Code, Git and Terminal. Start with the [App documentation](../../docs/sane-app/README.md)
and [ongoing work](../../docs/sane-app/ongoing/README.md).

Private Bun workspace package. Chat, workspace navigation, Code, Git and
Terminal retain their source behavior. CC uses the installed `claude -p` and
native continuation; OC connects to an existing V2 service through
`@opencode/client`. Concurrent CC/OC runs are admitted, one App-owned run per
native conversation, default bridge capacity 24 (configurable 1–256 with
`--max-concurrent-runs`). Shared-checkout writes are allowed.

## Owner installation and launch

Use [HUMAN-OPERATOR-GUIDE.md](HUMAN-OPERATOR-GUIDE.md) for exact commands.
There is no app-local lockfile; dependency versions follow the workspace root.
The launch contract is loopback binding, an explicit independent scratch
repository cwd, and a fresh absolute data path. `start` builds package-local
`public/assets/app.js` and `app.css` before launching source `server.ts`;
`build` builds assets only; `typecheck` checks backend, hooks and frontend.

## Install the browser interface

Open the App at a stable localhost/loopback URL or a trusted HTTPS origin. Use
**Install SANE** in the Application menu or Settings → Application when the browser
offers an install prompt. Otherwise use the browser's installation menu, Safari's
**File → Add to Dock** on Mac, or **Share → Add to Home Screen** on iPhone/iPad.

Installation creates a standalone frontend window, not a background App server or
native services. The bridge must remain running and reachable. No service worker,
offline cache, or queued offline mutations are installed. After updating, restart
the bridge and reload the installed app just as you would a browser tab.

## Resource and identity boundaries

- Fresh app catalog UUIDs, conversation/run history, navigation, settings and locks
  belong to this store. Do not import, copy or link other runtime data or resume
  foreign native conversation IDs.
- Login uses HTTP-only `sane_app`. Exact Host/Origin validation and terminal
  revocation remain in place.
- Git common-directory identity groups main/linked worktrees; independent clones
  stay distinct. Browsing, conversation execution cwd and terminal start directory
  are separate contexts. Stale/missing bindings fail rather than retarget execution.
- CC authentication/native storage, OC service storage, installed plugins and
  terminal HOME/PATH remain external/shared. A second bridge is not a
  cross-process scheduler.

## References

[TERMINAL-RESEARCH.md](TERMINAL-RESEARCH.md) records the PTY design. Code saves
retain optimistic revision checks and size/encoding/path limits; Git views remain
read-only. Unsaved buffers are browser-memory-only. Terminals require explicit
start/control, reconnect as viewers and do not survive bridge restart. Native
continuation requires both App history and the same native storage. Ambiguous
submissions are not automatically retried.
