/**
 * Workstream completion operations
 */

import { join } from "path"
import { writeFileSync } from "fs"
import type { ExecutionItem, StreamMetadata, ExecutionStatus } from "./types.ts"
import { loadIndex, saveIndex, findStream } from "./index.ts"
import { setNestedField, getNestedField, parseValue } from "./utils.ts"
import { getWorkDir } from "./repo.ts"
import { listThreadExecutionItems } from "./thread-execution.ts"
import { evaluateStream } from "./metrics.ts"

// ============================================
// TIMING HELPER FUNCTIONS
// ============================================

/**
 * Calculate the duration of a task in milliseconds
 * Returns null if timestamps are missing or invalid
 */
function calculateTaskDuration(task: ExecutionItem): number | null {
  if (!task.createdAt || !task.updatedAt) {
    return null
  }
  const created = new Date(task.createdAt).getTime()
  const updated = new Date(task.updatedAt).getTime()
  if (isNaN(created) || isNaN(updated)) {
    return null
  }
  return Math.max(0, updated - created)
}

/**
 * Format milliseconds as human-readable duration
 * Examples: "1h 23m 45s", "45m 30s", "12s", "<1s"
 */
function formatDuration(ms: number): string {
  if (ms < 1000) {
    return "<1s"
  }

  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)

  const remainingMinutes = minutes % 60
  const remainingSeconds = seconds % 60

  const parts: string[] = []
  if (hours > 0) {
    parts.push(`${hours}h`)
  }
  if (remainingMinutes > 0 || hours > 0) {
    parts.push(`${remainingMinutes}m`)
  }
  if (remainingSeconds > 0 || parts.length === 0) {
    parts.push(`${remainingSeconds}s`)
  }

  return parts.join(" ")
}

/**
 * Stage timing metrics
 */
interface StageMetrics {
  stageName: string
  taskCount: number
  avgTimeMs: number
  totalTimeMs: number
}

/**
 * Calculate timing metrics grouped by stage
 * Only includes completed tasks in calculations
 */
function calculateStageMetrics(tasks: ExecutionItem[]): StageMetrics[] {
  const stageMap = new Map<string, { durations: number[] }>()

  for (const task of tasks) {
    if (task.status !== "completed") continue
    const duration = calculateTaskDuration(task)
    if (duration === null) continue

    const stageName = task.stageName || "Unknown Stage"
    if (!stageMap.has(stageName)) {
      stageMap.set(stageName, { durations: [] })
    }
    stageMap.get(stageName)!.durations.push(duration)
  }

  const results: StageMetrics[] = []
  for (const [stageName, data] of stageMap) {
    const totalTimeMs = data.durations.reduce((a, b) => a + b, 0)
    const avgTimeMs =
      data.durations.length > 0 ? totalTimeMs / data.durations.length : 0
    results.push({
      stageName,
      taskCount: data.durations.length,
      avgTimeMs,
      totalTimeMs,
    })
  }

  // Sort by stage name for consistent ordering
  return results.sort((a, b) => a.stageName.localeCompare(b.stageName))
}

/**
 * Agent timing metrics
 */
interface AgentMetrics {
  agentName: string
  taskCount: number
  avgTimeMs: number
}

/**
 * Calculate timing metrics grouped by assigned agent
 * Only includes completed tasks in calculations
 */
function calculateAgentMetrics(tasks: ExecutionItem[]): AgentMetrics[] {
  const agentMap = new Map<string, { durations: number[] }>()

  for (const task of tasks) {
    if (task.status !== "completed") continue
    const duration = calculateTaskDuration(task)
    if (duration === null) continue

    const agentName = task.assignedAgent || "default"
    if (!agentMap.has(agentName)) {
      agentMap.set(agentName, { durations: [] })
    }
    agentMap.get(agentName)!.durations.push(duration)
  }

  const results: AgentMetrics[] = []
  for (const [agentName, data] of agentMap) {
    const totalTimeMs = data.durations.reduce((a, b) => a + b, 0)
    const avgTimeMs =
      data.durations.length > 0 ? totalTimeMs / data.durations.length : 0
    results.push({
      agentName,
      taskCount: data.durations.length,
      avgTimeMs,
    })
  }

  // Sort by task count descending, then by agent name
  return results.sort(
    (a, b) => b.taskCount - a.taskCount || a.agentName.localeCompare(b.agentName)
  )
}

/**
 * Overall timing metrics
 */
interface OverallTimingMetrics {
  totalDurationMs: number | null
  fastestTaskMs: number | null
  slowestTaskMs: number | null
}

/**
 * Calculate overall timing metrics from all tasks
 */
