# Changelog

All notable changes to `@agenv/workstreams` are documented in this file.

## 0.7.1 - 2026-04-21

- Completed the sqlite-authoritative cutover for core workflow state, including canonical sqlite reads and writes for approvals, task/runtime updates, revision/fix flows, bootstrap, hydration, and compatibility rebuild tooling.
- Improved existing-repo migration behavior by supporting orphan legacy workstream discovery during sqlite hydration and keeping fresh `work init --sqlite --force` bootstraps free of unnecessary compatibility index creation.
- Hardened sqlite runtime behavior and persisted identifier handling with better lock tolerance, scoped compatibility rebuild behavior, and canonical normalization for stage/batch/thread/task IDs across supervision and runtime state.

## 0.7.0 - 2026-04-20

- Made `work/db.sqlite` the local-first canonical structured store, with `work/index.json` and `work/<stream-id>/tasks.json` retained as compatibility projections for inspection and older file-shaped consumers.
- Documented the sqlite source-of-truth model, compatibility projection boundaries, package-boundary direction, and deferred follow-up work such as permanent legacy-file removal and future remote/service-backed storage.
- Hardened approval auto-commit behavior by preventing duplicate stage re-approval commits and rejecting unsafe fallback/generic approval naming in commit messages.

## 0.6.1 - 2026-04-18

- Removed automatic implementation-thread opencode session title tagging from thread execution commands while preserving plain thread titles for operator visibility.
- Removed automatic post-run title-based opencode session discovery/linking for implementation threads, leaving the existing runtime session-link fields in place for a future explicit linking flow.
- Added regression coverage around multi-run/finalization behavior to keep core execution, supervision, and batch monitoring stable after the session-tagging cleanup.

## 0.6.0 - 2026-04-18

- Removed obsolete user-facing workstream surfaces including `work fix` remnants and the `work synthesis` command/module stack.
- Standardized runtime-state guidance around `tasks.json.runtime_state`, reducing stale references to legacy `threads.json` and `supervisor-state.json` files.
- Refreshed workstream workflow documentation to reflect the current planning → supervision → stage approval → evaluation lifecycle.

## 0.5.3 - 2026-04-17

- Extended supervision timeout handling so longer-running branch and batch execution paths recover more predictably without spurious interruptions.
- Improved reset/resume behavior around batch state and supervisor state persistence to make reruns and recovery safer.
- Continued runtime-state cleanup for threads, tasks, and supervision metadata used by the modern `work supervise` workflow.

## 0.5.2 - 2026-04-17

- Added reusable workstream read models for status/tree/list-style views backed by canonical runtime state.
- Added Bun dashboard/server support modules, dashboard-facing internal contracts, and backend observability/snapshot helpers.
- Improved runtime-state migration and dashboard/server test coverage around status projections, tree views, reset-batch-state, and server helpers.

## 0.5.1 - 2026-04-15

- Stabilized the first Root Agent supervision/runtime-tooling release with follow-up fixes to approvals, supervision prompts, and persisted execution state handling.
- Continued cleanup of legacy docs/runtime behavior around the newer branch-supervision flow.
- Expanded test coverage around approval resolution, review compatibility, and supervision state persistence.

## 0.5.0 - 2026-04-15

- Added the workstreams tool runtime plus Root Agent custom-tool integration for launching, finalizing, reconciling, and inspecting supervision sessions.
- Added durable Root Agent / branch supervision state management, scoped branch prompts, tmux/opencode launch helpers, and session export utilities.
- Expanded approval, review, multi-run, and supervision flows to support the newer branch-based orchestration model.

## 0.4.1 - 2026-04-14

- Simplified supervision timeout handling so the latest branch and Root-Agent live-test paths behave more predictably under the new headless child-session execution model.
- Simplified default configuration and runtime defaults around branch supervision launch behavior, including cleaner breakpoint-mode handling and less prompt-visible execution plumbing.
- Refined Root Agent / branch supervision prompting and skills so branch execution stays more user-like while preserving durable runtime-owned context resolution.

## 0.4.0 - 2026-04-14

- Added the Root Agent supervision architecture for `work supervise`, including headless batch execution, durable supervisor state, and recovery-oriented supervision primitives.
- Added Root-Agent-owned branch supervision with metadata-only checkpoints, message-boundary branch launching, scope-aware branch tracking, auto-resolved branch context, and parent-side final report extraction.
- Expanded supervision documentation, smoke-test fixtures, and runtime diagnostics, and cleaned up related typecheck and docs drift ahead of release.

## 0.3.1 - 2026-02-23

- Fixed built CLI runtime import paths so dynamic imports are rewritten from `.ts` to `.js`, resolving module load failures such as `Cannot find module '../lib/repo.ts'` when running commands like `work prompt --stage 6` from the published package.
- Updated prompt and multi-navigator CLI modules to use static imports in key paths, avoiding dist/runtime extension mismatch for dynamically loaded local modules.
- Updated multi-orchestrator grid controller to prefer `dist/bin/work.js` and fall back to `bin/work.ts` only when needed, improving reliability in packaged builds.
- Enhanced `work tasks serialize` to auto-generate prompts after writing `tasks.json`, so prompts are produced in manual serialize flows even when approvals are already in an approved state.
- Added prompt generation result reporting to `work tasks serialize`, including warning output when partial prompt generation failures occur.
