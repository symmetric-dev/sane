/**
 * Workstream status and progress tracking
 *
 * Reads synthesized execution status from canonical thread runtime state
 */

import type {
  ExecutionItem,
  StreamMetadata,
  StreamProgress,
  StreamStatus,
  StageStatus,
  ParsedExecutionItem,
  ApprovalStatus,
  ExecutionStatus,
  WorkstreamRuntimeSummary,
  ExecutionStatusCounts,
  WorkstreamStatusCompletionMetrics,
  WorkstreamStatusRuntimeEntry,
  WorkstreamStatusRuntimeSummaryProjection,
  WorkstreamStatusSnapshot,
  WorkstreamStatusStageSummary,
  WorkstreamRuntimeBatchSummary,
} from "./types.ts"
import type { StructuredStageRecord } from "./structured-storage.ts"
import {
  loadWorkstreamHierarchyQueryResult,
  queryExecutionItemsForWorkstream,
  queryRuntimeSummaryForWorkstream,
  queryThreadsForWorkstream,
} from "./hierarchy-query.ts"
import { queryStageApprovalStatus } from "./approval.ts"
import { loadThreads } from "./threads.ts"

function getExecutionStatusCountsForItems(items: Array<{ status: ExecutionStatus }>): ExecutionStatusCounts {
  const counts: ExecutionStatusCounts = {
    total: items.length,
    pending: 0,
    in_progress: 0,
    completed: 0,
    blocked: 0,
    cancelled: 0,
    done: 0,
  }

  for (const item of items) {
    counts[item.status] += 1
  }

  counts.done = counts.completed + counts.cancelled
  return counts
}

function createCompletionMetrics(counts: ExecutionStatusCounts): WorkstreamStatusCompletionMetrics {
  return {
    total_items: counts.total,
    completed_items: counts.completed,
    cancelled_items: counts.cancelled,
    done_items: counts.done,
    remaining_items: counts.total - counts.done,
    percent_complete: counts.total > 0 ? Math.round((counts.completed / counts.total) * 100) : 0,
    percent_done: counts.total > 0 ? Math.round((counts.done / counts.total) * 100) : 0,
  }
}

export function computeStreamStatusFromCounts(
  stream: Pick<StreamMetadata, "status">,
  counts: Pick<ExecutionStatusCounts, "total" | "completed" | "cancelled" | "in_progress">,
): StreamStatus {
  if (stream.status === "on_hold") {
    return "on_hold"
  }

  if (counts.total === 0) {
    return "pending"
  }

  const doneCount = counts.completed + counts.cancelled
  if (doneCount === counts.total) {
    return "completed"
  }

  if (counts.in_progress > 0) {
    return "in_progress"
  }

  if (counts.completed > 0) {
    return "in_progress"
  }

  return "pending"
}

/**
 * Compute the stream status based on execution states
 * - If stream has manually set status `on_hold`, use that
 * - If all items are completed (or cancelled), status is `completed`
 * - If any item is in_progress, status is `in_progress`
 * - Otherwise, status is `pending`
 */
export function computeStreamStatus(
  repoRoot: string,
  stream: StreamMetadata
): StreamStatus {
  return computeStreamStatusFromCounts(
    stream,
    getExecutionStatusCountsForItems(queryExecutionItemsForWorkstream(repoRoot, stream.id)),
  )
}

/**
 * Get the effective stream status (computed or from metadata)
 */
export function getStreamStatus(repoRoot: string, stream: StreamMetadata): StreamStatus {
  return computeStreamStatus(repoRoot, stream)
}

/**
 * Calculate stage status from execution statuses
 */
export function calculateStageStatus(items: Array<{ status: ExecutionStatus }>): StageStatus {
  if (items.length === 0) return "pending"

  const done = items.filter((t) => t.status === "completed" || t.status === "cancelled").length
  const inProgress = items.filter((t) => t.status === "in_progress").length
  const blocked = items.filter((t) => t.status === "blocked").length

  if (done === items.length) return "complete"
  if (blocked > 0 && inProgress === 0 && done === 0) return "blocked"
  if (inProgress > 0 || done > 0) return "in_progress"
  return "pending"
}

