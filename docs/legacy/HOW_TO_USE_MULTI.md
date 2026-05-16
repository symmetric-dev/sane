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

## Useful Flags

- `--batch "SS.BB"`
- `--continue`
- `--dry-run`
- `--no-server`
- `--silent`
