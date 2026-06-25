# Using `work multi`

Run all threads in a batch in parallel using tmux.

## Commands

```bash
work multi --batch "01.01"
work multi --continue
work multi --batch "01.01" --dry-run
```

## Behavior

- Creates a tmux session per workstream
- Starts one window per thread
- Uses shared `opencode serve` (unless `--no-server`)
- Tracks thread completion and session IDs
- Requires each thread's `WORK.md` to exist before launch
- Generates the execution prompt in memory from thread context and the thread `WORK.md` path, then pipes it to `opencode run`
- Does not require persisted prompt files under `work/<stream>/prompts/`

## Useful Flags

- `--batch "SS.BB"`
- `--continue`
- `--dry-run`
- `--no-server`
- `--silent`