function parseExecutionItemIdParts(itemId: string): {
  stageNumber: number
  stageId: string
  batchNumber: number
  batchId: string
  threadNumber: number
  itemNumber: number
} | null {
  const parts = itemId.split(".")
  if (parts.length !== 3 && parts.length !== 4) {
    return null
  }
  const stageNumber = parseInt(parts[0]!, 10)
  const batchNumber = parseInt(parts[1]!, 10)
  const threadNumber = parseInt(parts[2]!, 10)
  const itemNumber = parts[3] !== undefined ? parseInt(parts[3], 10) : 1
  if (isNaN(stageNumber)) {
    return null
  }
  if (isNaN(batchNumber) || isNaN(threadNumber) || isNaN(itemNumber)) {
    return null
  }

  return {
    stageNumber,
    stageId: stageNumber.toString().padStart(2, "0"),
    batchNumber,
    batchId: `${parts[0]}.${parts[1]}`,
    threadNumber,
    itemNumber,
  }
}

function toParsedExecutionItem(item: ExecutionItem): ParsedExecutionItem | null {
  const parts = parseExecutionItemIdParts(item.id)
  if (!parts) {
    return null
  }

  return {
    id: item.id,
    description: item.name,
    status: item.status,
    stageNumber: parts.stageNumber,
    ...(parts.batchNumber !== undefined ? { batchNumber: parts.batchNumber } : {}),
    threadNumber: parts.threadNumber,
    itemNumber: parts.itemNumber,
    lineNumber: 0,
  }
}

export function buildStageStatusSummaries(
  items: ExecutionItem[],
  hierarchyStages: StructuredStageRecord[] = [],
): WorkstreamStatusStageSummary[] {
  const stageItems = new Map<number, ExecutionItem[]>()

  for (const item of items) {
    const parts = parseExecutionItemIdParts(item.id)
    if (!parts) {
      continue
    }

    if (!stageItems.has(parts.stageNumber)) {
      stageItems.set(parts.stageNumber, [])
    }
    stageItems.get(parts.stageNumber)!.push(item)
  }

  const stageMetadata = new Map<number, StructuredStageRecord>()
  for (const stage of hierarchyStages) {
    stageMetadata.set(stage.number, stage)
  }

  const visibleStageNumbers = new Set<number>([
    ...stageMetadata.keys(),
    ...stageItems.keys(),
  ])

  return [...visibleStageNumbers]
    .sort((left, right) => left - right)
    .map((stageNumber) => {
      const stageItemsList = stageItems.get(stageNumber) ?? []
      const counts = getExecutionStatusCountsForItems(stageItemsList)
      const parsedItems = stageItemsList
        .map((item) => toParsedExecutionItem(item))
        .filter((item): item is ParsedExecutionItem => item !== null)
      const stage = stageMetadata.get(stageNumber)

      return {
        number: stageNumber,
        stage_id: stage?.id ?? stageNumber.toString().padStart(2, "0"),
        title: stage?.name ?? stageItemsList[0]?.stageName ?? `Stage ${stageNumber}`,
        status: calculateStageStatus(stageItemsList),
        counts,
        completion: createCompletionMetrics(counts),
        items: parsedItems,
      }
    })
}

export function aggregateExecutionStatus(items: Array<{ status: ExecutionStatus }>): ExecutionStatus {
  if (items.length === 0) return "pending"
  if (items.some((item) => item.status === "blocked")) return "blocked"
  if (items.some((item) => item.status === "in_progress")) return "in_progress"
  if (items.some((item) => item.status === "pending")) return "pending"
  return "completed"
}

