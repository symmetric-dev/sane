# Headless Mode for `work continue`

Research and implementation plan for running `work continue` without attaching to the tmux session, enabling async batch execution with status polling from calling opencode sessions.

## Current Architecture

The `work continue` command flows through:

```
work continue
  -> cli/continue.ts    (session-aware pre-check, interactive prompt)
  -> cli/multi.ts       (resolves batch, discovers threads, spawns tmux)
  -> lib/multi-orchestrator.ts  (thread discovery, grid layout, command building)
  -> lib/tmux.ts        (tmux session CRUD, pane management)
  -> lib/opencode.ts    (shell command generation for opencode run)
  -> lib/marker-polling.ts      (polls /tmp marker files for completion)
```

The **blocking point** is `attachSession()` in `multi.ts` (line 803), which spawns `tmux attach -t {session}` with `stdio: "inherit"`, taking over the terminal. Everything after that (`child.on("close", ...)`) only fires when the user detaches or the session dies.

## What Already Works Without Attach

The tmux session is created detached (`tmux new-session -d`). All panes, the grid layout, and opencode processes are fully functional before `attachSession()` is ever called:

- tmux session creation -- already detached
- `opencode run` in panes -- runs inside tmux panes via piped stdin, no terminal interaction needed
- `opencode serve` -- already a detached/unref'd background process
- `opencode run --format json` -- already used for headless synthesis runs
- Completion marker files -- written by shell scripts in panes, not by the parent process
- Session ID capture -- also done by shell scripts in panes
- `opencode session list`, `opencode export` -- CLI commands, no TUI needed

## What Breaks in Headless Mode

| Component | Issue | Fix |
|-----------|-------|-----|
| `attachSession()` | Takes over terminal, blocks parent | Skip entirely in headless mode |
| `child.on("close")` handler | Won't fire since there's no attach | Need alternative completion detection |
| `handleSessionClose()` | Status finalization, session capture, synthesis capture, cleanup | Must be triggered by a monitor instead |
| `opencode --session $ID` (TUI resume) | Each pane's shell script ends by opening the TUI, which blocks waiting for user input | Skip in headless mode via env var |
| `read` fallback in shell scripts | "Press Enter to close" blocks the pane forever if session lookup fails | Replace with `exit` in headless mode |
| Grid controller | `multi-grid` TUI for pagination (>4 threads) | Skip in headless mode (no terminal) |
| `remain-on-exit: on` | Keeps dead panes alive for debugging | Set to `off` or actively kill session after completion |
| Marker polling | Runs in the parent process which may exit immediately in headless mode | Move to a persistent background monitor |
| Notification sounds | `NotificationTracker` plays sounds | Disable (irrelevant headless) |

## opencode Sessions in Headless Mode

`opencode run` with piped input works in any tmux pane without an attached terminal. The only interactive components are:

1. `opencode --session $SESSION_ID` at the end of each pane's shell script (opens TUI for user review)
2. `read` as a fallback when session lookup fails

Both are skippable. The approach is to set a `HEADLESS=1` tmux environment variable via `tmux set-environment -t {session} HEADLESS 1`, then check it in the shell scripts:

```bash
# Instead of unconditional TUI resume:
if [ "$HEADLESS" != "1" ] && [ -n "$SESSION_ID" ]; then
  opencode --session "$SESSION_ID"
fi

# Instead of blocking read:
if [ "$HEADLESS" = "1" ]; then exit 1; else read; fi
```

## Risks

| Risk | Severity | Mitigation |
|------|----------|-----------|
| Monitor process dies before completion | High | Write PID to status file; `work batch-status` can detect orphaned runs and re-spawn |
| tmux session leak (not cleaned up) | Medium | Monitor kills session on completion; `batch-status` can kill stale sessions |
| Status file corruption from concurrent writes | Medium | Use `proper-lockfile` (already a dependency) |
| `read` fallback blocking panes forever | Medium | Replace with headless-aware conditional |
| Calling LLM tool timeout too short | Low | Document recommended timeout; `--wait --timeout` handles internally |
| `opencode run` crashes in headless pane | Low | Existing retry logic + exit code tracking still works |
| Bun process memory leak in long-running monitor | Low | Monitor is ephemeral, exits when batch completes |

