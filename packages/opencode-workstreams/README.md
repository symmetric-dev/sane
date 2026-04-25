# @agenv/opencode-workstreams

OpenCode plugin package that exposes AgENV workstream tools.

The default profile is `manual`: the user manually `/fork`s a supervision session, so the Root Agent management launch tool is not exposed by default.

## Install

Add the plugin package to your OpenCode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@agenv/opencode-workstreams"]
}
```

OpenCode will install the plugin and its dependencies automatically.

To opt into the older Root Agent management-launch workflow, set the managed profile before starting OpenCode:

```bash
export AGENV_WORKSTREAMS_PROFILE=managed
```

## Provided tools

- `link_planning_session`
- `link_thread_session`
- `current_workstream`
- `finalize_workstream_supervision`
- `reconcile_workstream_supervision`
- `tool_runtime_info`

Managed profile only:

- `launch_supervision_branch`
