# Opencode Bang Commands

When using Opencode chat, prefix user-invoked CLI commands with `!`.

## Examples

```text
!work create --name draft-feature
!work current --set 000-draft-feature
!work validate requirements
!work plan create --stages 2
!work status
!work review plan
!work approve plan
!work start
!work complete
```

## Notes

- User approval commands should be run by the user with `!`.
- Draft-first setup commands like `!work create`, `!work current --set`, `!work validate requirements`, and `!work plan create` are also user-invoked when driving the workflow from chat.
- Session linking is tool-driven (`link_planning_session` with explicit `streamId`), not a `!work ...` CLI command.
- Agent-executed commands run directly without `!`.
- The manager's current supervision flow remains a bash invocation of
  `work supervise`; a future OpenCode plugin tool would be a facade over the
  same orchestration path, not a replacement for the detached executor.