export function getRuntimeSummaryEntries(
  stages: Array<{ number: number; items: ParsedExecutionItem[] }>,
  runtimeSummary?: WorkstreamRuntimeSummary,
): WorkstreamStatusRuntimeEntry[] {
  if (!runtimeSummary) {
    return []
  }

  const entries: WorkstreamStatusRuntimeEntry[] = []
  const stageExecutionStatus = new Map<string, ExecutionStatus>()
  const batchExecutionStatus = new Map<string, ExecutionStatus>()

  for (const stage of stages) {
    const stageId = stage.number.toString().padStart(2, "0")
    stageExecutionStatus.set(stageId, aggregateExecutionStatus(stage.items))

    const stageBatches = new Map<string, ParsedExecutionItem[]>()
    for (const item of stage.items) {
      const parts = item.id.split(".")
      if (parts.length < 2) continue
      const batchId = `${parts[0]}.${parts[1]}`
      if (!stageBatches.has(batchId)) {
        stageBatches.set(batchId, [])
      }
      stageBatches.get(batchId)!.push(item)
    }

    for (const [batchId, itemsForBatch] of stageBatches) {
      batchExecutionStatus.set(batchId, aggregateExecutionStatus(itemsForBatch))
    }
  }

  for (const batchId of Object.keys(runtimeSummary.batches).sort()) {
    const batch = runtimeSummary.batches[batchId]!
    const executionStatus = batchExecutionStatus.get(batchId)
    const isRuntimeActive = ["running", "failed"].includes(batch.status)
    const isAlignedWithExecution = executionStatus ? isBatchRuntimeStatusAligned(executionStatus, batch.status) : false
    if (!executionStatus) continue
    if (!isAlignedWithExecution || isRuntimeActive) {
      entries.push({
        kind: "batch",
        batch_id: batchId,
        execution_status: executionStatus,
        runtime_status: batch.status,
        entry_status: isAlignedWithExecution ? "runtime" : "desync",
        summary: batch,
      })
    }
  }

  const activeRun = runtimeSummary.supervision?.active_run
  if (activeRun) {
    const executionStatus = stageExecutionStatus.get(activeRun.stage_id)
    entries.push({
      kind: "supervision",
      target: activeRun.current_batch_id ?? `stage ${activeRun.stage_id}`,
      stage_id: activeRun.stage_id,
      ...(activeRun.current_batch_id ? { batch_id: activeRun.current_batch_id } : {}),
      ...(executionStatus ? { execution_status: executionStatus } : {}),
      is_mismatched_with_execution:
        executionStatus !== undefined && activeRun.status !== "running" && executionStatus !== "completed",
      summary: activeRun,
    })
  } else if (runtimeSummary.supervision?.current_branch) {
    const branch = runtimeSummary.supervision.current_branch
    const executionStatus = branch.stage_id ? stageExecutionStatus.get(branch.stage_id) : undefined
    entries.push({
      kind: "supervision_branch",
      target: branch.current_batch_id ?? branch.batch_id ?? `stage ${branch.stage_id}`,
      ...(branch.stage_id ? { stage_id: branch.stage_id } : {}),
      ...(branch.current_batch_id ? { batch_id: branch.current_batch_id } : {}),
      ...(executionStatus ? { execution_status: executionStatus } : {}),
      is_mismatched_with_execution:
        executionStatus !== undefined && branch.status !== "running" && executionStatus !== "completed",
      summary: branch,
    })
  }

  return entries
}

function isBatchRuntimeStatusAligned(executionStatus: ExecutionStatus, runtimeStatus: WorkstreamRuntimeBatchSummary["status"]): boolean {
  return (executionStatus === "in_progress" && runtimeStatus === "running") || executionStatus === runtimeStatus
}

export function getRuntimeSummaryProjection(
  stages: Array<{ number: number; items: ParsedExecutionItem[] }>,
  runtimeSummary?: WorkstreamRuntimeSummary,
): WorkstreamStatusRuntimeSummaryProjection | undefined {
  if (!runtimeSummary) {
    return undefined
  }

  return {
    summary: runtimeSummary,
    entries: getRuntimeSummaryEntries(stages, runtimeSummary),
  }
}

export function createWorkstreamStatusSnapshot(args: {
  stream: StreamMetadata
  items: ExecutionItem[]
  hierarchyStages?: StructuredStageRecord[]
  runtimeSummary?: WorkstreamRuntimeSummary
  currentStreamId?: string
}): WorkstreamStatusSnapshot {
  const counts = getExecutionStatusCountsForItems(args.items)
  const stages = buildStageStatusSummaries(args.items, args.hierarchyStages)

  return {
    stream: {
      id: args.stream.id,
      name: args.stream.name,
      order: args.stream.order,
      size: args.stream.size,
      path: args.stream.path,
      created_at: args.stream.created_at,
      updated_at: args.stream.updated_at,
      generated_by: args.stream.generated_by,
      ...(args.stream.status ? { manual_status: args.stream.status } : {}),
      ...(args.stream.current_batch ? { current_batch: args.stream.current_batch } : {}),
      ...(args.stream.files ? { files: args.stream.files } : {}),
      ...(args.stream.planningSession ? { planning_session: args.stream.planningSession } : {}),
      ...(args.stream.github ? { github: args.stream.github } : {}),
      is_current: args.currentStreamId === args.stream.id,
    },
    aggregate_status: computeStreamStatusFromCounts(args.stream, counts),
    counts,
    completion: createCompletionMetrics(counts),
    stages,
    ...(args.runtimeSummary
      ? { runtime: getRuntimeSummaryProjection(stages, args.runtimeSummary) }
      : {}),
  }
}

