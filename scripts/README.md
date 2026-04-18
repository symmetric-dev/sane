# Preview Scripts

Manual testing scripts for tmux-based workstream execution features.

These scripts allow you to test multi-threaded execution and grid layouts without setting up a full workstream environment. They use small, fast models and mock prompts for quick feedback.

## Available Scripts

### 1. preview-multi.ts

**Purpose:** Test multi-thread execution with tmux grid layout

**What it tests:**
- Grid layout (2x2) for up to 4 threads
- Pagination for 5+ threads
- Parallel execution of multiple mock prompts
- Session tracking and cleanup

**Usage:**
```bash
bun run scripts/preview-multi.ts [--threads N]
```

**Options:**
- `--threads N` - Number of threads to spawn (default: 4, max: 8)
- `--help, -h` - Show help message

**Example:**
```bash
# Test with 4 threads (default 2x2 grid)
bun run scripts/preview-multi.ts

# Test with 6 threads (2x2 grid + pagination)
bun run scripts/preview-multi.ts --threads 6
```

**What to verify:**
- All threads run in parallel
- Grid layout displays correctly
- Session resumes work after completion
- Ctrl+b X kills the session cleanly

**Mock prompts used:**
- Simple commands like "Say hello", "List files", "Show date"
- Each thread runs with `claude-3-5-haiku-latest` for speed

---

### 2. preview-grid.ts

**Purpose:** Standalone visual tester for 2x2 grid layout

**What it tests:**
- Correct 2x2 grid creation (not 1+3 or other layouts)
- Pane positioning and sizing
- Visual verification of grid structure

**Usage:**
```bash
bun run scripts/preview-grid.ts
```

**Options:**
- `--help, -h` - Show help message

**Example:**
```bash
bun run scripts/preview-grid.ts
```

**What to verify:**
- All 4 panes are visible
- Layout is 2x2 (two rows, two columns)
- Panes are roughly equal in size
- Each pane shows its correct position:
  - Top-Left (1/4)
  - Top-Right (2/4)
  - Bottom-Left (3/4)
  - Bottom-Right (4/4)

**Expected layout:**
```
┌──────────────┬──────────────┐
│  TOP-LEFT    │  TOP-RIGHT   │
│   (1/4)      │    (2/4)     │
├──────────────┼──────────────┤
│ BOTTOM-LEFT  │ BOTTOM-RIGHT │
│   (3/4)      │    (4/4)     │
└──────────────┴──────────────┘
```

**Controls:**
- `Ctrl+b X` - Kill session and exit

---

## General Tips

### Prerequisites

1. **tmux** must be installed:
   ```bash
   brew install tmux  # macOS
   apt install tmux   # Linux
   ```

2. **opencode** must be available in PATH

3. **bun** must be installed for running scripts

### Session Management

All scripts create tmux sessions that can be managed with standard tmux commands:

- **Attach to session:** `tmux attach -t <session-name>`
- **Kill session:** `tmux kill-session -t <session-name>`
- **List sessions:** `tmux ls`
- **Detach from session:** `Ctrl+b d`
- **Kill session from inside:** `Ctrl+b X` (custom binding)

### Session Names

- `preview-multi` - Multi-thread execution script
- `preview-grid` - Grid layout tester

### Cleanup

- **preview-multi.ts:** Temp directory is auto-cleaned on exit
- **preview-grid.ts:** No cleanup needed (just kill session)

### Model Selection

Scripts use `claude-3-5-haiku-latest` by default for:
- Fast execution
- Lower cost
- Sufficient for simple test prompts

You can modify the scripts to test with different models if needed.

---

## Troubleshooting

### "Session already exists" error

If you see this error, a previous session wasn't cleaned up:

```bash
# List all tmux sessions
tmux ls

# Kill specific session
tmux kill-session -t preview-multi
tmux kill-session -t preview-grid

# Or kill all sessions
tmux kill-server
```

### "opencode serve not running" error

The multi script needs `opencode serve` running:

```bash
# Start manually
opencode serve --port 4096

# Or let the script start it automatically
```

### Grid layout is wrong (1+3 instead of 2x2)

This indicates a bug in `createGridLayout()` function. Check:
- Split sequence in `packages/workstreams/src/lib/tmux.ts`
- Pane targeting logic
- Split percentages

Use `preview-grid.ts` to visually debug the layout.

### Session tracking not working

Check:
- `tasks.json` → `runtime_state.threads` has session records
- `threads.json` only if validating legacy migration/compatibility behavior
- Session IDs match if both canonical and legacy files are being compared

---

## Development Workflow

When developing tmux features:

1. **Test grid layout first:**
   ```bash
   bun run scripts/preview-grid.ts
   ```
   Verify the 2x2 grid looks correct before adding complexity.

2. **Test multi-thread execution:**
   ```bash
   bun run scripts/preview-multi.ts --threads 4
   ```
   Start with 4 threads, then test pagination with 6+.

3. **Iterate:** Make changes to tmux.ts and re-run preview scripts to verify behavior.

---

## Contributing

When adding new preview scripts:

1. Create `scripts/preview-<feature>.ts`
2. Add usage instructions to this README
3. Include cleanup logic if creating temporary files
4. Use small, fast models for testing
5. Add help text (`--help` flag)
6. Make scripts executable: `chmod +x scripts/preview-<feature>.ts`

---

## Related Files

- `packages/workstreams/src/lib/tmux.ts` - tmux session management
- `packages/workstreams/src/cli/multi.ts` - multi-thread execution
- `packages/workstreams/src/lib/opencode.ts` - opencode server management
