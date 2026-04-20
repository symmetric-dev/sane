import type {
  StructuredStorageStateAdapter,
  StructuredStorageWorkspaceState,
  StructuredStorageWorkstreamState,
} from "./structured-storage.ts"
import {
  bootstrapSqliteStructuredStorage,
  recordSqliteStructuredStorageMirrorState,
  syncStructuredStorageWorkspaceStateToSqlite,
  syncStructuredStorageWorkstreamStateToSqlite,
  type SqliteStructuredStorageMirrorState,
} from "./sqlite-storage.ts"

export interface FilesystemAuthoritativeSqliteStructuredStorageAdapterOptions {
  onSqliteMirrorStateChange?: (state: SqliteStructuredStorageMirrorState) => void
}

function reportSqliteMirrorState(
  options: FilesystemAuthoritativeSqliteStructuredStorageAdapterOptions | undefined,
  args: Parameters<typeof recordSqliteStructuredStorageMirrorState>[0],
): SqliteStructuredStorageMirrorState {
  const state = recordSqliteStructuredStorageMirrorState(args)
  options?.onSqliteMirrorStateChange?.(state)
  return state
}

function ensureSqliteBootstrap(args: {
  repoRoot: string
  operation: string
  streamId?: string
  options?: FilesystemAuthoritativeSqliteStructuredStorageAdapterOptions
}): boolean {
  try {
    bootstrapSqliteStructuredStorage(args.repoRoot)
    reportSqliteMirrorState(args.options, {
      repoRoot: args.repoRoot,
      operation: args.operation,
      phase: "bootstrap",
      result: "success",
      ...(args.streamId ? { streamId: args.streamId } : {}),
    })
    return true
  } catch (error) {
    reportSqliteMirrorState(args.options, {
      repoRoot: args.repoRoot,
      operation: args.operation,
      phase: "bootstrap",
      result: "error",
      ...(args.streamId ? { streamId: args.streamId } : {}),
      error,
    })
    return false
  }
}

async function syncWorkspaceMirror(args: {
  delegate: StructuredStorageStateAdapter
  repoRoot: string
  operation: string
  streamId?: string
  options?: FilesystemAuthoritativeSqliteStructuredStorageAdapterOptions
  workspaceState?: StructuredStorageWorkspaceState
}): Promise<StructuredStorageWorkspaceState | null> {
  try {
    const workspaceState = args.workspaceState ?? (await args.delegate.loadWorkspaceState(args.repoRoot))
    syncStructuredStorageWorkspaceStateToSqlite(args.repoRoot, workspaceState)
    reportSqliteMirrorState(args.options, {
      repoRoot: args.repoRoot,
      operation: args.operation,
      phase: "workspace",
      result: "success",
      ...(args.streamId ? { streamId: args.streamId } : {}),
    })
    return workspaceState
  } catch (error) {
    reportSqliteMirrorState(args.options, {
      repoRoot: args.repoRoot,
      operation: args.operation,
      phase: "workspace",
      result: "error",
      ...(args.streamId ? { streamId: args.streamId } : {}),
      error,
    })
    return null
  }
}

function syncWorkstreamMirror(args: {
  repoRoot: string
  operation: string
  workstreamState: StructuredStorageWorkstreamState
  options?: FilesystemAuthoritativeSqliteStructuredStorageAdapterOptions
}): void {
  try {
    syncStructuredStorageWorkstreamStateToSqlite(args.repoRoot, args.workstreamState)
    reportSqliteMirrorState(args.options, {
      repoRoot: args.repoRoot,
      operation: args.operation,
      phase: "workstream",
      result: "success",
      streamId: args.workstreamState.streamId,
    })
  } catch (error) {
    reportSqliteMirrorState(args.options, {
      repoRoot: args.repoRoot,
      operation: args.operation,
      phase: "workstream",
      result: "error",
      streamId: args.workstreamState.streamId,
      error,
    })
  }
}

export function createFilesystemAuthoritativeSqliteStructuredStorageAdapter(
  delegate: StructuredStorageStateAdapter,
  options?: FilesystemAuthoritativeSqliteStructuredStorageAdapterOptions,
): StructuredStorageStateAdapter {
  return {
    kind: "filesystem-authoritative-sqlite-dual-write",

    async loadWorkspaceState(repoRoot: string) {
      ensureSqliteBootstrap({ repoRoot, operation: "loadWorkspaceState", options })
      return delegate.loadWorkspaceState(repoRoot)
    },

    async replaceWorkspaceState(repoRoot: string, workspaceState) {
      await delegate.replaceWorkspaceState(repoRoot, workspaceState)
      if (ensureSqliteBootstrap({ repoRoot, operation: "replaceWorkspaceState", options })) {
        await syncWorkspaceMirror({
          delegate,
          repoRoot,
          operation: "replaceWorkspaceState",
          options,
          workspaceState: structuredClone(workspaceState),
        })
      }
    },

    async modifyWorkspaceState(repoRoot: string, fn) {
      const result = await delegate.modifyWorkspaceState(repoRoot, fn)
      if (ensureSqliteBootstrap({ repoRoot, operation: "modifyWorkspaceState", options })) {
        await syncWorkspaceMirror({
          delegate,
          repoRoot,
          operation: "modifyWorkspaceState",
          options,
        })
      }
      return result
    },

    async loadWorkstreamState(repoRoot: string, streamId: string) {
      ensureSqliteBootstrap({ repoRoot, operation: "loadWorkstreamState", streamId, options })
      return delegate.loadWorkstreamState(repoRoot, streamId)
    },

    async replaceWorkstreamState(repoRoot: string, workstreamState) {
      await delegate.replaceWorkstreamState(repoRoot, workstreamState)
      if (
        ensureSqliteBootstrap({
          repoRoot,
          operation: "replaceWorkstreamState",
          streamId: workstreamState.streamId,
          options,
        })
      ) {
        await syncWorkspaceMirror({
          delegate,
          repoRoot,
          operation: "replaceWorkstreamState",
          streamId: workstreamState.streamId,
          options,
        })
        syncWorkstreamMirror({
          repoRoot,
          operation: "replaceWorkstreamState",
          workstreamState: structuredClone(workstreamState),
          options,
        })
      }
    },

    async modifyWorkstreamState(repoRoot: string, streamId: string, fn) {
      let nextWorkstreamState: StructuredStorageWorkstreamState | null = null
      const result = await delegate.modifyWorkstreamState(repoRoot, streamId, async (workstreamState) => {
        const callbackResult = await fn(workstreamState)
        nextWorkstreamState = structuredClone(workstreamState)
        return callbackResult
      })

      if (ensureSqliteBootstrap({ repoRoot, operation: "modifyWorkstreamState", streamId, options })) {
        await syncWorkspaceMirror({
          delegate,
          repoRoot,
          operation: "modifyWorkstreamState",
          streamId,
          options,
        })
        if (nextWorkstreamState) {
          syncWorkstreamMirror({
            repoRoot,
            operation: "modifyWorkstreamState",
            workstreamState: nextWorkstreamState,
            options,
          })
        }
      }

      return result
    },
  }
}
