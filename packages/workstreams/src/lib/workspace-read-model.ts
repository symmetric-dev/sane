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
  loadStructuredWorkspaceStateSync,
  replaceStructuredWorkspaceStateSync,
} from "./storage-adapter.ts"
import {
  getSqliteStructuredStoragePath,
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
  try {
    syncStructuredStorageWorkspaceStateToSqlite(repoRoot, workspaceState)
  } catch {
    // Best-effort compatibility projection only.
  }
  return workspaceState
}

export function loadCanonicalWorkspaceState(repoRoot: string): StructuredStorageWorkspaceState {
  if (existsSync(getSqliteStructuredStoragePath(repoRoot))) {
    const sqliteState = loadSqliteStructuredStorageWorkspaceState(repoRoot)
    if (sqliteState) {
      return sqliteState
    }
  }

  if (existsSync(getIndexPath(repoRoot))) {
    return createWorkspaceStateFromIndex(loadIndex(repoRoot))
  }

  return { workstreams: [] }
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

export function setCanonicalCurrentStream(
  repoRoot: string,
  streamIdOrName: string,
): StreamMetadata {
  const workspaceState = loadStructuredWorkspaceStateSync(repoRoot)
  const record = resolveWorkspaceStateStreamRecord(workspaceState, streamIdOrName)

  if (!record) {
    throw new Error(`Workstream not found: ${streamIdOrName}`)
  }

  workspaceState.currentStreamId = record.id
  replaceStructuredWorkspaceStateSync({ repoRoot, workspaceState })
  return createStreamMetadataFromWorkspaceStateRecord(record)
}

export function clearCanonicalCurrentStream(repoRoot: string): void {
  const workspaceState = loadStructuredWorkspaceStateSync(repoRoot)
  delete workspaceState.currentStreamId
  replaceStructuredWorkspaceStateSync({ repoRoot, workspaceState })
}
