# Notifications

Workstreams uses repository-scoped notification config at:

`work/notifications.json`

## Events

- `thread_complete`
- `batch_complete`
- `error`

## Providers

- `sound`
- `notification_center`
- `terminal_notifier`
- `tts` (reserved/future)

## Quick Check

```bash
work notifications
work notifications --json
```

## Notes

- `work multi --silent` disables audio notifications for that run.
- Legacy global config (`~/.config/agenv/notifications.json`) is still supported as a fallback.
