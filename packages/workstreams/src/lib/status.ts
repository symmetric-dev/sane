/**
 * Workstream status and progress tracking
 *
 * Reads task status from tasks.json
 */

import type {
  StreamMetadata,
  StreamProgress,
  StreamStatus,
  Task,
  StageStatus,
  ParsedTask,
  ApprovalStatus,
  TaskStatus,
  WorkstreamRuntimeSummary,
  TaskStatusCounts,
  WorkstreamStatusCompletionMetrics,
  WorkstreamStatusRuntimeEntry,
  WorkstreamStatusRuntimeSummaryProjection,
  WorkstreamStatusSnapshot,
  WorkstreamStatusStageSummary,
} from "./types.ts"
import { getEffectiveRuntimeSummary, getTasks, getTaskCounts, readTasksFile } from "./tasks.ts"
import { getStageApprovalStatus } from "./approval.ts"

// Re-export ParsedStage for backwards compatibility during migration
export interface ParsedStage {
  number: number
  title: string
  status: StageStatus
  taskCount: number
  completedCount: number
}

function getTaskStatusCountsForTasks(tasks: Array<{ status: TaskStatus }>): TaskStatusCounts {
  const counts: TaskStatusCounts = {
    total: tasks.length,
    pending: 0,
    in_progress: 0,
    completed: 0,
    blocked: 0,
    cancelled: 0,
    done: 0,
  }

  for (const task of tasks) {
    counts[task.status] += 1
  }

  counts.done = counts.completed + counts.cancelled
  return counts
}

function createCompletionMetrics(counts: TaskStatusCounts): WorkstreamStatusCompletionMetrics {
  return {
    total_tasks: counts.total,
    completed_tasks: counts.completed,
    cancelled_tasks: counts.cancelled,
    done_tasks: counts.done,
    remaining_tasks: counts.total - counts.done,
    percent_complete: counts.total > 0 ? Math.round((counts.completed / counts.total) * 100) : 0,
    percent_done: counts.total > 0 ? Math.round((counts.done / counts.total) * 100) : 0,
  }
}

