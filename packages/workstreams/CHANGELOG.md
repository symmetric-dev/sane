# Changelog

All notable changes to `@agenv/workstreams` are documented in this file.

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
