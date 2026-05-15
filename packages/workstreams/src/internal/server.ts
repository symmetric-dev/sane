/**
 * Stable internal, server-safe read helpers for dashboard/server packages.
 *
 * Keep this surface focused on read-only workstream resolution and structured
 * projections. Do not add CLI formatting helpers or mutating operations here.
 */

import {
  findStream,
  getCurrentStreamId,
  resolveStreamId,
} from "../lib/index.ts"
import {
  createCompatibilityIndexFromWorkspaceState,
  createStreamMetadataFromWorkspaceStateRecord,
  loadCanonicalWorkspaceState,
  resolveWorkspaceStateStreamRecord,
} from "../lib/workspace-read-model.ts"
import {
  createWorkstreamStatusSnapshot,
  getRuntimeSummaryEntries,
  getRuntimeSummaryProjection,
  getWorkstreamStatusSnapshot,
} from "../lib/status.ts"
import { queryExecutionItemsForWorkstream, queryRuntimeSummaryForWorkstream } from "../lib/hierarchy-query.ts"
import {
  buildWorkstreamTreeSnapshot,
  filterExecutionItemsForBatch,
} from "../lib/tree.ts"
import {
  createRuntimeSummaryFromWorkstreamState,
  resolveRuntimeSummary,
} from "../lib/runtime-state.ts"
import { loadStructuredWorkstreamStateSync } from "../lib/storage-adapter.ts"
import {
  createCurrentWorkstreamDashboardObservabilitySnapshot,
  createDashboardTmuxObservabilitySnapshot,
  type DashboardTmuxSessionInspector,
} from "./dashboard-observability.ts"
import type {
  ExecutionItem,
  StreamMetadata,
  WorkIndex,
  WorkstreamRuntimeSummary,
  WorkstreamStatusRuntimeEntry,
  WorkstreamStatusRuntimeSummaryProjection,
  WorkstreamStatusSnapshot,
} from "../lib/types.ts"
import type { StructuredStorageWorkspaceState } from "../lib/structured-storage.ts"
import type {
  WorkstreamTreeBatchNode,
  WorkstreamTreeBatchRuntimeOverlay,
  WorkstreamTreeRuntimeNotice,
  WorkstreamTreeSnapshot,
  WorkstreamTreeStageNode,
  WorkstreamTreeItemCounts,
  WorkstreamTreeThreadNode,
} from "../lib/tree.ts"
import type {
  CurrentWorkstreamDashboardObservabilitySnapshot,
  DashboardTmuxObservabilitySnapshot,
} from "./dashboard-contracts.ts"

export interface ResolvedWorkstreamReadTarget {
  index: WorkIndex
  workspaceState: StructuredStorageWorkspaceState
  currentStreamId?: string
  stream: StreamMetadata
}

export interface ResolvedWorkstreamTreeSnapshotOptions {
  streamIdOrName?: string
  batchId?: string
}

export function resolveWorkstreamReadTargetFromIndex(
  index: WorkIndex,
  streamIdOrName?: string,
): ResolvedWorkstreamReadTarget {
  const currentStreamId = getCurrentStreamId(index)
  const resolvedStreamId = resolveStreamId(index, streamIdOrName)

  if (!resolvedStreamId) {
    throw new Error("No current workstream is set")
  }

  const stream = findStream(index, resolvedStreamId)
  if (!stream) {
    throw new Error(`Workstream "${resolvedStreamId}" not found`)
  }

  return {
    index,
    workspaceState: {
      ...(currentStreamId ? { currentStreamId } : {}),
      workstreams: index.streams.map((stream) => ({
        id: stream.id,
        name: stream.name,
        order: stream.order,
        size: stream.size,
        createdAt: stream.created_at,
        updatedAt: stream.updated_at,
        storageRoot: stream.path,
        ...(stream.status ? { manualStatus: stream.status } : {}),
        ...(stream.current_batch ? { currentBatch: stream.current_batch } : {}),
        generatedBy: stream.generated_by,
        sessionEstimated: stream.session_estimated,
        ...(stream.files ? { files: [...stream.files] } : {}),
        ...(stream.planningSession ? { planningSession: { ...stream.planningSession } } : {}),
        ...(stream.github ? { github: { ...stream.github } } : {}),
      })),
    },
    ...(currentStreamId ? { currentStreamId } : {}),
    stream,
  }
}

export function resolveWorkstreamReadTarget(
  repoRoot: string,
  streamIdOrName?: string,
): ResolvedWorkstreamReadTarget {
  const workspaceState = loadCanonicalWorkspaceState(repoRoot)
  const currentStreamId = workspaceState.currentStreamId
  const resolvedStreamIdOrName = streamIdOrName === "current"
    ? currentStreamId
    : streamIdOrName ?? currentStreamId

  if (!resolvedStreamIdOrName) {
    throw new Error("No current workstream is set")
  }

  const streamRecord = resolveWorkspaceStateStreamRecord(workspaceState, resolvedStreamIdOrName)
  if (!streamRecord) {
    throw new Error(`Workstream "${resolvedStreamIdOrName}" not found`)
  }

  return {
    index: createCompatibilityIndexFromWorkspaceState(workspaceState),
    workspaceState,
    ...(currentStreamId ? { currentStreamId } : {}),
    stream: createStreamMetadataFromWorkspaceStateRecord(streamRecord),
  }
}