export function computeStreamStatusFromCounts(
  stream: Pick<StreamMetadata, "status">,
  counts: Pick<TaskStatusCounts, "total" | "completed" | "cancelled" | "in_progress">,
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
 * Compute the stream status based on task states
 * - If stream has manually set status `on_hold`, use that
 * - If all tasks are completed (or cancelled), status is `completed`
 * - If any task is in_progress, status is `in_progress`
 * - Otherwise, status is `pending`
 */
export function computeStreamStatus(
  repoRoot: string,
  stream: StreamMetadata
): StreamStatus {
  return computeStreamStatusFromCounts(stream, getTaskCounts(repoRoot, stream.id))
}

/**
 * Get the effective stream status (computed or from metadata)
 */
export function getStreamStatus(repoRoot: string, stream: StreamMetadata): StreamStatus {
  return computeStreamStatus(repoRoot, stream)
}

/**
 * Calculate stage status from task statuses
 */
export function calculateStageStatus(tasks: Array<{ status: TaskStatus }>): StageStatus {
  if (tasks.length === 0) return "pending"

  const done = tasks.filter((t) => t.status === "completed" || t.status === "cancelled").length
  const inProgress = tasks.filter((t) => t.status === "in_progress").length
  const blocked = tasks.filter((t) => t.status === "blocked").length

  if (done === tasks.length) return "complete"
  if (blocked > 0 && inProgress === 0 && done === 0) return "blocked"
  if (inProgress > 0 || done > 0) return "in_progress"
  return "pending"
}

function parseTaskIdParts(taskId: string): {
  stageNumber: number
  stageId: string
  batchId?: string
  threadNumber: number
  taskNumber: number
} | null {
  const parts = taskId.split(".")
  const stageNumber = parseInt(parts[0]!, 10)
  if (isNaN(stageNumber)) {
    return null
  }

  return {
    stageNumber,
    stageId: stageNumber.toString().padStart(2, "0"),
    ...(parts.length >= 2 ? { batchId: `${parts[0]}.${parts[1]}` } : {}),
    threadNumber: parseInt(parts[1] || "1", 10),
    taskNumber: parseInt(parts[2] || "1", 10),
  }
}

function toParsedTask(task: Task): ParsedTask | null {
  const parts = parseTaskIdParts(task.id)
  if (!parts) {
    return null
  }

  return {
    id: task.id,
    description: task.name,
    status: task.status,
    stageNumber: parts.stageNumber,
    taskGroupNumber: parts.threadNumber,
    subtaskNumber: parts.taskNumber,
    lineNumber: 0,
  }
}

export function buildStageStatusSummaries(tasks: Task[]): WorkstreamStatusStageSummary[] {
  const stageTasks = new Map<number, Task[]>()

  for (const task of tasks) {
    const parts = parseTaskIdParts(task.id)
    if (!parts) {
      continue
    }

    if (!stageTasks.has(parts.stageNumber)) {
      stageTasks.set(parts.stageNumber, [])
    }
    stageTasks.get(parts.stageNumber)!.push(task)
  }

  return Array.from(stageTasks.entries())
    .sort(([a], [b]) => a - b)
    .map(([stageNumber, stageTaskList]) => {
      const counts = getTaskStatusCountsForTasks(stageTaskList)
      const parsedTasks = stageTaskList
        .map((task) => toParsedTask(task))
        .filter((task): task is ParsedTask => task !== null)

      return {
        number: stageNumber,
        stage_id: stageNumber.toString().padStart(2, "0"),
        title: stageTaskList[0]?.stage_name || `Stage ${stageNumber}`,
        status: calculateStageStatus(stageTaskList),
        counts,
        completion: createCompletionMetrics(counts),
        tasks: parsedTasks,
      }
    })
}

export function aggregateTaskStatus(tasks: Array<{ status: TaskStatus }>): TaskStatus {
  if (tasks.length === 0) return "pending"
  if (tasks.some((task) => task.status === "blocked")) return "blocked"
  if (tasks.some((task) => task.status === "in_progress")) return "in_progress"
  if (tasks.some((task) => task.status === "pending")) return "pending"
  return "completed"
}

export function getRuntimeSummaryEntries(
  stages: Array<{ number: number; tasks: ParsedTask[] }>,
  runtimeSummary?: WorkstreamRuntimeSummary,
): WorkstreamStatusRuntimeEntry[] {
  if (!runtimeSummary) {
    return []
  }

  const entries: WorkstreamStatusRuntimeEntry[] = []
  const stageTaskStatus = new Map<string, TaskStatus>()
  const batchTaskStatus = new Map<string, TaskStatus>()

  for (const stage of stages) {
    const stageId = stage.number.toString().padStart(2, "0")
    stageTaskStatus.set(stageId, aggregateTaskStatus(stage.tasks))

    const stageBatches = new Map<string, ParsedTask[]>()
    for (const task of stage.tasks) {
      const parts = task.id.split(".")
      if (parts.length < 2) continue
      const batchId = `${parts[0]}.${parts[1]}`
      if (!stageBatches.has(batchId)) {
        stageBatches.set(batchId, [])
      }
      stageBatches.get(batchId)!.push(task)
    }

    for (const [batchId, tasksForBatch] of stageBatches) {
      batchTaskStatus.set(batchId, aggregateTaskStatus(tasksForBatch))
    }
  }

  for (const batchId of Object.keys(runtimeSummary.batches).sort()) {
    const batch = runtimeSummary.batches[batchId]!
    const taskStatus = batchTaskStatus.get(batchId)
    const isRuntimeActive = ["running", "failed"].includes(batch.status)
    if (!taskStatus) continue
    if (batch.status !== taskStatus || isRuntimeActive) {
      entries.push({
        kind: "batch",
        batch_id: batchId,
        task_status: taskStatus,
        runtime_status: batch.status,
        entry_status: batch.status !== taskStatus ? "desync" : "runtime",
        summary: batch,
      })
    }
  }

  const activeRun = runtimeSummary.supervision?.active_run
  if (activeRun) {
    const taskStatus = stageTaskStatus.get(activeRun.stage_id)
    entries.push({
      kind: "supervision",
      target: activeRun.current_batch_id ?? `stage ${activeRun.stage_id}`,
      stage_id: activeRun.stage_id,
      ...(activeRun.current_batch_id ? { batch_id: activeRun.current_batch_id } : {}),
      ...(taskStatus ? { task_status: taskStatus } : {}),
      is_mismatched_with_tasks:
        taskStatus !== undefined && activeRun.status !== "running" && taskStatus !== "completed",
      summary: activeRun,
    })
  } else if (runtimeSummary.supervision?.current_branch) {
    const branch = runtimeSummary.supervision.current_branch
    const taskStatus = branch.stage_id ? stageTaskStatus.get(branch.stage_id) : undefined
    entries.push({
      kind: "supervision_branch",
      target: branch.current_batch_id ?? branch.batch_id ?? `stage ${branch.stage_id}`,
      ...(branch.stage_id ? { stage_id: branch.stage_id } : {}),
      ...(branch.current_batch_id ? { batch_id: branch.current_batch_id } : {}),
      ...(taskStatus ? { task_status: taskStatus } : {}),
      is_mismatched_with_tasks:
        taskStatus !== undefined && branch.status !== "running" && taskStatus !== "completed",
      summary: branch,
    })
  }

  return entries
}

export function getRuntimeSummaryProjection(
  stages: Array<{ number: number; tasks: ParsedTask[] }>,
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
  tasks: Task[]
  runtimeSummary?: WorkstreamRuntimeSummary
  currentStreamId?: string
}): WorkstreamStatusSnapshot {
  const counts = getTaskStatusCountsForTasks(args.tasks)
  const stages = buildStageStatusSummaries(args.tasks)

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
  const tasksFile = readTasksFile(repoRoot, stream.id)
  return createWorkstreamStatusSnapshot({
    stream,
    tasks: tasksFile?.tasks ?? [],
    runtimeSummary: getEffectiveRuntimeSummary(repoRoot, stream.id, tasksFile),
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
      tasks: stage.tasks,
      file: "tasks.json",
    })),
    totalTasks: snapshot.counts.total,
    completedTasks: snapshot.counts.done,
    inProgressTasks: snapshot.counts.in_progress,
    blockedTasks: snapshot.counts.blocked,
    pendingTasks: snapshot.counts.pending,
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

