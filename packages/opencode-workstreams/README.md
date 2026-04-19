# @agenv/opencode-workstreams

OpenCode plugin package that exposes AgENV workstream tools.

## Install

Add the plugin package to your OpenCode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@agenv/opencode-workstreams"]
}
```

OpenCode will install the plugin and its dependencies automatically.

## Provided tools

- `link_planning_session`
- `link_thread_session`
- `current_workstream`
- `finalize_workstream_supervision`
- `reconcile_workstream_supervision`
- `tool_runtime_info`
- `launch_supervision_branch`
