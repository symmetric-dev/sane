/**
 * Stable internal, server-safe read helpers for dashboard/server packages.
 *
 * Keep this surface focused on read-only workstream resolution and structured
 * projections. Do not add CLI formatting helpers or mutating operations here.
 */

import {
  findStream,
  getCurrentStreamId,
  loadIndex,
  resolveStreamId,
} from "../lib/index.ts"
import {
  createWorkstreamStatusSnapshot,
  getRuntimeSummaryEntries,
  getRuntimeSummaryProjection,
  getWorkstreamStatusSnapshot,
} from "../lib/status.ts"
import {
  buildWorkstreamTreeSnapshot,
  filterTasksForBatch,
} from "../lib/tree.ts"
import {
  getEffectiveRuntimeSummary,
  projectRuntimeSummary,
  readTasksFile,
} from "../lib/tasks.ts"
import type {
  StreamMetadata,
  Task,
  WorkIndex,
  WorkstreamRuntimeSummary,
  WorkstreamStatusRuntimeEntry,
  WorkstreamStatusRuntimeSummaryProjection,
  WorkstreamStatusSnapshot,
} from "../lib/types.ts"
import type {
  WorkstreamTreeBatchNode,
  WorkstreamTreeBatchRuntimeOverlay,
  WorkstreamTreeRuntimeNotice,
  WorkstreamTreeSnapshot,
  WorkstreamTreeStageNode,
  WorkstreamTreeTaskCounts,
  WorkstreamTreeTaskNode,
  WorkstreamTreeThreadNode,
} from "../lib/tree.ts"

export interface ResolvedWorkstreamReadTarget {
  index: WorkIndex
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
    ...(currentStreamId ? { currentStreamId } : {}),
    stream,
  }
}

export function resolveWorkstreamReadTarget(
  repoRoot: string,
  streamIdOrName?: string,
): ResolvedWorkstreamReadTarget {
  return resolveWorkstreamReadTargetFromIndex(loadIndex(repoRoot), streamIdOrName)
}

export function getResolvedRuntimeSummary(
  repoRoot: string,
  streamIdOrName?: string,
): WorkstreamRuntimeSummary | undefined {
  const { stream } = resolveWorkstreamReadTarget(repoRoot, streamIdOrName)
  const tasksFile = readTasksFile(repoRoot, stream.id)
  return getEffectiveRuntimeSummary(repoRoot, stream.id, tasksFile)
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
  const tasksFile = readTasksFile(repoRoot, stream.id)
  const allTasks = tasksFile?.tasks ?? []
  const runtimeSummary = getEffectiveRuntimeSummary(repoRoot, stream.id, tasksFile)
  const filteredTasks = options.batchId
    ? filterTasksForBatch(allTasks, options.batchId)
    : allTasks

  if (options.batchId && filteredTasks === null) {
    throw new Error(`Invalid batch ID format: "${options.batchId}"`)
  }

  return buildWorkstreamTreeSnapshot({
    streamId: stream.id,
    tasks: filteredTasks ?? allTasks,
    runtimeSummary,
    ...(options.batchId ? { batchId: options.batchId } : {}),
  })
}

export {
  buildWorkstreamTreeSnapshot,
  createWorkstreamStatusSnapshot,
  getEffectiveRuntimeSummary,
  getRuntimeSummaryEntries,
  getRuntimeSummaryProjection,
  getWorkstreamStatusSnapshot,
  projectRuntimeSummary,
}

export type {
  StreamMetadata,
  Task,
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
  WorkstreamTreeTaskCounts,
  WorkstreamTreeTaskNode,
  WorkstreamTreeThreadNode,
}
