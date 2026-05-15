/**
 * Metrics and evaluation functions for workstreams
 *
 * Provides functions to calculate metrics, filter execution items, and analyze blockers.
 */

import type {
  ExecutionItem,
  ExecutionStatus,
  EvaluationMetrics,
  BlockerAnalysis,
  FilterResult,
  StreamMetadata,
} from "./types.ts"
import { listThreadExecutionItems } from "./thread-execution.ts"
import { loadIndex, resolveStreamId, findStream } from "./index.ts"

/**
 * Evaluate a single workstream and return metrics
 */
export function evaluateStream(
  repoRoot: string,
  streamId: string
): EvaluationMetrics {
  const index = loadIndex(repoRoot)
  const stream = findStream(index, streamId)

  if (!stream) {
    throw new Error(`Workstream "${streamId}" not found`)
  }

  const items = listThreadExecutionItems(repoRoot, stream.id)

  const statusCounts: Record<ExecutionStatus, number> = {
    pending: 0,
    in_progress: 0,
    completed: 0,
    blocked: 0,
    cancelled: 0,
  }

  for (const item of items) {
    statusCounts[item.status]++
  }

  const total = items.length
  const completionRate = total > 0 ? (statusCounts.completed / total) * 100 : 0
  const blockedRate = total > 0 ? (statusCounts.blocked / total) * 100 : 0
  const cancelledRate = total > 0 ? (statusCounts.cancelled / total) * 100 : 0

  return {
    streamId: stream.id,
    streamName: stream.name,
    totalItems: total,
    statusCounts,
    completionRate,
    blockedRate,
    cancelledRate,
    inProgressCount: statusCounts.in_progress,
  }
}

/**
 * Evaluate all workstreams and return aggregated metrics
 */
export function evaluateAllStreams(repoRoot: string): EvaluationMetrics[] {
  const index = loadIndex(repoRoot)
  return index.streams.map((stream) => evaluateStream(repoRoot, stream.id))
}

/**
 * Filter execution items by name pattern
 */
export function filterExecutionItems(
  items: ExecutionItem[],
  pattern: string,
  isRegex: boolean = false
): FilterResult {
  let matchingItems: ExecutionItem[]

  if (isRegex) {
    const regex = new RegExp(pattern, "i")
    matchingItems = items.filter((item) => regex.test(item.name))
  } else {
    const lowerPattern = pattern.toLowerCase()
    matchingItems = items.filter((item) =>
      item.name.toLowerCase().includes(lowerPattern)
    )
  }

  return {
    matchingItems,
    matchCount: matchingItems.length,
    totalItems: items.length,
  }
}

/**
 * Filter execution items by status
 */
export function filterExecutionItemsByStatus(
  items: ExecutionItem[],
  statuses: ExecutionStatus[]
): ExecutionItem[] {
  return items.filter((item) => statuses.includes(item.status))
}

/**
 * Analyze blocked tasks
 */
export function analyzeBlockers(
  repoRoot: string,
  streamId: string
): BlockerAnalysis {
  const items = listThreadExecutionItems(repoRoot, streamId)
  const blockedItems = items.filter((item) => item.status === "blocked")

  const blockersByStage: Record<number, ExecutionItem[]> = {}
  const blockersByBatch: Record<string, ExecutionItem[]> = {}
  for (const item of blockedItems) {
    const [stageId = "00", batchNumber = "00"] = item.id.split(".")
    const stage = Number.parseInt(stageId, 10) || 0
    const batch = Number.parseInt(batchNumber, 10) || 0
    // By stage
    if (!blockersByStage[stage]) {
      blockersByStage[stage] = []
    }
    blockersByStage[stage].push(item)

    // By batch (stage.batch key)
    const batchKey = `${stage}.${batch.toString().padStart(2, "0")}`
    if (!blockersByBatch[batchKey]) {
      blockersByBatch[batchKey] = []
    }
    blockersByBatch[batchKey].push(item)
  }

  const blockedPercentage =
    items.length > 0 ? (blockedItems.length / items.length) * 100 : 0

  return {
    blockedItems,
    blockersByStage,
    blockersByBatch,
    blockedPercentage,
  }
}

/**
 * Format metrics for display
 */
export function formatMetricsOutput(
  metrics: EvaluationMetrics,
  options: { compact?: boolean } = {}
): string {
  if (options.compact) {
    return `${metrics.streamName}: ${metrics.statusCounts.completed}/${metrics.totalItems} items (${metrics.completionRate.toFixed(0)}%) | ${metrics.statusCounts.blocked} blocked | ${metrics.statusCounts.in_progress} in progress`
  }

  const lines: string[] = []
  lines.push(`Workstream: ${metrics.streamId} (${metrics.streamName})`)
  lines.push(``)
  lines.push(`Items: ${metrics.totalItems}`)
  lines.push(`  Completed:   ${metrics.statusCounts.completed} (${metrics.completionRate.toFixed(1)}%)`)
  lines.push(`  In Progress: ${metrics.statusCounts.in_progress}`)
  lines.push(`  Pending:     ${metrics.statusCounts.pending}`)
  lines.push(`  Blocked:     ${metrics.statusCounts.blocked} (${metrics.blockedRate.toFixed(1)}%)`)
  lines.push(`  Cancelled:   ${metrics.statusCounts.cancelled}`)

  return lines.join("\n")
}

/**
 * Format blocker analysis for display
 */
export function formatBlockerAnalysis(analysis: BlockerAnalysis): string {
  if (analysis.blockedItems.length === 0) {
    return "No blocked items."
  }

  const lines: string[] = []
  lines.push(`Blocked Items: ${analysis.blockedItems.length} (${analysis.blockedPercentage.toFixed(1)}%)`)
  lines.push(``)

  const stages = Object.keys(analysis.blockersByStage)
    .map(Number)
    .sort((a, b) => a - b)

  for (const stage of stages) {
    const tasks = analysis.blockersByStage[stage]!
    lines.push(`Stage ${stage}:`)
    for (const task of tasks) {
      lines.push(`  [${task.id}] ${task.name}`)
    }
  }

  return lines.join("\n")
}

/**
 * Aggregate metrics from multiple workstreams
 */
export function aggregateMetrics(
  metricsList: EvaluationMetrics[]
): EvaluationMetrics {
  const aggregate: EvaluationMetrics = {
    streamId: "all",
    streamName: "All Workstreams",
    totalItems: 0,
    statusCounts: {
      pending: 0,
      in_progress: 0,
      completed: 0,
      blocked: 0,
      cancelled: 0,
    },
    completionRate: 0,
    blockedRate: 0,
    cancelledRate: 0,
    inProgressCount: 0,
  }

  for (const metrics of metricsList) {
    aggregate.totalItems += metrics.totalItems
    aggregate.statusCounts.pending += metrics.statusCounts.pending
    aggregate.statusCounts.in_progress += metrics.statusCounts.in_progress
    aggregate.statusCounts.completed += metrics.statusCounts.completed
    aggregate.statusCounts.blocked += metrics.statusCounts.blocked
    aggregate.statusCounts.cancelled += metrics.statusCounts.cancelled
    aggregate.inProgressCount += metrics.inProgressCount
  }

  if (aggregate.totalItems > 0) {
    aggregate.completionRate =
      (aggregate.statusCounts.completed / aggregate.totalItems) * 100
    aggregate.blockedRate =
      (aggregate.statusCounts.blocked / aggregate.totalItems) * 100
    aggregate.cancelledRate =
      (aggregate.statusCounts.cancelled / aggregate.totalItems) * 100
  }

  return aggregate
}
