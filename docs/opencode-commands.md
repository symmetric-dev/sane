# Opencode Bang Commands

When using Opencode chat, prefix user-invoked CLI commands with `!`.

## Examples

```text
!work create --name draft-feature
!work current --set 000-draft-feature
!work plan create --stages 2
!work status
!work review plan
!work approve plan
!work approve tasks
!work start
!work complete
```

## Notes

- User approval commands should be run by the user with `!`.
- Draft-first setup commands like `!work create`, `!work current --set`, and `!work plan create` are also user-invoked when driving the workflow from chat.
- Agent-executed commands run directly without `!`.