export function getResolvedRuntimeSummary(
  repoRoot: string,
  streamIdOrName?: string,
): WorkstreamRuntimeSummary | undefined {
  const { stream } = resolveWorkstreamReadTarget(repoRoot, streamIdOrName)
  return queryRuntimeSummaryForWorkstream(repoRoot, stream.id)
}

export function getResolvedWorkstreamStatusSnapshot(
  repoRoot: string,
  streamIdOrName?: string,
): WorkstreamStatusSnapshot {
  const { currentStreamId, stream } = resolveWorkstreamReadTarget(repoRoot, streamIdOrName)
  return getWorkstreamStatusSnapshot(repoRoot, stream, currentStreamId)
}

export function getResolvedWorkstreamTreeSnapshot(
  repoRoot: string,
  options: ResolvedWorkstreamTreeSnapshotOptions = {},
): WorkstreamTreeSnapshot {
  const { stream } = resolveWorkstreamReadTarget(repoRoot, options.streamIdOrName)
  const allItems = queryExecutionItemsForWorkstream(repoRoot, stream.id)
  const runtimeSummary = queryRuntimeSummaryForWorkstream(repoRoot, stream.id)
  const filteredItems = options.batchId
    ? filterExecutionItemsForBatch(allItems, options.batchId)
    : allItems

  if (options.batchId && filteredItems === null) {
    throw new Error(`Invalid batch ID format: "${options.batchId}"`)
  }

  return buildWorkstreamTreeSnapshot({
    streamId: stream.id,
    items: filteredItems ?? allItems,
    runtimeSummary,
    ...(options.batchId ? { batchId: options.batchId } : {}),
  })
}

export function getResolvedDashboardTmuxObservabilitySnapshot(
  repoRoot: string,
  streamIdOrName?: string,
  options: {
    checkedAt?: string
  } = {},
): DashboardTmuxObservabilitySnapshot {
  const { stream } = resolveWorkstreamReadTarget(repoRoot, streamIdOrName)
  const state = loadStructuredWorkstreamStateSync(repoRoot, stream.id)

  return createDashboardTmuxObservabilitySnapshot({
    stream,
    runtimeState: state
      ? {
          version: "1.0.0",
          last_updated: new Date().toISOString(),
          threads: state.threadRuntime,
          batches: Object.fromEntries(state.batchRuns.map((batchRun) => [batchRun.batchId, batchRun])),
          supervision: state.supervision,
        }
      : undefined,
    checkedAt: options.checkedAt,
  })
}

export function getResolvedCurrentWorkstreamDashboardObservabilitySnapshot(
  repoRoot: string,
  streamIdOrName?: string,
  options: {
    checkedAt?: string
  } = {},
): CurrentWorkstreamDashboardObservabilitySnapshot {
  const { stream } = resolveWorkstreamReadTarget(repoRoot, streamIdOrName)
  const state = loadStructuredWorkstreamStateSync(repoRoot, stream.id)

  return createCurrentWorkstreamDashboardObservabilitySnapshot({
    stream,
    runtimeState: state
      ? {
          version: "1.0.0",
          last_updated: new Date().toISOString(),
          threads: state.threadRuntime,
          batches: Object.fromEntries(state.batchRuns.map((batchRun) => [batchRun.batchId, batchRun])),
          supervision: state.supervision,
        }
      : undefined,
    checkedAt: options.checkedAt,
  })
}

export {
  createCurrentWorkstreamDashboardObservabilitySnapshot,
  createDashboardTmuxObservabilitySnapshot,
  buildWorkstreamTreeSnapshot,
  createWorkstreamStatusSnapshot,
  resolveRuntimeSummary,
  getRuntimeSummaryEntries,
  getRuntimeSummaryProjection,
  getWorkstreamStatusSnapshot,
}

export type {
  CurrentWorkstreamDashboardObservabilitySnapshot,
  DashboardTmuxObservabilitySnapshot,
  DashboardTmuxSessionInspector,
  StreamMetadata,
  WorkIndex,
  WorkstreamRuntimeSummary,
  WorkstreamStatusRuntimeEntry,
  WorkstreamStatusRuntimeSummaryProjection,
  WorkstreamStatusSnapshot,
  WorkstreamTreeBatchNode,
  WorkstreamTreeBatchRuntimeOverlay,
  WorkstreamTreeRuntimeNotice,
  WorkstreamTreeSnapshot,
  WorkstreamTreeStageNode,
  WorkstreamTreeItemCounts,
  WorkstreamTreeThreadNode,
}