export function getWorkstreamStatusSnapshot(
  repoRoot: string,
  stream: StreamMetadata,
  currentStreamId?: string,
): WorkstreamStatusSnapshot {
  const hierarchy = loadWorkstreamHierarchyQueryResult(repoRoot, stream.id)
  return createWorkstreamStatusSnapshot({
    stream,
    items: queryExecutionItemsForWorkstream(repoRoot, stream.id),
    hierarchyStages: hierarchy.stages,
    runtimeSummary: queryRuntimeSummaryForWorkstream(repoRoot, stream.id),
    currentStreamId,
  })
}

export function statusSnapshotToStreamProgress(snapshot: WorkstreamStatusSnapshot): StreamProgress {
  return {
    streamId: snapshot.stream.id,
    streamName: snapshot.stream.name,
    size: snapshot.stream.size,
    stages: snapshot.stages.map((stage) => ({
      number: stage.number,
      title: stage.title,
      status: stage.status,
      items: stage.items,
      file: "canonical-execution-state",
    })),
    totalItems: snapshot.counts.total,
    completedItems: snapshot.counts.done,
    inProgressItems: snapshot.counts.in_progress,
    blockedItems: snapshot.counts.blocked,
    pendingItems: snapshot.counts.pending,
    percentComplete: snapshot.completion.percent_done,
    ...(snapshot.runtime ? { runtimeSummary: snapshot.runtime.summary } : {}),
  }
}

/**
 * Get progress for a single workstream
 */
export function getStreamProgress(
  repoRoot: string,
  stream: StreamMetadata
): StreamProgress {
  return statusSnapshotToStreamProgress(getWorkstreamStatusSnapshot(repoRoot, stream))
}

function formatRuntimeExecutionStatus(status: ExecutionStatus): string {
  return status.replace("_", " ")
}

function formatBatchRuntimeLine(entry: Extract<WorkstreamStatusRuntimeEntry, { kind: "batch" }>): string {
  const batch = entry.summary
  const detail = batch.thread_summary.failed > 0
    ? `${batch.thread_summary.failed} failed`
    : batch.thread_summary.running > 0
      ? `${batch.thread_summary.running} running`
      : `${batch.thread_summary.completed} completed`
  return `${entry.entry_status} ${entry.batch_id}: items ${formatRuntimeExecutionStatus(entry.execution_status)}, runtime ${entry.runtime_status} (${detail})`
}

function getRuntimeSummaryLines(progress: StreamProgress): string[] {
  return getRuntimeSummaryEntries(progress.stages, progress.runtimeSummary).map((entry) => {
    switch (entry.kind) {
      case "batch":
        return formatBatchRuntimeLine(entry)
      case "supervision": {
        const mismatch = entry.is_mismatched_with_execution && entry.execution_status
          ? `, items ${formatRuntimeExecutionStatus(entry.execution_status)}`
          : ""
        return `supervision: ${entry.summary.status} on ${entry.target}${mismatch}`
      }
      case "supervision_branch":
        return `supervision branch: ${entry.summary.status} on ${entry.target}`
    }
  })
}

/**
 * Format stream status as a display string with icon
 */
export function formatStreamStatusIcon(status: StreamStatus): string {
  switch (status) {
    case "pending":
      return "[ ] pending"
    case "in_progress":
      return "[~] in progress"
    case "completed":
      return "[x] completed"
    case "on_hold":
      return "[!] on hold"
  }
}

/**
 * Format approval status as icon + label
 */
function formatApprovalIcon(status: ApprovalStatus): string {
  switch (status) {
    case "approved":
      return "✓"
    case "revoked":
      return "⚠"
    case "draft":
    default:
      return "○"
  }
}

/**
 * Format session status as icon
 */
function formatSessionStatusIcon(status: string): string {
  switch (status) {
    case "completed":
      return "✓"
    case "failed":
      return "✗"
    case "running":
      return "▶"
    case "interrupted":
      return "⏸"
    default:
      return "?"
  }
}

/**
 * Format detailed session history for console output
 */
