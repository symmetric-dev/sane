# Storage adapter package and refactor recommendation

See also [`LOCAL_FIRST_SQLITE_ARCHITECTURE.md`](./LOCAL_FIRST_SQLITE_ARCHITECTURE.md) for the local-first storage model this package recommendation assumes.

## Recommendation

Keep the structured storage stack inside `packages/workstreams` for the current migration phase.

That means the following should remain co-located for now:

- `src/lib/structured-storage.ts`
- `src/lib/storage-adapter.ts`
- `src/lib/sqlite-storage.ts`
- `src/lib/sqlite-storage-adapter.ts`
- the compatibility-facing wrappers that still translate between structured state and `index.json` / `tasks.json`

Do **not** split `storage-core`, `filesystem`, and `sqlite` into separate packages yet.

## Why they should stay in `packages/workstreams` initially

1. **The adapter boundary is real, but the package boundary is not clean yet.**
   `storage-adapter.ts` still depends directly on `index.ts` and `tasks.ts`, so extracting it now would mostly move a tightly-coupled cluster into another package without reducing coupling.
2. **Filesystem compatibility is still part of the product surface.**
   The current implementation still treats `index.json` and `tasks.json` as the authoritative store and uses sqlite as a filesystem-authoritative mirror.
3. **A lot of read paths still bypass the adapter.**
   Several CLI, status, and dashboard helpers still import `loadIndex`, `readTasksFile`, `getTasks`, `getTaskCounts`, or `getEffectiveRuntimeSummary` directly.
4. **Revision/fix flows still perform legacy file surgery.**
   `src/lib/fix.ts` rewrites task/runtime/approval artifacts directly and still assumes filesystem-native layout details.

## Direct filesystem helper dependencies that still need cleanup

These are the main dependencies that still block a clean extraction.

### 1. Workspace catalog helpers from `src/lib/index.ts`

Still used directly across CLI and library code:

- `loadIndex`, `getResolvedStream`, `resolveStreamId`, `findStream` in many CLI entry points
- `saveIndex` in mutation-oriented flows such as `src/lib/fix.ts`, `src/lib/complete.ts`, and `src/lib/approval-append.ts`
- `atomicWriteFile` in filesystem-oriented helpers such as `src/lib/tasks.ts`, `src/lib/plan-edit.ts`, and `src/lib/reset-batch-state.ts`

### 2. Task-file helpers from `src/lib/tasks.ts`

Still used directly outside the adapter layer:

- `readTasksFile` in `src/lib/status.ts`, `src/lib/batch-monitor.ts`, and `src/internal/server.ts`
- `readTasksFile` and related task grouping/runtime helpers in CLI views such as `src/cli/list.ts`, `src/cli/tree.ts`, `src/cli/continue.ts`, `src/cli/supervise.ts`, `src/cli/multi-grid.ts`, and `src/cli/multi-navigator.ts`
- `writeTasksFile` in `src/lib/fix.ts`
- `getTasksFilePath` as a compatibility path alias in `src/lib/threads.ts`, `src/lib/batch-status.ts`, and `src/lib/supervisor-state.ts`

### 3. Legacy artifact rewrites in `src/lib/fix.ts`

`src/lib/fix.ts` is still responsible for directly shifting or rewriting filesystem artifacts during revision insertion, including:

- task IDs and runtime state via raw `tasks.json` writes
- approval metadata via `loadIndex` / `saveIndex`
- legacy thread/supervisor artifact rewrites and prompt directory renames

This code should stay with `packages/workstreams` until the revision flow is expressed through storage-level mutation APIs instead of file-layout knowledge.

## Recommended future split

Once the cleanup above is done, extract in this order:

### 1. `packages/storage-core`

Move only pure contracts and pure data transforms:

- structured storage types from `structured-storage.ts`
- pure mutation helpers like `updateStructuredTask`, `replaceStructuredApprovals`, and parity snapshot builders
- storage interfaces for writes and read projections

This package should have **no** dependency on `fs`, repo paths, Bun sqlite, or CLI code.

### 2. `packages/storage-filesystem`

Move the filesystem implementation layer:

- `createFilesystemStructuredStorageAdapter`
- serialization/deserialization glue for `index.json` and `tasks.json`
- compatibility import/export code required while filesystem remains authoritative

### 3. `packages/storage-sqlite`

Move sqlite-specific implementation after parity and read-path cleanup are stable:

- schema/bootstrap code from `sqlite-storage.ts`
- sqlite projection sync helpers
- the filesystem-authoritative dual-write adapter first
- later, any sqlite-authoritative or service-backed implementation

## Service-backed architecture alignment

The next boundary should be a **storage/query contract**, not just a file reorganization.

In practice, that means:

- keep `packages/workstreams` as the workflow/CLI package
- let future dashboard/server code depend on stable read projections instead of `readTasksFile` / `loadIndex`
- make `storage-core` own contracts that a local filesystem adapter, embedded sqlite adapter, or future service/daemon can all implement

`src/internal/server.ts` is already a good hint for that direction: its read-only snapshot surface should eventually sit on top of storage/query interfaces rather than direct file helpers.

## Extraction gate

Treat package extraction as ready only when all of the following are true:

1. CLI and dashboard read paths no longer import raw `index.ts` / `tasks.ts` helpers for canonical state reads.
2. Revision/fix flows no longer need ad hoc `tasks.json` and approval rewrites.
3. Compatibility path aliases (`getThreadsFilePath`, `getBatchStatusFilePath`, `getSupervisorStateFilePath`) are either removed or isolated as legacy shims.
4. Sqlite is packaged as an implementation detail behind the same contracts that a future service-backed backend can implement.

Until then, the cleanest recommendation is:

> keep storage-core, filesystem, and sqlite inside `packages/workstreams` as internal modules now; extract them later as `storage-core`, `storage-filesystem`, and `storage-sqlite` packages only after the remaining direct filesystem helper dependencies are removed.
