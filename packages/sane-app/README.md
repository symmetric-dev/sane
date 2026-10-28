# SANE App

Browser interface and Bun server for native Claude Code/OpenCode conversations,
workstreams, files, Git, terminals, browser sessions, and Python notebooks.

Use the [root quickstart](../../README.md#start) and
[operator guide](HUMAN-OPERATOR-GUIDE.md) to install, configure, and run the App.
For performance investigation, see [profiling](PROFILING.md).

## Entry points and interfaces

- [setup.ts](setup.ts) — explicit App-store initialization and saved configuration.
- [start.ts](start.ts) / [server.ts](server.ts) — foreground launch and shutdown.
- [src/app-config.ts](src/app-config.ts) — configuration schema and resolution.
- [src/bridge.ts](src/bridge.ts) — HTTP/WebSocket routes and service composition.
- [frontend/main.tsx](frontend/main.tsx) — frontend entry point.
- [shared/](shared/) — browser/backend contracts; service-specific contracts also
  live beside their implementations in `src/`.
- [../sane-core/](../sane-core/) — repository-domain interfaces.
- [../sane-science/](../sane-science/) — Python environment and notebook interfaces.
- [../sane-cli/src/native-configuration.ts](../sane-cli/src/native-configuration.ts)
  and [../../opencode/plugins/sane/](../../opencode/plugins/sane/) — native runtime integration.
- [scripts/context-report/](scripts/context-report/) — offline context-evidence reporting.

Run development commands from the repository root; see [package.json](../../package.json)
for workspace scripts. Configuration, App history, generated assets, and locks are
local runtime state, not source files to commit.