No new external dependencies are required. Everything builds on existing tmux, opencode, bun, and `proper-lockfile`.

## Async Execution Design

### Status File: `batch-status.json`

Written to `work/{streamId}/batch-status.json` by a background monitor process:

```typescript
interface BatchRunStatus {
  runId: string                // unique run identifier
  streamId: string
  batchId: string
  startedAt: string            // ISO timestamp
  completedAt?: string         // ISO timestamp when all done
  status: "running" | "completed" | "failed" | "partial"
  tmuxSession: string          // tmux session name for reattach
  monitorPid: number           // PID of background monitor process
  threads: {
    threadId: string
    threadName: string
    status: "running" | "completed" | "failed" | "interrupted"
    exitCode?: number
    completedAt?: string
    opencodeSessionId?: string
    hasSynthesisOutput?: boolean
  }[]
  summary: {
    total: number
    completed: number
    failed: number
    running: number
  }
}
```

### Background Monitor Process

A detached bun process that:

1. Polls `/tmp` completion markers (reuses existing `pollMarkerFiles` logic)
2. Updates `batch-status.json` on each thread completion
3. When all threads complete: runs finalization (the `handleSessionClose` equivalent -- captures session IDs, synthesis output, updates `threads.json`, cleans up temp files), kills the tmux session, marks batch as complete
4. Self-exits

Spawned as:

```typescript
const monitor = spawn("bun", [monitorScript, "--run-id", runId, ...], {
  detached: true,
  stdio: ["ignore", "pipe", "pipe"],
})
monitor.unref()
```

### Polling from an opencode Session

The calling LLM can poll status using a new CLI command:

```bash
# One-shot: returns current status as JSON immediately
work batch-status --stream X --format json

# Blocking: waits until done or timeout (retries internally every 30s)
work batch-status --stream X --wait --timeout 900 --format json
```

The `--wait` mode handles retry logic internally so the LLM only needs a single bash tool call with a ~15 minute timeout. If the tool environment doesn't support long timeouts, the LLM can issue discrete one-shot polls every 30 seconds.

## Implementation Plan

1. Add `--headless` and `--async` flags to `MultiCliArgs` and `parseCliArgs` in `cli/multi.ts`
2. Pass `--headless`/`--async` through from `cli/continue.ts`, skipping the interactive readline prompt in headless mode
3. Add `tmux set-environment` helper to `lib/tmux.ts`
4. Modify shell command builders in `lib/opencode.ts` (`buildRunCommand`, `buildRetryRunCommand`, `buildPostSynthesisCommand`) to check `$HEADLESS` env var and skip TUI resume + `read` fallback
5. Branch execution in `cli/multi.ts`: in headless mode skip `attachSession()`, skip grid controller setup, set `remain-on-exit: off`, set `HEADLESS=1` in tmux environment
6. Create `lib/batch-status.ts` with `BatchRunStatus` types and read/write/update helpers for `batch-status.json`
7. Create `lib/headless-monitor.ts` (and `bin/headless-monitor.ts` entry point) -- the detached background process that polls markers, updates `batch-status.json`, runs finalization on completion, kills the tmux session, and self-exits
8. In headless+async mode: spawn the monitor, write initial `batch-status.json`, and return immediately
9. In headless (non-async) mode: run the monitor inline (block until batch completes, then exit)
10. Create `cli/batch-status.ts` and register the `batch-status` subcommand in `bin/work.ts` -- supports `--format json`, `--wait`, `--timeout` flags
11. Add tests for headless command generation (verify no `opencode --session` or `read` in output), batch-status read/write, and monitor lifecycle