export function formatSessionHistory(
  repoRoot: string,
  streamId: string,
  progress: StreamProgress
): string {
  const items = queryExecutionItemsForWorkstream(repoRoot, streamId)
  const threadMetadata = loadThreads(repoRoot, streamId)?.threads ?? []
  const threadMetadataById = new Map(threadMetadata.map((thread) => [thread.threadId, thread] as const))
  const lines: string[] = []
  const bar = "=".repeat(80)
  
  lines.push(`\n${bar}`)
  lines.push(`SESSION HISTORY: ${streamId}`)
  lines.push(bar)
  
  for (const stage of progress.stages) {
    const stagePrefix = `${stage.number.toString().padStart(2, "0")}.`
    const stageItems = items.filter((item) => item.id.startsWith(stagePrefix))
    
    // Group by thread
    const threadMap = new Map<string, typeof items>()
    for (const item of stageItems) {
      const threadId = item.threadId
      
      if (!threadMap.has(threadId)) {
        threadMap.set(threadId, [])
      }
      threadMap.get(threadId)!.push(item)
    }
    
    // Display each thread's session history
    for (const [threadId, threadItems] of threadMap) {
      const firstItem = threadItems[0]
      if (!firstItem) continue
      
      const allSessions = threadMetadataById.get(threadId)?.sessions ?? []
      if (allSessions.length === 0) continue
      
      lines.push(`\n${stage.title} - ${firstItem.threadName} (${threadId})`)
      lines.push("-".repeat(80))
      
      // Show session details
      for (let i = 0; i < allSessions.length; i++) {
        const session = allSessions[i]!
        const statusIcon = formatSessionStatusIcon(session.status)
        const duration = session.completedAt 
          ? `${Math.round((new Date(session.completedAt).getTime() - new Date(session.startedAt).getTime()) / 60000)}m`
          : "ongoing"
        
        const exitInfo = session.exitCode !== undefined ? ` (exit: ${session.exitCode})` : ""
        
        lines.push(
          `  ${i + 1}. ${statusIcon} ${session.status.padEnd(12)} | ${session.agentName.padEnd(20)} | ${session.model.padEnd(30)} | ${duration}${exitInfo}`
        )
        lines.push(`     Started: ${new Date(session.startedAt).toLocaleString()}`)
        if (session.completedAt) {
          lines.push(`     Ended:   ${new Date(session.completedAt).toLocaleString()}`)
        }
      }
    }
  }
  
  lines.push(`\n${bar}\n`)
  return lines.join("\n")
}

/**
 * Get thread information from items including session data
 */
export interface ThreadInfo {
  threadId: string
  threadName: string
  sessionCount: number
  lastSessionStatus?: string
  hasRunningSession: boolean
  isResumable: boolean
}

/**
 * Extract thread information grouped by thread ID
 */
export function getThreadInfo(items: ParsedExecutionItem[]): Map<string, ThreadInfo> {
  const threadsMap = new Map<string, ThreadInfo>()
  
  // Group items by thread (first 3 parts of ID: stage.batch.thread)
  for (const item of items) {
    const parts = item.id.split(".")
    if (parts.length < 3) continue
    
    const threadId = parts.slice(0, 3).join(".")
    
    if (!threadsMap.has(threadId)) {
      threadsMap.set(threadId, {
        threadId,
        threadName: "(unknown)",
        sessionCount: 0,
        hasRunningSession: false,
        isResumable: false
      })
    }
  }
  
  return threadsMap
}

/**
 * Get thread information with session data from canonical execution items
 */
export function getThreadInfoWithSessions(repoRoot: string, streamId: string, stageNumber: number): Map<string, ThreadInfo> {
  const stageId = stageNumber.toString().padStart(2, "0")
  const threadViews = queryThreadsForWorkstream(repoRoot, streamId).filter((thread) => thread.stageId === stageId)
  const threadMetadata = loadThreads(repoRoot, streamId)?.threads ?? []
  const threadMetadataMap = new Map(threadMetadata.map((thread) => [thread.threadId, thread] as const))
  const threadsMap = new Map<string, ThreadInfo>()
  
  for (const thread of threadViews) {
    const threadId = thread.threadId
    const metadata = threadMetadataMap.get(threadId)
    if (!threadsMap.has(threadId)) {
      threadsMap.set(threadId, {
        threadId,
        threadName: thread.threadName,
        sessionCount: 0,
        hasRunningSession: false,
        isResumable: false
      })
    }
    
    const threadInfo = threadsMap.get(threadId)!
    const sessions = metadata?.sessions ?? []
    if (sessions.length > 0) {
      threadInfo.sessionCount = sessions.length
      const hasRunning = sessions.some(s => s.status === "running")
      if (hasRunning) {
        threadInfo.hasRunningSession = true
      }
      
      if (sessions.length > 0) {
        const lastSession = sessions[sessions.length - 1]
        threadInfo.lastSessionStatus = lastSession!.status
        if ((lastSession!.status === "interrupted" || lastSession!.status === "failed") && 
            thread.aggregateStatus !== "completed") {
          threadInfo.isResumable = true
        }
      }
    }
  }
  
  return threadsMap
}

