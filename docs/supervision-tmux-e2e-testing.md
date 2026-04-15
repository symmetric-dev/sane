# Supervision Tmux E2E Testing

This repo now has an opt-in E2E test that verifies a real Opencode session can call a tool which launches a tmux session running a real `opencode run ...` command, then resolves and exports that resulting session through the real export path.

## Run the E2E test

From the repo root:

```bash
RUN_OPENCODE_TOOL_E2E=1 OPENCODE_E2E_MODEL=openai/gpt-5.4-mini bun test agent/tools/workstream-opencode.e2e.test.ts
```

## Observe the tmux session while the test runs

In a separate terminal:

```bash
tmux list-sessions
```

The test creates a tmux session with a name like:

```text
e2e-tool-mnzjh1xz
```

Attach to it with:

```bash
tmux attach -t e2e-tool-mnzjh1xz
```

## What this validates

- Opencode can load and call a tool
- The tool can launch a tmux session
- That tmux session can run a real `opencode run ...` process
- The resulting native session can be found, exported, and parsed successfully

## Related runtime diagnostics

If you are debugging a live supervision launch rather than just the E2E test, also inspect:

```text
/tmp/agenv-workstream-tool.log
```

And remember that a stale ended session can now be recovered with:

```text
reconcile_workstream_supervision({ streamId: "001-your-stream" })
```

## Notes

- The E2E test is opt-in because it depends on a real model/provider setup.
- The deterministic companion test remains:

```bash
bun test agent/tools/workstream.test.ts
```

- Even when launch/transport works perfectly, semantic supervision success is still a separate prompt/model-compliance question.
