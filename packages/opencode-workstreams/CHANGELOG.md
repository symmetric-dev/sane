# Changelog

All notable changes to `@agenv/opencode-workstreams` are documented in this file.

## 0.2.1 - 2026-06-25

- Removed the `current_workstream` tool from the exposed OpenCode plugin tools; agents should use the `work current` CLI command explicitly when needed.
- Required `link_planning_session` callers to pass an explicit `streamId` instead of relying on repository current state.

## 0.2.0 - 2026-06-08

- Removed the disabled branch-supervision finalization tool from the exposed OpenCode plugin tools.
- Rebuilt package artifacts so the published plugin matches the manual `work supervise` workflow.

## 0.1.1 - 2026-04-24

- Made the manual supervision profile the default so users manually `/fork` supervisor sessions.
- Hid the Root Agent `launch_supervision_branch` management tool by default.
- Added `AGENV_WORKSTREAMS_PROFILE=managed` as the opt-in path for the older Root Agent management-launch workflow.

## 0.1.0 - 2026-04-24

- Published the initial OpenCode plugin package exposing AgENV workstream tools.