export function formatStatusSnapshot(
  snapshot: WorkstreamStatusSnapshot,
  stream?: StreamMetadata,
  repoRoot?: string,
): string {
  return formatProgress(
    statusSnapshotToStreamProgress(snapshot),
    snapshot.aggregate_status,
    stream,
    repoRoot,
  )
}

/**
 * Format progress for console output
 */
export function formatProgress(
  progress: StreamProgress,
  streamStatus?: StreamStatus,
  stream?: StreamMetadata,
  repoRoot?: string
): string {
  const lines: string[] = []
  const bar = "-".repeat(50)

  lines.push(`+${bar}+`)
  lines.push(`| ${progress.streamId.padEnd(48)} |`)

  // Show stream status if provided
  if (streamStatus) {
    lines.push(`| Status: ${formatStreamStatusIcon(streamStatus)}`.padEnd(51) + "|")
  }

  lines.push(`+${bar}+`)

  // Progress bar
  const barWidth = 30
  const filled = Math.round((progress.percentComplete / 100) * barWidth)
  const progressBar = "#".repeat(filled) + ".".repeat(barWidth - filled)
  lines.push(
    `| Progress: [${progressBar}] ${progress.percentComplete}%`.padEnd(51) +
    "|"
  )

  // Thread counts
  lines.push(
    `| Threads: ${progress.completedItems}/${progress.totalItems} complete, ${progress.inProgressItems} in-progress, ${progress.blockedItems} blocked`.padEnd(
      51
    ) + "|"
  )

  lines.push(`+${bar}+`)

  const runtimeLines = getRuntimeSummaryLines(progress)
  for (const runtimeLine of runtimeLines) {
    lines.push(`| Runtime: ${runtimeLine}`.padEnd(51) + "|")
  }
  if (runtimeLines.length > 0) {
    lines.push(`+${bar}+`)
  }

  // Stage details with thread-level session info
  for (const stage of progress.stages) {
    const statusIcon =
      stage.status === "complete"
        ? "[x]"
        : stage.status === "in_progress"
          ? "[~]"
          : stage.status === "blocked"
            ? "[!]"
            : "[ ]"

    const stageNumPadded = stage.number.toString().padStart(2, "0")
    const stageTitle = stage.title || `Stage ${stageNumPadded}`
    const itemCount = stage.items?.length || 0
    const completedCount = stage.items?.filter(
      (t) => t.status === "completed"
    ).length || 0

    // Get stage approval status if stream is available
    // Stage approval is independent - it's for approving completed work before moving to next stage
    let approvalDisplay = ""
    if (stream && repoRoot) {
      const stageApproval = queryStageApprovalStatus(repoRoot, stream.id, stage.number, stream)
      approvalDisplay = ` ${formatApprovalIcon(stageApproval)}`
    }

    // Get thread info with sessions if repoRoot is provided
    let sessionSummary = ""
    if (repoRoot && stream) {
      const threadInfoMap = getThreadInfoWithSessions(repoRoot, stream.id, stage.number)
      const threadInfoList = Array.from(threadInfoMap.values())
      
      const totalSessions = threadInfoList.reduce((sum, t) => sum + t.sessionCount, 0)
      const runningCount = threadInfoList.filter(t => t.hasRunningSession).length
      const resumableCount = threadInfoList.filter(t => t.isResumable).length
      
      if (totalSessions > 0) {
        const indicators: string[] = []
        indicators.push(`${totalSessions}s`)
        if (runningCount > 0) indicators.push(`${runningCount}▶`)
        if (resumableCount > 0) indicators.push(`${resumableCount}⟲`)
        sessionSummary = ` [${indicators.join(" ")}]`
      }
    }

    lines.push(
      `| ${statusIcon} Stage ${stageNumPadded}: ${stageTitle} (${completedCount}/${itemCount})${sessionSummary}${approvalDisplay}`.padEnd(
        51
      ) + "|"
    )
  }

  lines.push(`+${bar}+`)

  return lines.join("\n")
}