function formatRuntimeTaskStatus(status: TaskStatus): string {
  return status.replace("_", " ")
}

function formatBatchRuntimeLine(entry: Extract<WorkstreamStatusRuntimeEntry, { kind: "batch" }>): string {
  const batch = entry.summary
  const detail = batch.thread_summary.failed > 0
    ? `${batch.thread_summary.failed} failed`
    : batch.thread_summary.running > 0
      ? `${batch.thread_summary.running} running`
      : `${batch.thread_summary.completed} completed`
  return `${entry.entry_status} ${entry.batch_id}: tasks ${formatRuntimeTaskStatus(entry.task_status)}, runtime ${entry.runtime_status} (${detail})`
}

function getRuntimeSummaryLines(progress: StreamProgress): string[] {
  return getRuntimeSummaryEntries(progress.stages, progress.runtimeSummary).map((entry) => {
    switch (entry.kind) {
      case "batch":
        return formatBatchRuntimeLine(entry)
      case "supervision": {
        const mismatch = entry.is_mismatched_with_tasks && entry.task_status
          ? `, tasks ${formatRuntimeTaskStatus(entry.task_status)}`
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
  const tasks = getTasks(repoRoot, streamId)
  const lines: string[] = []
  const bar = "=".repeat(80)
  
  lines.push(`\n${bar}`)
  lines.push(`SESSION HISTORY: ${streamId}`)
  lines.push(bar)
  
  for (const stage of progress.stages) {
    const stagePrefix = `${stage.number.toString().padStart(2, "0")}.`
    const stageTasks = tasks.filter(t => t.id.startsWith(stagePrefix))
    
    // Group by thread
    const threadMap = new Map<string, typeof tasks>()
    for (const task of stageTasks) {
      const parts = task.id.split(".")
      if (parts.length < 3) continue
      const threadId = parts.slice(0, 3).join(".")
      
      if (!threadMap.has(threadId)) {
        threadMap.set(threadId, [])
      }
      threadMap.get(threadId)!.push(task)
    }
    
    // Display each thread's session history
    for (const [threadId, threadTasks] of threadMap) {
      const firstTask = threadTasks[0]
      if (!firstTask) continue
      
      // Count total sessions across all tasks in thread
      const allSessions = threadTasks.flatMap(t => t.sessions || [])
      if (allSessions.length === 0) continue
      
      lines.push(`\n${stage.title} - ${firstTask.thread_name} (${threadId})`)
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
 * Get thread information from tasks including session data
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
export function getThreadInfo(tasks: ParsedTask[]): Map<string, ThreadInfo> {
  const threadsMap = new Map<string, ThreadInfo>()
  
  // Group tasks by thread (first 3 parts of ID: stage.batch.thread)
  for (const task of tasks) {
    const parts = task.id.split(".")
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
 * Get thread information with session data from full Task objects
 */
export function getThreadInfoWithSessions(repoRoot: string, streamId: string, stageNumber: number): Map<string, ThreadInfo> {
  const tasks = getTasks(repoRoot, streamId)
  const stagePrefix = `${stageNumber.toString().padStart(2, "0")}.`
  const stageTasks = tasks.filter(t => t.id.startsWith(stagePrefix))
  
  const threadsMap = new Map<string, ThreadInfo>()
  
  for (const task of stageTasks) {
    const parts = task.id.split(".")
    if (parts.length < 3) continue
    
    const threadId = parts.slice(0, 3).join(".")
    
    if (!threadsMap.has(threadId)) {
      threadsMap.set(threadId, {
        threadId,
        threadName: task.thread_name,
        sessionCount: 0,
        hasRunningSession: false,
        isResumable: false
      })
    }
    
    const threadInfo = threadsMap.get(threadId)!
    
    // Count sessions
    if (task.sessions) {
      threadInfo.sessionCount += task.sessions.length
      
      // Check for running sessions
      const hasRunning = task.sessions.some(s => s.status === "running")
      if (hasRunning) {
        threadInfo.hasRunningSession = true
      }
      
      // Check last session status
      if (task.sessions.length > 0) {
        const lastSession = task.sessions[task.sessions.length - 1]
        threadInfo.lastSessionStatus = lastSession!.status
        
        // Thread is resumable if last session was interrupted or failed and not all tasks are complete
        if ((lastSession!.status === "interrupted" || lastSession!.status === "failed") && 
            task.status !== "completed") {
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

  // Task counts
  lines.push(
    `| Tasks: ${progress.completedTasks}/${progress.totalTasks} complete, ${progress.inProgressTasks} in-progress, ${progress.blockedTasks} blocked`.padEnd(
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
    const taskCount = stage.tasks?.length || 0
    const completedCount = stage.tasks?.filter(
      (t) => t.status === "completed"
    ).length || 0

    // Get stage approval status if stream is available
    // Stage approval is independent - it's for approving completed work before moving to next stage
    let approvalDisplay = ""
    if (stream) {
      const stageApproval = getStageApprovalStatus(stream, stage.number)
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
      `| ${statusIcon} Stage ${stageNumPadded}: ${stageTitle} (${completedCount}/${taskCount})${sessionSummary}${approvalDisplay}`.padEnd(
        51
      ) + "|"
    )
  }

  lines.push(`+${bar}+`)

  return lines.join("\n")
}