function calculateOverallTimingMetrics(tasks: ExecutionItem[]): OverallTimingMetrics {
  const completedTasks = tasks.filter((t) => t.status === "completed")

  // Get all valid timestamps for total duration
  const createdTimestamps: number[] = []
  const updatedTimestamps: number[] = []
  const durations: number[] = []

  for (const task of completedTasks) {
    if (task.createdAt) {
      const created = new Date(task.createdAt).getTime()
      if (!isNaN(created)) {
        createdTimestamps.push(created)
      }
    }
    if (task.updatedAt) {
      const updated = new Date(task.updatedAt).getTime()
      if (!isNaN(updated)) {
        updatedTimestamps.push(updated)
      }
    }
    const duration = calculateTaskDuration(task)
    if (duration !== null) {
      durations.push(duration)
    }
  }

  // Total duration: first created_at to last updated_at
  let totalDurationMs: number | null = null
  if (createdTimestamps.length > 0 && updatedTimestamps.length > 0) {
    const firstCreated = Math.min(...createdTimestamps)
    const lastUpdated = Math.max(...updatedTimestamps)
    totalDurationMs = lastUpdated - firstCreated
  }

  // Fastest and slowest tasks
  let fastestTaskMs: number | null = null
  let slowestTaskMs: number | null = null
  if (durations.length > 0) {
    fastestTaskMs = Math.min(...durations)
    slowestTaskMs = Math.max(...durations)
  }

  return {
    totalDurationMs,
    fastestTaskMs,
    slowestTaskMs,
  }
}

export interface CompleteStreamArgs {
  repoRoot: string
  streamId: string
}

export interface CompleteStreamResult {
  streamId: string
  completedAt: string
  completionPath: string
}

/**
 * Mark a workstream as complete
 * Sets the stream status to "completed" explicitly
 */
export function completeStream(args: CompleteStreamArgs): CompleteStreamResult {
  const index = loadIndex(args.repoRoot)
  const streamIndex = index.streams.findIndex(
    (s) => s.id === args.streamId || s.name === args.streamId
  )

  if (streamIndex === -1) {
    throw new Error(`Workstream "${args.streamId}" not found`)
  }

  const stream = index.streams[streamIndex]
  if (!stream) {
    throw new Error(`Workstream at index ${streamIndex} not found`)
  }

  const now = new Date().toISOString()

  // Set status to completed
  stream.status = "completed"
  stream.updated_at = now
  saveIndex(args.repoRoot, index)

  // Generate COMPLETION.md
  const completionPath = generateCompletionMd({
    repoRoot: args.repoRoot,
    streamId: stream.id,
  })

  return {
    streamId: stream.id,
    completedAt: now,
    completionPath,
  }
}

/**
 * Generate a METRICS.md summary for a workstream
 * Contains stream ID, completion timestamp, and task metrics
 */
export function generateCompletionMd(args: {
  repoRoot: string
  streamId: string
}): string {
  const index = loadIndex(args.repoRoot)
  const stream = findStream(index, args.streamId)
  if (!stream) {
    throw new Error(`Workstream "${args.streamId}" not found`)
  }

  const workDir = getWorkDir(args.repoRoot)
  const streamDir = join(workDir, stream.id)
  const tasks = listThreadExecutionItems(args.repoRoot, stream.id)
  const metrics = evaluateStream(args.repoRoot, stream.id)

  // Count unique stages, batches, threads
  const grouped = groupTasksByHierarchy(tasks)
  let stageCount = 0
  let batchCount = 0
  let threadCount = 0
  for (const stageMap of grouped.values()) {
    stageCount++
    for (const batchMap of stageMap.values()) {
      batchCount++
      threadCount += batchMap.size
    }
  }

  // Calculate timing metrics
  const overallTiming = calculateOverallTimingMetrics(tasks)
  const stageMetrics = calculateStageMetrics(tasks)
  const agentMetrics = calculateAgentMetrics(tasks)

  const lines: string[] = []
  lines.push(`# Metrics: ${stream.name}`)
  lines.push("")
  lines.push(`**Stream ID:** \`${stream.id}\``)
  lines.push(`**Completed At:** ${new Date().toISOString()}`)
  lines.push("")
  lines.push("## Summary")
  lines.push("")
  lines.push(`| Metric | Value |`)
  lines.push(`|--------|-------|`)
  lines.push(`| Items | ${metrics.statusCounts.completed}/${metrics.totalItems} |`)
  lines.push(`| Completion Rate | ${metrics.completionRate.toFixed(1)}% |`)
  lines.push(`| Stages | ${stageCount} |`)
  lines.push(`| Batches | ${batchCount} |`)
  lines.push(`| Threads | ${threadCount} |`)
  lines.push(
    `| Total Duration | ${overallTiming.totalDurationMs !== null ? formatDuration(overallTiming.totalDurationMs) : "-"} |`
  )
  lines.push(
    `| Fastest Item | ${overallTiming.fastestTaskMs !== null ? formatDuration(overallTiming.fastestTaskMs) : "-"} |`
  )
  lines.push(
    `| Slowest Item | ${overallTiming.slowestTaskMs !== null ? formatDuration(overallTiming.slowestTaskMs) : "-"} |`
  )
  lines.push("")
  lines.push("## Status Breakdown")
  lines.push("")
  lines.push(`| Status | Count |`)
  lines.push(`|--------|-------|`)
  lines.push(`| Completed | ${metrics.statusCounts.completed} |`)
  lines.push(`| In Progress | ${metrics.statusCounts.in_progress} |`)
  lines.push(`| Pending | ${metrics.statusCounts.pending} |`)
  lines.push(`| Blocked | ${metrics.statusCounts.blocked} |`)
  lines.push(`| Cancelled | ${metrics.statusCounts.cancelled} |`)
  lines.push("")

  // Stage Performance section
  lines.push("## Stage Performance")
  lines.push("")
  if (stageMetrics.length > 0) {
    lines.push(`| Stage | Tasks | Avg Time | Total Time |`)
    lines.push(`|-------|-------|----------|------------|`)
    for (const stage of stageMetrics) {
      lines.push(
        `| ${stage.stageName} | ${stage.taskCount} | ${formatDuration(stage.avgTimeMs)} | ${formatDuration(stage.totalTimeMs)} |`
      )
    }
  } else {
    lines.push("No completed items with timing data.")
  }
  lines.push("")

  // Agent Performance section
  lines.push("## Agent Performance")
  lines.push("")
  if (agentMetrics.length > 0) {
    lines.push(`| Agent | Items | Avg Time |`)
    lines.push(`|-------|-------|----------|`)
    for (const agent of agentMetrics) {
      lines.push(
        `| ${agent.agentName} | ${agent.taskCount} | ${formatDuration(agent.avgTimeMs)} |`
      )
    }
  } else {
    lines.push("No completed items with timing data.")
  }
  lines.push("")

  const content = lines.join("\n")
  const outputPath = join(streamDir, "METRICS.md")
  writeFileSync(outputPath, content)

  return outputPath
}

