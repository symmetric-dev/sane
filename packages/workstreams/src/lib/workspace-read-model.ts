import { existsSync } from "fs"

import { loadIndex } from "./index.ts"
import { getIndexPath } from "./repo.ts"
import {
  createStreamMetadataFromStructuredStorageRecord,
  createStructuredStorageWorkstreamRecord,
  type StructuredStorageWorkspaceState,
  type StructuredStorageWorkstreamRecord,
} from "./structured-storage.ts"
import {
  loadSqliteStructuredStorageWorkspaceState,
  syncStructuredStorageWorkspaceStateToSqlite,
} from "./sqlite-storage.ts"
import type { StreamMetadata, WorkIndex } from "./types.ts"

function createWorkspaceStateFromIndex(index: WorkIndex): StructuredStorageWorkspaceState {
  return {
    ...(index.current_stream ? { currentStreamId: index.current_stream } : {}),
    workstreams: index.streams.map(createStructuredStorageWorkstreamRecord),
  }
}

export function projectWorkspaceCompatibilityStateToSqlite(
  repoRoot: string,
): StructuredStorageWorkspaceState | null {
  if (!existsSync(getIndexPath(repoRoot))) {
    return null
  }

  const workspaceState = createWorkspaceStateFromIndex(loadIndex(repoRoot))
  syncStructuredStorageWorkspaceStateToSqlite(repoRoot, workspaceState)
  return workspaceState
}

export function loadCanonicalWorkspaceState(repoRoot: string): StructuredStorageWorkspaceState {
  const projectedState = projectWorkspaceCompatibilityStateToSqlite(repoRoot)
  const sqliteState = loadSqliteStructuredStorageWorkspaceState(repoRoot)

  if (sqliteState) {
    return sqliteState
  }

  if (projectedState) {
    return projectedState
  }

  return createWorkspaceStateFromIndex(loadIndex(repoRoot))
}

export function createCompatibilityIndexFromWorkspaceState(
  workspaceState: StructuredStorageWorkspaceState,
): WorkIndex {
  return {
    version: "1.0.0",
    last_updated: new Date().toISOString(),
    ...(workspaceState.currentStreamId ? { current_stream: workspaceState.currentStreamId } : {}),
    streams: workspaceState.workstreams.map((record) =>
      createStreamMetadataFromStructuredStorageRecord({ record }),
    ),
  }
}

export function resolveWorkspaceStateStreamRecord(
  workspaceState: StructuredStorageWorkspaceState,
  streamIdOrName?: string,
): StructuredStorageWorkstreamRecord | undefined {
  const resolvedStreamIdOrName = streamIdOrName === "current"
    ? workspaceState.currentStreamId
    : streamIdOrName ?? workspaceState.currentStreamId

  if (!resolvedStreamIdOrName) {
    return undefined
  }

  return workspaceState.workstreams.find(
    (record) => record.id === resolvedStreamIdOrName || record.name === resolvedStreamIdOrName,
  )
}

export function createStreamMetadataFromWorkspaceStateRecord(
  record: StructuredStorageWorkstreamRecord,
): StreamMetadata {
  return createStreamMetadataFromStructuredStorageRecord({ record })
}
