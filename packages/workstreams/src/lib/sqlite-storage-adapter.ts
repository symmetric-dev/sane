import type { StructuredStorageStateAdapter } from "./structured-storage.ts"
import { bootstrapSqliteStructuredStorage } from "./sqlite-storage.ts"

function ensureSqliteBootstrap(repoRoot: string): void {
  bootstrapSqliteStructuredStorage(repoRoot)
}

export function createFilesystemAuthoritativeSqliteStructuredStorageAdapter(
  delegate: StructuredStorageStateAdapter,
): StructuredStorageStateAdapter {
  return {
    kind: "filesystem-authoritative-sqlite-dual-write",

    async loadWorkspaceState(repoRoot: string) {
      ensureSqliteBootstrap(repoRoot)
      return delegate.loadWorkspaceState(repoRoot)
    },

    async replaceWorkspaceState(repoRoot: string, workspaceState) {
      ensureSqliteBootstrap(repoRoot)
      return delegate.replaceWorkspaceState(repoRoot, workspaceState)
    },

    async modifyWorkspaceState(repoRoot: string, fn) {
      ensureSqliteBootstrap(repoRoot)
      return delegate.modifyWorkspaceState(repoRoot, fn)
    },

    async loadWorkstreamState(repoRoot: string, streamId: string) {
      ensureSqliteBootstrap(repoRoot)
      return delegate.loadWorkstreamState(repoRoot, streamId)
    },

    async replaceWorkstreamState(repoRoot: string, workstreamState) {
      ensureSqliteBootstrap(repoRoot)
      return delegate.replaceWorkstreamState(repoRoot, workstreamState)
    },

    async modifyWorkstreamState(repoRoot: string, streamId: string, fn) {
      ensureSqliteBootstrap(repoRoot)
      return delegate.modifyWorkstreamState(repoRoot, streamId, fn)
    },
  }
}