/**
 * Group tasks by stage name, batch name, thread name
 */
function groupTasksByHierarchy(
  tasks: ExecutionItem[],
): Map<string, Map<string, Map<string, ExecutionItem[]>>> {
  const grouped = new Map<string, Map<string, Map<string, ExecutionItem[]>>>()

  for (const task of tasks) {
    const stageName = task.stageName || "Stage 01"
    const batchName = task.batchName || "Batch 01"
    const threadName = task.threadName || "Thread 01"

    if (!grouped.has(stageName)) {
      grouped.set(stageName, new Map())
    }
    const stageMap = grouped.get(stageName)!

    if (!stageMap.has(batchName)) {
      stageMap.set(batchName, new Map())
    }
    const batchMap = stageMap.get(batchName)!

    if (!batchMap.has(threadName)) {
      batchMap.set(threadName, [])
    }
    batchMap.get(threadName)!.push(task)
  }

  return grouped
}



export interface UpdateIndexFieldArgs {
  repoRoot: string
  streamId: string
  field: string
  value: string
}

export interface UpdateIndexFieldResult {
  streamId: string
  field: string
  previousValue: unknown
  newValue: unknown
}

/**
 * Update a specific field in a stream's index entry
 */
export function updateIndexField(
  args: UpdateIndexFieldArgs
): UpdateIndexFieldResult {
  const index = loadIndex(args.repoRoot)
  const streamIndex = index.streams.findIndex(
    (s) => s.id === args.streamId || s.name === args.streamId
  )

  if (streamIndex === -1) {
    throw new Error(`Workstream "${args.streamId}" not found`)
  }

  const stream = index.streams[streamIndex]
  if (!stream) {
    throw new Error(`Workstream at index ${streamIndex} not found`)
  }

  // Get current value
  const currentValue = getNestedField(
    stream as unknown as Record<string, unknown>,
    args.field
  )
  const parsedValue = parseValue(args.value)

  // Update the field
  setNestedField(
    stream as unknown as Record<string, unknown>,
    args.field,
    parsedValue
  )

  // Update timestamps
  stream.updated_at = new Date().toISOString()
  saveIndex(args.repoRoot, index)

  return {
    streamId: stream.id,
    field: args.field,
    previousValue: currentValue,
    newValue: parsedValue,
  }
}

/**
 * Format stream info for display
 */
export function formatStreamInfo(stream: StreamMetadata): string {
  const lines: string[] = [
    `Workstream: ${stream.id}`,
    `|- name: ${stream.name}`,
    `|- order: ${stream.order}`,
    `|- size: ${stream.size}`,
    `|- path: ${stream.path}`,
    `|- created_at: ${stream.created_at}`,
    `|- updated_at: ${stream.updated_at}`,
    `|- session_estimated:`,
    `|  |- length: ${stream.session_estimated.length}`,
    `|  |- unit: ${stream.session_estimated.unit}`,
    `|  |- session_minutes: [${stream.session_estimated.session_minutes.join(", ")}]`,
    `|  +- session_iterations: [${stream.session_estimated.session_iterations.join(", ")}]`,
    `+- generated_by:`,
    `   +- workstreams: ${stream.generated_by.workstreams}`,
  ]

  return lines.join("\n")
}
