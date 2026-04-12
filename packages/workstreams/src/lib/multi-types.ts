/**
 * Multi Command Types
 *
 * Re-exports multi-related types from types.ts for backward compatibility.
 * CLI-specific types that don't belong in the core types module stay here.
 */

// Re-export core types from types.ts
export type { RootAgentBranchRole, ThreadInfo, ThreadSessionMap } from "./types.ts"

/**
 * CLI arguments for the multi command
 */
export interface MultiCliArgs {
  repoRoot?: string
  streamId?: string
  batch?: string
  port?: number
  dryRun?: boolean
  noServer?: boolean
  continue?: boolean
  headless?: boolean
  async?: boolean
  silent?: boolean
  rootSessionId?: string
  parentSessionId?: string
  parentBranchSessionId?: string
  branchRole?: import("./types.ts").RootAgentBranchRole
}
